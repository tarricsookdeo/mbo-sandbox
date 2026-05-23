from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from enum import Enum

from .bars import Bar
from .config import (
    BREAKEVEN_R_TRIGGER,
    CONSECUTIVE_LOSSES_THRESHOLD,
    CONSECUTIVE_LOSS_PAUSE_MINUTES,
    DAILY_LOSS_LIMIT_USD,
    FEE_PER_SIDE_USD,
    GAP_ATR_MULTIPLIER,
    GAP_RESOLUTION_BARS,
    InstrumentSpec,
    MAX_TRADES_PER_DAY,
    SESSION_HARD_FLATTEN,
    SESSION_NO_NEW_ENTRIES,
    SESSION_START,
    STOP_ATR_MULTIPLIER,
    TARGET_R_MULTIPLE,
    TZ_ET,
)
from .indicators import Indicators


class Side(Enum):
    LONG = 1
    SHORT = -1


class ExitReason(Enum):
    HARD_FLATTEN = "hard_flatten"
    TARGET = "target"
    STOP = "stop"
    BUFF_CROSS_BACK = "buff_cross_back"
    DIR_FLIP = "dir_flip"


@dataclass
class Position:
    side: Side
    qty: int
    entry_ts: datetime
    entry_price: float
    initial_stop: float
    target: float
    current_stop: float
    initial_risk: float          # per-contract, in price terms
    breakeven_moved: bool = False


@dataclass
class TradeRecord:
    side: Side
    qty: int
    entry_ts: datetime
    entry_price: float
    exit_ts: datetime
    exit_price: float
    exit_reason: ExitReason
    pnl_ticks: float
    pnl_usd: float


@dataclass
class SessionState:
    trades_taken: int = 0
    consecutive_losses: int = 0
    daily_pnl_usd: float = 0.0
    halted: bool = False
    paused_until: datetime | None = None
    skip_first_trade: bool = False
    gap_resolution_progress: int = 0
    pre_session_checked: bool = False


