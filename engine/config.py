from __future__ import annotations

from dataclasses import dataclass
from datetime import time
from zoneinfo import ZoneInfo


TZ_ET = ZoneInfo("America/New_York")

# Session windows (ET wall-clock). RTH 09:30-16:00; strategy trades 09:45-15:00,
# hard flattens at 15:45. Cumulative-mean indicator (`buff`) accumulates across
# the full RTH window so it has warmup before the trade window opens.
RTH_OPEN = time(9, 30)
RTH_CLOSE = time(16, 0)
SESSION_START = time(9, 45)
SESSION_NO_NEW_ENTRIES = time(15, 0)
SESSION_HARD_FLATTEN = time(15, 45)

BAR_SECONDS = 300            # 5-min bars

# Databento MBO prices are fixed-point integers; 1 unit = 1e-9 price.
PRICE_SCALE = 1_000_000_000

# Indicator periods
ATR_PERIOD = 14
RSI_PERIOD = 14

# Entry / exit / stop parameters (from STRATEGY.md)
GAP_ATR_MULTIPLIER = 1.5
GAP_RESOLUTION_BARS = 2
STOP_ATR_MULTIPLIER = 0.5
TARGET_R_MULTIPLE = 2.0
BREAKEVEN_R_TRIGGER = 1.0

# Risk gates
DAILY_LOSS_LIMIT_USD = 1000.0
MAX_TRADES_PER_DAY = 3
CONSECUTIVE_LOSSES_THRESHOLD = 2
CONSECUTIVE_LOSS_PAUSE_MINUTES = 30

# Execution costs (per side per contract, USD). MES round-trip ~ $1.50 with
# typical retail futures broker; tune as needed.
FEE_PER_SIDE_USD = 0.75


@dataclass(frozen=True)
class InstrumentSpec:
    symbol: str
    tick_size: float          # price increment
    tick_value_usd: float     # $ per tick per contract
    max_stop_ticks: int       # skip trade if initial stop wider than this
    calibrated: bool          # was max_stop_ticks replay-calibrated?


# MES = Micro E-mini S&P 500. ES MBO data is used as a price proxy (same
# underlying, contract size differs). Tick = 0.25 index pts = $1.25.
MES = InstrumentSpec(
    symbol="MES", tick_size=0.25, tick_value_usd=1.25,
    max_stop_ticks=50, calibrated=True,
)
MNQ = InstrumentSpec(
    symbol="MNQ", tick_size=0.25, tick_value_usd=0.50,
    max_stop_ticks=100, calibrated=True,
)
MGC = InstrumentSpec(
    symbol="MGC", tick_size=0.10, tick_value_usd=1.00,
    max_stop_ticks=200, calibrated=False,
)
MCL = InstrumentSpec(
    symbol="MCL", tick_size=0.01, tick_value_usd=1.00,
    max_stop_ticks=200, calibrated=False,
)

INSTRUMENTS = {spec.symbol: spec for spec in (MES, MNQ, MGC, MCL)}
