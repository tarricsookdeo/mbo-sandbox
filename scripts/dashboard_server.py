#!/usr/bin/env python3
"""Serve a small dashboard for inspecting MBO Parquet events."""

from __future__ import annotations

import argparse
import glob
import json
import mimetypes
import re
import socket
import sys
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import polars as pl

# Make the in-repo `engine` package importable when running this script directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.config import INSTRUMENTS, TZ_ET as ENGINE_TZ_ET  # noqa: E402
from engine.replay_runner import run_from_parquet, trades_as_records  # noqa: E402


PRICE_SCALE = 1_000_000_000
UNDEF_PRICE = 9_223_372_036_854_775_807
DEFAULT_DATASET = "data/parquet/mbo/date=*/mbo.parquet"
DEFAULT_SYMBOL = "ESM6"
DISPLAY_TIME_ZONE = ZoneInfo("America/New_York")
EVENT_COLUMNS = [
    "ts_event",
    "ts_recv",
    "instrument_id",
    "symbol",
    "action",
    "side",
    "price",
    "size",
    "order_id",
    "flags",
    "sequence",
    "publisher_id",
    "channel_id",
]
REPLAY_CHUNK_LIMIT = 10_000
DATE_PARTITION_RE = re.compile(r"(?:^|[\\/])date=(\d{4}-\d{2}-\d{2})(?:[\\/]|$)")

# RTH window: 09:30 ET inclusive to 16:00 ET exclusive.
from datetime import time as _time  # noqa: E402

RTH_OPEN_TIME = _time(9, 30)
RTH_CLOSE_TIME = _time(16, 0)


def _rth_filter_expr(target_et_date: date | None = None) -> pl.Expr:
    # NOTE: comparing on `.dt.time()` rather than `hour*60+minute` because
    # `dt.hour()` returns i8 and `hour*60` overflows for any hour >= 3.
    ts_et = pl.col("ts_event").dt.convert_time_zone("America/New_York")
    ts_et_time = ts_et.dt.time()
    expr = (ts_et_time >= RTH_OPEN_TIME) & (ts_et_time < RTH_CLOSE_TIME)
    if target_et_date is not None:
        # Each Parquet partition can carry pre-market spillover from the prior
        # calendar day (Globex session begins ~18:00 ET the day before). When
        # the caller specifies a date alongside rth_only, restrict to events
        # whose ET wall-clock date matches that day.
        expr = expr & (ts_et.dt.date() == target_et_date)
    return expr


DEFAULT_STRATEGY_INSTRUMENT = "MES"


