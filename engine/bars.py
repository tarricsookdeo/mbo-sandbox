from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from .config import BAR_SECONDS, TZ_ET


@dataclass
class Bar:
    start_ts: datetime          # inclusive, in ET
    end_ts: datetime            # exclusive, in ET
    open: float
    high: float
    low: float
    close: float
    volume: int
    trade_count: int


class BarAggregator:
    """Builds wall-clock-aligned bars from a forward-walking trade stream.

    Bars are aligned to absolute ET boundaries (e.g. 09:30:00, 09:35:00, ...)
    so they match what a trader would see on a standard chart. Empty intervals
    between trades are filled with carry-forward bars (open = high = low =
    close = last close, volume = 0) so the bar stream stays contiguous.
    """

    def __init__(self, bar_seconds: int = BAR_SECONDS) -> None:
        self.bar_seconds = bar_seconds
        self._current: Bar | None = None

    @property
    def current(self) -> Bar | None:
        return self._current

    def _bucket_start(self, ts: datetime) -> datetime:
        ts_et = ts.astimezone(TZ_ET)
        midnight = ts_et.replace(hour=0, minute=0, second=0, microsecond=0)
        secs_since_midnight = int((ts_et - midnight).total_seconds())
        floor_secs = (secs_since_midnight // self.bar_seconds) * self.bar_seconds
        return midnight + timedelta(seconds=floor_secs)

    def on_trade(self, ts: datetime, price: float, size: int) -> list[Bar]:
        """Feed one trade. Returns list of bars that closed because of it.

        A single trade can close multiple bars if there was a gap with no
        trades — those gap bars are filled with carry-forward values.
        """
        closed: list[Bar] = []
        bucket_start = self._bucket_start(ts)
        bucket_end = bucket_start + timedelta(seconds=self.bar_seconds)

        if self._current is None:
            self._current = Bar(
                start_ts=bucket_start, end_ts=bucket_end,
                open=price, high=price, low=price, close=price,
                volume=size, trade_count=1,
            )
            return closed

        if bucket_start == self._current.start_ts:
            self._current.high = max(self._current.high, price)
            self._current.low = min(self._current.low, price)
            self._current.close = price
            self._current.volume += size
            self._current.trade_count += 1
            return closed

        # Trade fell into a later bucket. Close current bar; fill any gap.
        closed.append(self._current)
        carry_close = self._current.close
        next_start = self._current.end_ts
        while next_start < bucket_start:
            empty = Bar(
                start_ts=next_start,
                end_ts=next_start + timedelta(seconds=self.bar_seconds),
                open=carry_close, high=carry_close,
                low=carry_close, close=carry_close,
                volume=0, trade_count=0,
            )
            closed.append(empty)
            next_start = empty.end_ts

        self._current = Bar(
            start_ts=bucket_start, end_ts=bucket_end,
            open=price, high=price, low=price, close=price,
            volume=size, trade_count=1,
        )
        return closed

    def force_close(self) -> Bar | None:
        """Emit the in-progress bar without waiting for the next trade. Used at
        session boundaries or end-of-stream."""
        bar = self._current
        self._current = None
        return bar