class Strategy:
    """State machine implementing STRATEGY.md.

    v1 simplifications:
      * Single instrument per Strategy instance (the runner instantiates one
        per traded symbol if multi-instrument is needed later)
      * Confluence sizing not applied — every entry is 1 contract
      * Manual overrides (pause/resume/flatten/set_param) not wired
      * Stop and target fills assume exact-price execution (Phase C will
        upgrade to MBO-walked fills)
    """

    def __init__(self, instrument: InstrumentSpec, indicators: Indicators) -> None:
        self.instrument = instrument
        self.indicators = indicators
        self.session = SessionState()
        self.position: Position | None = None
        self.pending_entry: Side | None = None
        self.trades: list[TradeRecord] = []
        # Trigger-bar context needed for the rule "prev_close on the right
        # side of buff" — captured each bar close so we can reference it on
        # the next bar's evaluation.
        self._prev_close: float | None = None

    # --------------------------- session lifecycle ---------------------------

    def on_session_reset(self) -> None:
        """Called by the runner when the trading day rolls over."""
        self.session = SessionState()
        self.position = None
        self.pending_entry = None
        # Note: `_prev_close` intentionally persists; the previous bar's close
        # might be relevant if the runner replays cross-session (though for
        # v1 single-day scope, this is moot).

    # --------------------------- bar-close pipeline ---------------------------

    def on_bar_close(self, bar: Bar) -> list[dict]:
        """Called after indicators have been updated for this bar."""
        events: list[dict] = []
        bar_et = bar.end_ts.astimezone(TZ_ET).time()

        # Pre-session gap check (once, the first time we close a bar at/after 09:45)
        if not self.session.pre_session_checked and bar_et >= SESSION_START:
            self._run_gap_filter(bar, events)
            self.session.pre_session_checked = True

        # Gap-filter resolution: track consecutive bars with |close-buff| <= 1.5*ATR
        if self.session.skip_first_trade:
            self._update_gap_resolution(bar, events)

        # Bar-close exit checks for an open position
        if self.position is not None:
            self._run_bar_close_exits(bar, events)

        # Entry signal evaluation
        if self.position is None and self.pending_entry is None:
            self._evaluate_entry(bar, events)

        self._prev_close = bar.close
        return events

    # --------------------------- trade-event pipeline ---------------------------

    def on_trade(self, ts: datetime, price: float) -> list[dict]:
        """Called on every trade event during replay."""
        events: list[dict] = []
        ts_et = ts.astimezone(TZ_ET).time()

        # Hard flatten window — exits dominate everything else
        if self.position is not None and ts_et >= SESSION_HARD_FLATTEN:
            self._close_position(ts, price, ExitReason.HARD_FLATTEN, events)
            self.pending_entry = None
            return events

        # In-position intra-bar management: stop, breakeven, target
        if self.position is not None:
            if self._check_stop_hit(price):
                self._close_position(ts, self.position.current_stop,
                                     ExitReason.STOP, events)
                return events
            if not self.position.breakeven_moved and self._reached_breakeven(price):
                self.position.current_stop = self.position.entry_price
                self.position.breakeven_moved = True
                events.append({
                    "type": "breakeven",
                    "ts": ts,
                    "stop": self.position.entry_price,
                })
            if self._check_target_hit(price):
                self._close_position(ts, self.position.target,
                                     ExitReason.TARGET, events)
                return events

        # Pending entry: execute at the first trade event after the trigger bar
        if self.pending_entry is not None and self.position is None:
            if SESSION_START <= ts_et < SESSION_HARD_FLATTEN:
                self._open_position(ts, price, self.pending_entry, events)
            self.pending_entry = None

        return events

    # --------------------------- gating ---------------------------

    def _can_enter(self, bar: Bar) -> bool:
        bar_close_et = bar.end_ts.astimezone(TZ_ET).time()
        if not (SESSION_START <= bar_close_et < SESSION_NO_NEW_ENTRIES):
            return False
        if self.session.halted:
            return False
        if self.session.skip_first_trade:
            return False
        if self.session.paused_until is not None and bar.end_ts < self.session.paused_until:
            return False
        if self.session.trades_taken >= MAX_TRADES_PER_DAY:
            return False
        ind = self.indicators.state
        if ind.dir == 0:
            return False
        if ind.prev_buff is None:
            return False
        if ind.buff is None or ind.atr is None or ind.rsi is None:
            return False
        if self._prev_close is None:
            return False
        return True

    # --------------------------- entry ---------------------------

    def _evaluate_entry(self, bar: Bar, events: list[dict]) -> None:
        if not self._can_enter(bar):
            return
        ind = self.indicators.state
        buff = ind.buff
        atr = ind.atr
        rsi = ind.rsi
        prev = self._prev_close
        assert buff is not None and atr is not None and rsi is not None and prev is not None

        # Long: dir up, close pulled back to within 1*ATR above buff, RSI<50,
        # closed above buff, prev_close below buff (confirms a fresh cross).
        if ind.dir == 1:
            if (buff <= bar.close <= buff + atr
                    and rsi < 50
                    and bar.close > buff
                    and prev < buff):
                self.pending_entry = Side.LONG
                events.append({
                    "type": "signal",
                    "ts": bar.end_ts,
                    "side": "LONG",
                    "trigger_close": bar.close,
                    "buff": buff, "atr": atr, "rsi": rsi,
                })
                return

        # Short: mirror
        if ind.dir == -1:
            if (buff - atr <= bar.close <= buff
                    and rsi > 50
                    and bar.close < buff
                    and prev > buff):
                self.pending_entry = Side.SHORT
                events.append({
                    "type": "signal",
                    "ts": bar.end_ts,
                    "side": "SHORT",
                    "trigger_close": bar.close,
                    "buff": buff, "atr": atr, "rsi": rsi,
                })

    def _open_position(self, ts: datetime, price: float, side: Side,
                       events: list[dict]) -> None:
        ind = self.indicators.state
        if ind.buff is None or ind.atr is None:
            return
        if side == Side.LONG:
            stop = ind.buff - STOP_ATR_MULTIPLIER * ind.atr
            risk = price - stop
        else:
            stop = ind.buff + STOP_ATR_MULTIPLIER * ind.atr
            risk = stop - price
        if risk <= 0:
            events.append({"type": "entry_skipped", "ts": ts,
                           "reason": "stop_on_wrong_side"})
            return
        risk_ticks = risk / self.instrument.tick_size
        if risk_ticks > self.instrument.max_stop_ticks:
            events.append({"type": "entry_skipped", "ts": ts,
                           "reason": "stop_too_wide",
                           "risk_ticks": risk_ticks,
                           "cap": self.instrument.max_stop_ticks})
            return
        target = price + TARGET_R_MULTIPLE * risk if side == Side.LONG \
            else price - TARGET_R_MULTIPLE * risk
        self.position = Position(
            side=side, qty=1,
            entry_ts=ts, entry_price=price,
            initial_stop=stop, target=target,
            current_stop=stop, initial_risk=risk,
        )
        events.append({
            "type": "fill",
            "ts": ts, "side": side.name, "qty": 1, "price": price,
            "stop": stop, "target": target, "risk_ticks": risk_ticks,
        })

    # --------------------------- exits ---------------------------

    def _check_stop_hit(self, price: float) -> bool:
        if self.position is None:
            return False
        if self.position.side == Side.LONG:
            return price <= self.position.current_stop
        return price >= self.position.current_stop

    def _check_target_hit(self, price: float) -> bool:
        if self.position is None:
            return False
        if self.position.side == Side.LONG:
            return price >= self.position.target
        return price <= self.position.target

    def _reached_breakeven(self, price: float) -> bool:
        if self.position is None:
            return False
        threshold = BREAKEVEN_R_TRIGGER * self.position.initial_risk
        if self.position.side == Side.LONG:
            return (price - self.position.entry_price) >= threshold
        return (self.position.entry_price - price) >= threshold

    def _run_bar_close_exits(self, bar: Bar, events: list[dict]) -> None:
        ind = self.indicators.state
        pos = self.position
        if pos is None:
            return
        # Priority 5: dir flip
        if pos.side == Side.LONG and ind.dir == -1:
            self._close_position(bar.end_ts, bar.close, ExitReason.DIR_FLIP, events)
            return
        if pos.side == Side.SHORT and ind.dir == 1:
            self._close_position(bar.end_ts, bar.close, ExitReason.DIR_FLIP, events)
            return
        # Priority 4: buff cross-back before breakeven moved
        if not pos.breakeven_moved and ind.buff is not None:
            if pos.side == Side.LONG and bar.close < ind.buff:
                self._close_position(bar.end_ts, bar.close,
                                     ExitReason.BUFF_CROSS_BACK, events)
                return
            if pos.side == Side.SHORT and bar.close > ind.buff:
                self._close_position(bar.end_ts, bar.close,
                                     ExitReason.BUFF_CROSS_BACK, events)
                return

    def _close_position(self, ts: datetime, price: float,
                        reason: ExitReason, events: list[dict]) -> None:
        pos = self.position
        if pos is None:
            return
        if pos.side == Side.LONG:
            price_delta = price - pos.entry_price
        else:
            price_delta = pos.entry_price - price
        pnl_ticks = price_delta / self.instrument.tick_size
        gross_usd = pnl_ticks * self.instrument.tick_value_usd * pos.qty
        fees = 2 * FEE_PER_SIDE_USD * pos.qty
        net_usd = gross_usd - fees
        record = TradeRecord(
            side=pos.side, qty=pos.qty,
            entry_ts=pos.entry_ts, entry_price=pos.entry_price,
            exit_ts=ts, exit_price=price, exit_reason=reason,
            pnl_ticks=pnl_ticks, pnl_usd=net_usd,
        )
        self.trades.append(record)
        self.session.trades_taken += 1
        self.session.daily_pnl_usd += net_usd
        if net_usd < 0:
            self.session.consecutive_losses += 1
            if self.session.consecutive_losses >= CONSECUTIVE_LOSSES_THRESHOLD:
                self.session.paused_until = ts + timedelta(
                    minutes=CONSECUTIVE_LOSS_PAUSE_MINUTES)
        else:
            self.session.consecutive_losses = 0
        if self.session.daily_pnl_usd <= -DAILY_LOSS_LIMIT_USD:
            self.session.halted = True
        events.append({
            "type": "exit",
            "ts": ts, "reason": reason.value,
            "side": pos.side.name, "qty": pos.qty,
            "entry_price": pos.entry_price, "exit_price": price,
            "pnl_ticks": pnl_ticks, "pnl_usd": net_usd,
        })
        self.position = None

    # --------------------------- gap filter ---------------------------

    def _run_gap_filter(self, bar: Bar, events: list[dict]) -> None:
        ind = self.indicators.state
        if ind.atr is None or ind.buff is None:
            return
        # Use bar.open as a proxy for the 09:45 open. If the gap-on-open vs
        # buff exceeds the threshold, mark skip_first_trade.
        if abs(bar.open - ind.buff) > GAP_ATR_MULTIPLIER * ind.atr:
            self.session.skip_first_trade = True
            events.append({
                "type": "gap_filter_active",
                "ts": bar.end_ts,
                "gap": abs(bar.open - ind.buff),
                "threshold": GAP_ATR_MULTIPLIER * ind.atr,
            })

    def _update_gap_resolution(self, bar: Bar, events: list[dict]) -> None:
        ind = self.indicators.state
        if ind.atr is None or ind.buff is None:
            return
        if abs(bar.close - ind.buff) <= GAP_ATR_MULTIPLIER * ind.atr:
            self.session.gap_resolution_progress += 1
            if self.session.gap_resolution_progress >= GAP_RESOLUTION_BARS:
                self.session.skip_first_trade = False
                self.session.gap_resolution_progress = 0
                events.append({"type": "gap_resolved", "ts": bar.end_ts})
        else:
            self.session.gap_resolution_progress = 0

    # --------------------------- helpers ---------------------------

    def unrealized_pnl_usd(self, mark_price: float) -> float:
        pos = self.position
        if pos is None:
            return 0.0
        if pos.side == Side.LONG:
            delta = mark_price - pos.entry_price
        else:
            delta = pos.entry_price - mark_price
        ticks = delta / self.instrument.tick_size
        return ticks * self.instrument.tick_value_usd * pos.qty
