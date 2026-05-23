from __future__ import annotations

from dataclasses import asdict
from datetime import date, datetime
from typing import Iterable

import polars as pl

from .bars import Bar, BarAggregator
from .config import (
    InstrumentSpec,
    PRICE_SCALE,
    RTH_CLOSE,
    RTH_OPEN,
    TZ_ET,
)
from .indicators import Indicators
from .strategy import Strategy


class ReplayRunner:
    """Orchestrates the engine over a stream of MBO trade events.

    Workflow per event:
      1. Detect RTH membership and session-boundary crossings
      2. On session boundary: flush any in-progress bar, reset indicators+strategy
      3. Feed trade to bar aggregator; for each closed bar:
           a. update indicators
           b. call strategy.on_bar_close → collect events
           c. snapshot per-bar indicator + position state for replay UI
      4. Call strategy.on_trade for intra-bar stop/target/breakeven/MTM
    """

    def __init__(self, instrument: InstrumentSpec) -> None:
        self.instrument = instrument
        self.indicators = Indicators()
        self.strategy = Strategy(instrument, self.indicators)
        self.bars = BarAggregator()
        self.closed_bars: list[Bar] = []
        self.bar_snapshots: list[dict] = []
        self.timeline: list[dict] = []
        self._last_rth_date: date | None = None

    @staticmethod
    def _in_rth(ts: datetime) -> bool:
        return RTH_OPEN <= ts.time() < RTH_CLOSE

    def feed_trade(self, ts_utc: datetime, price: float, size: int) -> None:
        ts_et = ts_utc.astimezone(TZ_ET)
        if not self._in_rth(ts_et):
            return
        date_et = ts_et.date()

        if self._last_rth_date is None:
            self._last_rth_date = date_et
        elif date_et != self._last_rth_date:
            self._handle_session_boundary()
            self._last_rth_date = date_et

        closed = self.bars.on_trade(ts_utc, price, size)
        for bar in closed:
            self._process_closed_bar(bar)

        events = self.strategy.on_trade(ts_utc, price)
        if events:
            self.timeline.extend(events)

    def finalize(self) -> None:
        """Flush any in-progress bar at the end of the stream."""
        bar = self.bars.force_close()
        if bar is not None:
            self._process_closed_bar(bar)

    # ----- internals -----

    def _handle_session_boundary(self) -> None:
        stale = self.bars.force_close()
        if stale is not None:
            self._process_closed_bar(stale)
        self.indicators.on_session_reset()
        self.strategy.on_session_reset()

    def _process_closed_bar(self, bar: Bar) -> None:
        self.closed_bars.append(bar)
        self.indicators.on_bar_close(bar)
        events = self.strategy.on_bar_close(bar)
        if events:
            self.timeline.extend(events)
        self.bar_snapshots.append(self._snapshot(bar))

    def _snapshot(self, bar: Bar) -> dict:
        s = self.indicators.state
        pos = self.strategy.position
        return {
            "bar_start": bar.start_ts.astimezone(TZ_ET).isoformat(),
            "bar_end": bar.end_ts.astimezone(TZ_ET).isoformat(),
            "open": bar.open, "high": bar.high,
            "low": bar.low, "close": bar.close,
            "volume": bar.volume, "trade_count": bar.trade_count,
            "buff": s.buff, "prev_buff": s.prev_buff,
            "atr": s.atr, "rsi": s.rsi, "dir": s.dir,
            "in_position": pos is not None,
            "position_side": pos.side.name if pos else None,
            "position_entry": pos.entry_price if pos else None,
            "position_stop": pos.current_stop if pos else None,
            "position_target": pos.target if pos else None,
            "daily_pnl_usd": self.strategy.session.daily_pnl_usd,
            "trades_taken": self.strategy.session.trades_taken,
            "halted": self.strategy.session.halted,
            "skip_first_trade": self.strategy.session.skip_first_trade,
        }


def run_from_parquet(
    dataset_glob: str,
    symbol: str,
    dates: Iterable[str] | None,
    instrument: InstrumentSpec,
) -> ReplayRunner:
    """Run the engine over MBO trades matching the filters. Returns the
    finalized runner so the caller can inspect bars / snapshots / trades."""
    scan = (
        pl.scan_parquet(dataset_glob, hive_partitioning=True)
        .filter(pl.col("symbol") == symbol)
        .filter(pl.col("action") == "T")
    )
    if dates:
        date_list = [date.fromisoformat(d) if isinstance(d, str) else d
                     for d in dates]
        scan = scan.filter(pl.col("date").is_in(date_list))
    df = (
        scan.select(["ts_event", "price", "size"])
        .sort("ts_event")
        .collect()
    )
    runner = ReplayRunner(instrument)
    for ts_event, price_int, size in df.iter_rows():
        runner.feed_trade(ts_event, price_int / PRICE_SCALE, int(size))
    runner.finalize()
    return runner


def trades_as_records(runner: ReplayRunner) -> list[dict]:
    """Flatten the engine's TradeRecord list to JSON-able dicts for output."""
    out = []
    for trade in runner.strategy.trades:
        record = asdict(trade)
        record["side"] = trade.side.name
        record["exit_reason"] = trade.exit_reason.value
        record["entry_ts"] = trade.entry_ts.astimezone(TZ_ET).isoformat()
        record["exit_ts"] = trade.exit_ts.astimezone(TZ_ET).isoformat()
        out.append(record)
    return out
