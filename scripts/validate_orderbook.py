#!/usr/bin/env python3
"""Validate the L3 order book reconstructor against real MBO data.

Replays every MBO event for a session through engine.orderbook.OrderBook and
reports consistency metrics. A healthy reconstruction shows:
  - zero dangling cancels/modifies (every C/M references a known order)
  - a near-zero crossed/locked rate during RTH (transient artifacts only)
  - sane EOD top-of-book (spread ~1 tick, plausible price)

Example:
    uv run python scripts/validate_orderbook.py --date 2026-03-31
    uv run python scripts/validate_orderbook.py            # all dates
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.config import INSTRUMENTS, PRICE_SCALE
from engine.orderbook import OrderBook

# RTH in UTC. The data window is US equity-index futures; CME RTH is
# 09:30-16:00 ET, which is 13:30-20:00 UTC under EDT (the dataset's season).
RTH_LO_MIN = 13 * 60 + 30
RTH_HI_MIN = 20 * 60


def validate_day(df: pl.DataFrame, tick_size: float) -> dict:
    acts = df["action"].to_list()
    sides = df["side"].to_list()
    prices = df["price"].to_list()
    sizes = df["size"].to_list()
    oids = df["order_id"].to_list()
    hours = df["ts_event"].dt.hour().to_list()
    mins = df["ts_event"].dt.minute().to_list()

    ob = OrderBook()
    dangling_c = dangling_m = 0
    rth_checks = rth_crossed = rth_locked = 0
    worst_run = run = 0

    for i in range(len(acts)):
        a, oid = acts[i], oids[i]
        if a == "C" and oid not in ob.orders:
            dangling_c += 1
        elif a == "M" and oid not in ob.orders:
            dangling_m += 1
        ob.apply(a, sides[i], int(prices[i]), int(sizes[i]), int(oid))

        t = hours[i] * 60 + mins[i]
        if not (RTH_LO_MIN <= t < RTH_HI_MIN):
            run = 0
            continue
        bb, ba = ob.best_bid(), ob.best_ask()
        if bb is None or ba is None:
            continue
        rth_checks += 1
        if bb.price > ba.price:
            rth_crossed += 1
            run += 1
            worst_run = max(worst_run, run)
        else:
            run = 0
            if bb.price == ba.price:
                rth_locked += 1

    bb, ba = ob.best_bid(), ob.best_ask()
    return {
        "events": len(acts),
        "dangling_c": dangling_c,
        "dangling_m": dangling_m,
        "rth_checks": rth_checks,
        "rth_crossed": rth_crossed,
        "rth_locked": rth_locked,
        "worst_cross_run": worst_run,
        "eod_spread_ticks": ob.spread_ticks(tick_size),
        "eod_mid": ob.mid(),
        "eod_resting": len(ob.orders),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate the order book reconstructor.")
    parser.add_argument("--dataset", default="data/parquet/mbo/date=*/mbo.parquet")
    parser.add_argument("--symbol", default="ESM6")
    parser.add_argument("--instrument", default="MES",
                        choices=sorted(INSTRUMENTS.keys()))
    parser.add_argument("--date", help="Single YYYY-MM-DD. Defaults to all dates.")
    args = parser.parse_args()

    tick = INSTRUMENTS[args.instrument].tick_size
    lf = (
        pl.scan_parquet(args.dataset, hive_partitioning=True)
        .filter(pl.col("symbol") == args.symbol)
    )
    if args.date:
        dates = [args.date]
    else:
        dates = sorted(
            lf.select("date").unique().collect()["date"].cast(pl.Utf8).to_list())

    print(f"{'date':<12}{'events':>12}{'dangC':>7}{'dangM':>7}"
          f"{'cross%':>9}{'lock%':>9}{'worstRun':>9}{'spread':>8}{'mid':>10}")
    print("-" * 95)
    tot_cross = tot_lock = tot_checks = tot_dang = 0
    for d in dates:
        df = (
            lf.filter(pl.col("date") == pl.lit(d).str.to_date())
            .select(["ts_event", "sequence", "action", "side",
                     "price", "size", "order_id"])
            .sort(["ts_event", "sequence"])
            .collect()
        )
        r = validate_day(df, tick)
        chk = max(r["rth_checks"], 1)
        cross_pct = r["rth_crossed"] / chk * 100
        lock_pct = r["rth_locked"] / chk * 100
        tot_cross += r["rth_crossed"]
        tot_lock += r["rth_locked"]
        tot_checks += r["rth_checks"]
        tot_dang += r["dangling_c"] + r["dangling_m"]
        spread = r["eod_spread_ticks"]
        mid = r["eod_mid"]
        print(f"{d:<12}{r['events']:>12,}{r['dangling_c']:>7}{r['dangling_m']:>7}"
              f"{cross_pct:>8.4f}%{lock_pct:>8.4f}%{r['worst_cross_run']:>9}"
              f"{(spread if spread is not None else float('nan')):>8.2f}"
              f"{(mid if mid is not None else float('nan')):>10.2f}")

    print("-" * 95)
    chk = max(tot_checks, 1)
    print(f"TOTAL: {tot_checks:,} RTH checks  |  dangling C+M={tot_dang}  |  "
          f"crossed={tot_cross / chk * 100:.4f}%  locked={tot_lock / chk * 100:.4f}%")
    if tot_dang == 0:
        print("PASS: no dangling cancels/modifies — book stays internally consistent.")
    else:
        print("WARN: dangling references present — check event semantics.")


if __name__ == "__main__":
    main()
