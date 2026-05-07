#!/usr/bin/env python3
"""Serve a small dashboard for inspecting MBO Parquet events."""

from __future__ import annotations

import argparse
import glob
import json
import mimetypes
import re
import socket
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import polars as pl


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


class DashboardData:
    def __init__(self, dataset: str, symbol: str | None = DEFAULT_SYMBOL) -> None:
        self.dataset = dataset
        self.symbol = symbol
        self._orderbooks: list[dict] | None = None
        self._replay_dates: list[dict] | None = None
        self._replay_summaries: dict[str, dict] = {}
        self._schema: set[str] | None = None

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

    def replay_summary(self, session_date: date | None = None) -> dict:
        cache_key = session_date.isoformat() if session_date else "__all__"
        if cache_key not in self._replay_summaries:
            frame = (
                self.scan(session_date)
                .select(
                    pl.len().alias("events"),
                    pl.col("ts_event").min().alias("first_ts_event"),
                    pl.col("ts_event").max().alias("last_ts_event"),
                )
                .collect()
            )
            summary = frame_to_records(frame)[0]
            summary["total"] = summary.pop("events")
            summary["date"] = session_date.isoformat() if session_date else None
            self._replay_summaries[cache_key] = summary
        return self._replay_summaries[cache_key]

    def replay_events(
        self,
        offset: int = 0,
        limit: int = 500,
        session_date: str | None = None,
    ) -> dict:
        offset = max(0, offset)
        limit = max(1, min(limit, REPLAY_CHUNK_LIMIT))
        parsed_date = parse_session_date(session_date)
        summary = self.replay_summary(parsed_date)
        total = summary["total"]

        if total == 0:
            return {
                "offset": offset,
                "limit": limit,
                **summary,
                "events": [],
            }

        frame = (
            self.scan(parsed_date)
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
                    self.respond_json(
                        data.replay_events(
                            offset=offset,
                            limit=limit,
                            session_date=session_date,
                        )
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
