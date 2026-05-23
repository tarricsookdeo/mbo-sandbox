from __future__ import annotations

from dataclasses import dataclass, field

from .bars import Bar
from .config import ATR_PERIOD, RSI_PERIOD


@dataclass
class IndicatorState:
    # buff: cumulative mean of bar closes within the current session. Resets
    # on `on_session_reset`. `prev_buff` holds the terminal value of the
    # previous session and is referenced by entry rule 5 and exit checks.
    buff: float | None = None
    prev_buff: float | None = None

    # Continuous indicators — do NOT reset across sessions.
    atr: float | None = None
    rsi: float | None = None
    dir: int = 0                # 1 rising, -1 falling, 0 unknown

    # ----- internals -----
    _buff_sum: float = 0.0
    _buff_count: int = 0
    # ATR (Wilder)
    _atr_prev_close: float | None = None
    _tr_history: list[float] = field(default_factory=list)
    # RSI (Wilder) — kept independent of ATR so neither field tangles the other
    _rsi_prev_close: float | None = None
    _avg_gain: float | None = None
    _avg_loss: float | None = None
    _gain_history: list[float] = field(default_factory=list)
    _loss_history: list[float] = field(default_factory=list)


class Indicators:
    """Incremental indicators driven by bar-close events.

    Spec mapping:
      * `buff` — cumulative mean of bar closes, resets at session boundary
      * `prev_buff` — terminal `buff` snapshot from the prior session
      * ATR(14), RSI(14) — continuous Wilder smoothing across session boundaries
      * `dir` — 1/-1 based on this bar's buff vs the prior bar's buff
    """

    def __init__(self) -> None:
        self.state = IndicatorState()

    def on_session_reset(self) -> None:
        """Snapshot current `buff` into `prev_buff` and reset the cumulative
        accumulator. Continuous indicators (ATR/RSI/dir) are untouched.

        We deliberately do NOT clear `state.buff` here. The next bar close
        overwrites it; until then, the lingering value lets the first
        new-session bar compute `dir` against the prior session's terminal
        buff, matching the pinescript reference.
        """
        s = self.state
        if s.buff is not None:
            s.prev_buff = s.buff
        s._buff_sum = 0.0
        s._buff_count = 0

    def on_bar_close(self, bar: Bar) -> None:
        self._update_atr(bar)
        self._update_rsi(bar)
        self._update_buff_and_dir(bar)

    # ----- internals -----

    def _update_atr(self, bar: Bar) -> None:
        s = self.state
        if s._atr_prev_close is None:
            tr = bar.high - bar.low
        else:
            tr = max(
                bar.high - bar.low,
                abs(bar.high - s._atr_prev_close),
                abs(bar.low - s._atr_prev_close),
            )
        s._atr_prev_close = bar.close
        s._tr_history.append(tr)
        if len(s._tr_history) < ATR_PERIOD:
            return
        if s.atr is None:
            s.atr = sum(s._tr_history[-ATR_PERIOD:]) / ATR_PERIOD
        else:
            s.atr = (s.atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD

    def _update_rsi(self, bar: Bar) -> None:
        s = self.state
        if s._rsi_prev_close is None:
            s._rsi_prev_close = bar.close
            return
        change = bar.close - s._rsi_prev_close
        s._rsi_prev_close = bar.close
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        s._gain_history.append(gain)
        s._loss_history.append(loss)
        if len(s._gain_history) < RSI_PERIOD:
            return
        if s._avg_gain is None:
            s._avg_gain = sum(s._gain_history[-RSI_PERIOD:]) / RSI_PERIOD
            s._avg_loss = sum(s._loss_history[-RSI_PERIOD:]) / RSI_PERIOD
        else:
            s._avg_gain = (s._avg_gain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD
            s._avg_loss = (s._avg_loss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD
        if s._avg_loss == 0:
            s.rsi = 100.0
        else:
            rs = s._avg_gain / s._avg_loss
            s.rsi = 100.0 - (100.0 / (1.0 + rs))

    def _update_buff_and_dir(self, bar: Bar) -> None:
        s = self.state
        prior_buff_value = s.buff   # may be prior-session terminal on first bar of new session
        s._buff_sum += bar.close
        s._buff_count += 1
        s.buff = s._buff_sum / s._buff_count

        if prior_buff_value is None:
            return                  # dir stays inherited (initial 0)
        if s.buff > prior_buff_value:
            s.dir = 1
        elif s.buff < prior_buff_value:
            s.dir = -1
        # equal → inherit