class DashboardData:
    def __init__(self, dataset: str, symbol: str | None = DEFAULT_SYMBOL) -> None:
        self.dataset = dataset
        self.symbol = symbol
        self._orderbooks: list[dict] | None = None
        self._replay_dates: list[dict] | None = None
        self._replay_summaries: dict[str, dict] = {}
        self._schema: set[str] | None = None
        self._strategy_cache: dict[str, dict] = {}
        self._rth_ts_cache: dict[str, pl.Series] = {}

    def _rth_event_timestamps(self, session_date: str) -> pl.Series:
        """Return ts_event values for all RTH events on the given session
        date as a sorted Polars Series (UTC). Cached per date."""
        if session_date not in self._rth_ts_cache:
            parsed = parse_session_date(session_date)
            frame = self.scan(parsed)
            frame = frame.filter(_rth_filter_expr(parsed))
            series = frame.select(pl.col("ts_event")).collect().get_column("ts_event")
            self._rth_ts_cache[session_date] = series
        return self._rth_ts_cache[session_date]

    def scan(self, session_date: date | None = None) -> pl.LazyFrame:
        frame = pl.scan_parquet(self.dataset, hive_partitioning=True)
        if self.symbol:
            frame = frame.filter(pl.col("symbol") == self.symbol)
        if session_date and "date" in self.schema():
            frame = frame.filter(pl.col("date") == session_date)
        return frame

    def schema(self) -> set[str]:
        if self._schema is None:
            self._schema = set(
                pl.scan_parquet(self.dataset, hive_partitioning=True).collect_schema()
            )
        return self._schema

    def orderbooks(self) -> list[dict]:
        if self._orderbooks is None:
            frame = (
                self.scan()
                .group_by("instrument_id", "symbol")
                .agg(
                    pl.len().alias("events"),
                    pl.col("ts_event").min().alias("first_ts_event"),
                    pl.col("ts_event").max().alias("last_ts_event"),
                )
                .sort(["events", "symbol"], descending=[True, False])
                .collect()
            )
            self._orderbooks = frame_to_records(frame)
        return self._orderbooks

    def replay_dates(self) -> list[dict]:
        if self._replay_dates is None:
            partition_dates = dates_from_dataset_paths(self.dataset)
            if partition_dates:
                self._replay_dates = [{"date": value} for value in partition_dates]
            elif "date" not in self.schema():
                self._replay_dates = []
            else:
                frame = (
                    self.scan()
                    .group_by("date")
                    .agg(
                        pl.len().alias("events"),
                        pl.col("ts_event").min().alias("first_ts_event"),
                        pl.col("ts_event").max().alias("last_ts_event"),
                    )
                    .sort("date")
                    .collect()
                )
                self._replay_dates = frame_to_records(frame)
        return self._replay_dates

    def events(self, instrument_id: int, limit: int = 200) -> dict:
        limit = max(1, min(limit, 1000))
        orderbook_ids = {book["instrument_id"] for book in self.orderbooks()}
        if instrument_id not in orderbook_ids:
            return {
                "instrument_id": instrument_id,
                "first": [],
                "last": [],
            }

        base = (
            self.scan()
            .filter(pl.col("instrument_id") == instrument_id)
            .select([col for col in EVENT_COLUMNS if col in self.schema()])
            .with_columns(
                pl.when(pl.col("price") == UNDEF_PRICE)
                .then(None)
                .otherwise(pl.col("price") / PRICE_SCALE)
                .alias("price_display")
            )
        )

        first = base.head(limit).collect()
        last = base.tail(limit).collect()
        return {
            "instrument_id": instrument_id,
            "first": frame_to_records(first),
            "last": frame_to_records(last),
        }

    def replay_summary(
        self,
        session_date: date | None = None,
        rth_only: bool = False,
    ) -> dict:
        base_key = session_date.isoformat() if session_date else "__all__"
        cache_key = f"{base_key}|rth={rth_only}"
        if cache_key not in self._replay_summaries:
            frame = self.scan(session_date)
            if rth_only:
                frame = frame.filter(_rth_filter_expr(session_date))
            frame = (
                frame.select(
                    pl.len().alias("events"),
                    pl.col("ts_event").min().alias("first_ts_event"),
                    pl.col("ts_event").max().alias("last_ts_event"),
                )
                .collect()
            )
            summary = frame_to_records(frame)[0]
            summary["total"] = summary.pop("events")
            summary["date"] = session_date.isoformat() if session_date else None
            summary["rth_only"] = rth_only
            self._replay_summaries[cache_key] = summary
        return self._replay_summaries[cache_key]

    def replay_events(
        self,
        offset: int = 0,
        limit: int = 500,
        session_date: str | None = None,
        rth_only: bool = False,
    ) -> dict:
        offset = max(0, offset)
        limit = max(1, min(limit, REPLAY_CHUNK_LIMIT))
        parsed_date = parse_session_date(session_date)
        summary = self.replay_summary(parsed_date, rth_only=rth_only)
        total = summary["total"]

        if total == 0:
            return {
                "offset": offset,
                "limit": limit,
                **summary,
                "events": [],
            }

        frame = self.scan(parsed_date)
        if rth_only:
            frame = frame.filter(_rth_filter_expr(parsed_date))
        # NOTE: with_row_index must come after any filtering so row numbers
        # match the offset/total semantics the frontend expects.
        frame = (
            frame
            .select([col for col in EVENT_COLUMNS if col in self.schema()])
            .with_row_index("row", offset=0)
            .slice(offset, limit)
            .with_columns(
                pl.when(pl.col("price") == UNDEF_PRICE)
                .then(None)
                .otherwise(pl.col("price") / PRICE_SCALE)
                .alias("price_display")
            )
            .collect()
        )
        return {
            "offset": offset,
            "limit": limit,
            **summary,
            "events": frame_to_records(frame),
        }

    def strategy_session(
        self,
        session_date: str,
        instrument_symbol: str = DEFAULT_STRATEGY_INSTRUMENT,
    ) -> dict:
        if instrument_symbol not in INSTRUMENTS:
            raise ValueError(
                f"unknown instrument {instrument_symbol!r}; "
                f"expected one of {sorted(INSTRUMENTS)}"
            )
        # Validate the date is available before doing any heavy work.
        available = [entry["date"] for entry in self.replay_dates()]
        if session_date not in available:
            raise ValueError(f"date {session_date!r} not in dataset")

        cache_key = f"{session_date}|{instrument_symbol}|{self.symbol}"
        if cache_key in self._strategy_cache:
            return self._strategy_cache[cache_key]

        # Include prior dates as indicator warmup; the engine handles session
        # boundaries internally. ATR/RSI need ~14 5m bars; including prior
        # sessions also primes prev_buff for the target session.
        idx = available.index(session_date)
        run_dates = available[: idx + 1]
        instrument = INSTRUMENTS[instrument_symbol]
        runner = run_from_parquet(
            self.dataset, self.symbol, run_dates, instrument,
        )

        bars = [
            snapshot for snapshot in runner.bar_snapshots
            if snapshot["bar_start"].startswith(session_date)
        ]
        timeline = [
            _strategy_event_to_json(event) for event in runner.timeline
            if _event_date_matches(event, session_date)
        ]
        trades = [
            trade for trade in trades_as_records(runner)
            if trade["entry_ts"].startswith(session_date)
        ]
        summary = _summarize_trades(trades)

        # Annotate each bar with the offset of the first RTH event whose
        # ts_event >= bar.end_ts. This lets the dashboard jump directly to a
        # bar close instead of walking hundreds of thousands of events.
        _attach_bar_event_offsets(bars, self._rth_event_timestamps(session_date))
        # Same for fills/exits — the frontend can offer "jump to next fill".
        _attach_timeline_event_offsets(timeline,
                                       self._rth_event_timestamps(session_date))

        result = {
            "date": session_date,
            "instrument": instrument_symbol,
            "symbol": self.symbol,
            "bars": bars,
            "timeline": timeline,
            "trades": trades,
            "summary": summary,
        }
        self._strategy_cache[cache_key] = result
        return result


