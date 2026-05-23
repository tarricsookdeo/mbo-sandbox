"""Signed order-flow features from MBO trade records.

Trades (action="T") carry the aggressor side directly: side="B" means a
buyer lifted the ask (uptick pressure, +size), side="A" means a seller hit
the bid (downtick pressure, -size). This is ground-truth aggressor
classification — no Lee-Ready tick-rule inference needed.

Only "T" records are used. CME/Databento also emit one "F" (fill) per
resting order matched, so summing both would double-count volume.

The features here are computed over lookback windows ending at a trade's
entry instant, so we can ask: does the order flow leading into an entry
separate eventual winners from losers?
"""
from __future__ import annotations

import numpy as np
import polars as pl


def load_trade_flow(
    dataset_glob: str,
    symbol: str,
    dates: list[str] | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Load signed trade flow as sorted parallel numpy arrays.

    Returns (ts_ns, signed_size, size):
      ts_ns       int64 nanosecond UTC timestamps, ascending
      signed_size int64 +size for buy-aggressor, -size for sell-aggressor
      size        int64 unsigned trade size
    Neutral-side trades (rare) are dropped — they carry no aggressor sign.
    """
    scan = (
        pl.scan_parquet(dataset_glob, hive_partitioning=True)
        .filter(pl.col("symbol") == symbol)
        .filter(pl.col("action") == "T")
        .filter(pl.col("side").is_in(["B", "A"]))
    )
    if dates:
        from datetime import date as _date
        date_list = [_date.fromisoformat(d) for d in dates]
        scan = scan.filter(pl.col("date").is_in(date_list))

    df = (
        scan.select([
            "ts_event",
            "size",
            pl.when(pl.col("side") == "B")
              .then(pl.col("size").cast(pl.Int64))
              .otherwise(-pl.col("size").cast(pl.Int64))
              .alias("signed_size"),
        ])
        .sort("ts_event")
        .collect()
    )
    ts_ns = df["ts_event"].cast(pl.Int64).to_numpy()
    signed = df["signed_size"].to_numpy()
    size = df["size"].cast(pl.Int64).to_numpy()
    return ts_ns, signed, size


def flow_features_at(
    ts_ns: np.ndarray,
    signed: np.ndarray,
    size: np.ndarray,
    end_ns: int,
    window_minutes: int,
) -> dict:
    """Signed-flow features over [end_ns - window, end_ns).

    The window is half-open and excludes the entry instant itself so the
    features use only information available *before* the entry decision.
    """
    window_ns = window_minutes * 60 * 1_000_000_000
    lo = np.searchsorted(ts_ns, end_ns - window_ns, side="left")
    hi = np.searchsorted(ts_ns, end_ns, side="left")

    seg_signed = signed[lo:hi]
    seg_size = size[lo:hi]
    n = hi - lo
    total_vol = int(seg_size.sum())
    signed_vol = int(seg_signed.sum())
    buy_trades = int((seg_signed > 0).sum())
    sell_trades = int((seg_signed < 0).sum())

    return {
        "trade_count": int(n),
        "total_volume": total_vol,
        "signed_volume": signed_vol,
        # Volume-weighted trade imbalance in [-1, 1]; the classic OFI proxy.
        "ofi": (signed_vol / total_vol) if total_vol else 0.0,
        # Count-based imbalance, less sensitive to a few large prints.
        "trade_imbalance": ((buy_trades - sell_trades) / n) if n else 0.0,
    }


# Lookback windows (minutes) computed for every entry.
DEFAULT_WINDOWS = (5, 15, 30)