def _strategy_event_to_json(event: dict) -> dict:
    out: dict = {}
    for key, value in event.items():
        if isinstance(value, datetime):
            out[key] = value.astimezone(ENGINE_TZ_ET).isoformat()
        else:
            out[key] = value
    return out


def _attach_bar_event_offsets(bars: list[dict], rth_ts: pl.Series) -> None:
    for snap in bars:
        bar_end = datetime.fromisoformat(snap["bar_end"])
        snap["event_offset"] = int(rth_ts.search_sorted(bar_end, side="left"))


def _attach_timeline_event_offsets(timeline: list[dict], rth_ts: pl.Series) -> None:
    for entry in timeline:
        ts = entry.get("ts")
        if not isinstance(ts, str):
            continue
        try:
            ts_dt = datetime.fromisoformat(ts)
        except ValueError:
            continue
        entry["event_offset"] = int(rth_ts.search_sorted(ts_dt, side="left"))


def _event_date_matches(event: dict, session_date: str) -> bool:
    ts = event.get("ts")
    if not isinstance(ts, datetime):
        return False
    return ts.astimezone(ENGINE_TZ_ET).date().isoformat() == session_date


def _summarize_trades(trades: list[dict]) -> dict:
    total = sum(trade["pnl_usd"] for trade in trades)
    wins = sum(1 for trade in trades if trade["pnl_usd"] > 0)
    losses = sum(1 for trade in trades if trade["pnl_usd"] < 0)
    return {
        "trade_count": len(trades),
        "wins": wins,
        "losses": losses,
        "total_pnl_usd": total,
    }


def parse_session_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"Invalid replay date: {value}") from exc


def dates_from_dataset_paths(dataset: str) -> list[str]:
    dates = set()
    for path in glob.glob(dataset):
        match = DATE_PARTITION_RE.search(path)
        if match:
            dates.add(match.group(1))
    return sorted(dates)


def frame_to_records(frame: pl.DataFrame) -> list[dict]:
    records = []
    for row in frame.to_dicts():
        records.append({key: encode_value(value) for key, value in row.items()})
    return records


def encode_value(value):
    if isinstance(value, datetime):
        return value.astimezone(DISPLAY_TIME_ZONE).isoformat()
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def create_handler(data: DashboardData, static_dir: Path):
    class Handler(BaseHTTPRequestHandler):
        def do_HEAD(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path.startswith("/api/"):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                return
            self.respond_static(parsed.path, head_only=True)

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/api/orderbooks":
                self.respond_json({"orderbooks": data.orderbooks()})
                return
            if parsed.path == "/api/replay-dates":
                self.respond_json({"dates": data.replay_dates()})
                return
            if parsed.path == "/api/events":
                query = parse_qs(parsed.query)
                try:
                    instrument_id = int(query.get("instrument_id", [""])[0])
                except ValueError:
                    self.respond_json({"error": "instrument_id is required"}, status=400)
                    return
                limit = int(query.get("limit", ["200"])[0])
                self.respond_json(data.events(instrument_id, limit=limit))
                return
            if parsed.path == "/api/replay":
                query = parse_qs(parsed.query)
                try:
                    offset = int(query.get("offset", ["0"])[0])
                    limit = int(query.get("limit", ["500"])[0])
                    session_date = query.get("date", [None])[0]
                    rth_only = query.get("rth_only", ["false"])[0].lower() == "true"
                    self.respond_json(
                        data.replay_events(
                            offset=offset,
                            limit=limit,
                            session_date=session_date,
                            rth_only=rth_only,
                        )
                    )
                except ValueError as exc:
                    self.respond_json({"error": str(exc)}, status=400)
                return
            if parsed.path == "/api/strategy-session":
                query = parse_qs(parsed.query)
                session_date = query.get("date", [""])[0]
                if not session_date:
                    self.respond_json(
                        {"error": "date is required"}, status=400,
                    )
                    return
                instrument = query.get("instrument", [DEFAULT_STRATEGY_INSTRUMENT])[0]
                try:
                    self.respond_json(
                        data.strategy_session(session_date, instrument),
                    )
                except ValueError as exc:
                    self.respond_json({"error": str(exc)}, status=400)
                return
            self.respond_static(parsed.path)

        def respond_static(self, request_path: str, head_only: bool = False) -> None:
            relative = "index.html" if request_path in ("", "/") else request_path.lstrip("/")
            path = (static_dir / relative).resolve()
            if static_dir.resolve() not in path.parents and path != static_dir.resolve():
                self.send_error(403)
                return
            if not path.exists() or not path.is_file():
                self.send_error(404)
                return

            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def respond_json(self, payload: dict, status: int = 200) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args) -> None:
            print(f"{self.address_string()} - {fmt % args}")

    return Handler


def local_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the local MBO dashboard.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument(
        "--symbol",
        default=DEFAULT_SYMBOL,
        help="Only show this symbol. Pass an empty string to show all symbols.",
    )
    parser.add_argument("--static-dir", type=Path, default=Path("dashboard"))
    args = parser.parse_args()
    symbol = args.symbol or None

    server = ThreadingHTTPServer(
        (args.host, args.port),
        create_handler(DashboardData(args.dataset, symbol=symbol), args.static_dir),
    )
    print(f"Dashboard: http://127.0.0.1:{args.port}")
    ip = local_ip()
    if ip:
        print(f"WSL/LAN:   http://{ip}:{args.port}")
    print(f"Dataset: {args.dataset}")
    print(f"Symbol:  {symbol or 'all'}")
    server.serve_forever()


if __name__ == "__main__":
    main()
