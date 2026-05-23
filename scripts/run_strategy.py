#!/usr/bin/env python3
"""Run the strategy engine over a set of session dates and print the trade log.

Used to verify engine correctness before wiring into the dashboard. Example:

    uv run python scripts/run_strategy.py --dates 2026-03-29,2026-03-30,2026-03-31
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.config import INSTRUMENTS, TZ_ET
from engine.replay_runner import run_from_parquet, trades_as_records


def parse_dates(value: str | None) -> list[str] | None:
    if not value:
        return None
    return [d.strip() for d in value.split(",") if d.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the strategy engine over MBO data.")
    parser.add_argument("--dataset", default="data/parquet/mbo/date=*/mbo.parquet")
    parser.add_argument("--symbol", default="ESM6")
    parser.add_argument("--instrument", default="MES",
                        choices=sorted(INSTRUMENTS.keys()))
    parser.add_argument("--dates",
                        help="Comma-separated YYYY-MM-DD list. Defaults to all dates.")
    parser.add_argument("--verbose", action="store_true",
                        help="Print all timeline events.")
    args = parser.parse_args()

    instrument = INSTRUMENTS[args.instrument]
    print(f"Loading {args.dataset} for symbol={args.symbol} ...")
    runner = run_from_parquet(
        args.dataset, args.symbol, parse_dates(args.dates), instrument,
    )

    print(f"\nClosed bars: {len(runner.closed_bars)}")
    if runner.closed_bars:
        first = runner.closed_bars[0]
        last = runner.closed_bars[-1]
        print(f"  first bar start: {first.start_ts.astimezone(TZ_ET)}")
        print(f"  last bar end:    {last.end_ts.astimezone(TZ_ET)}")

    if args.verbose:
        print("\n--- Timeline events ---")
        for ev in runner.timeline:
            print(ev)

    trades = trades_as_records(runner)
    print(f"\n=== Trades ({len(trades)}) ===")
    if trades:
        header = (f"{'Side':<6}{'Entry':<22}{'@Price':>10}"
                  f"{'Exit':<22}{'@Price':>10}"
                  f"{'Reason':>18}{'Ticks':>8}{'P&L $':>10}")
        print(header)
        print("-" * len(header))

    total = 0.0
    wins = 0
    losses = 0
    for t in trades:
        sign = "" if t["pnl_usd"] < 0 else "+"
        print(f"{t['side']:<6}"
              f"{t['entry_ts']:<22}{t['entry_price']:>10.2f}"
              f"{t['exit_ts']:<22}{t['exit_price']:>10.2f}"
              f"{t['exit_reason']:>18}{t['pnl_ticks']:>8.1f}"
              f"{sign}${t['pnl_usd']:>8.2f}")
        total += t["pnl_usd"]
        if t["pnl_usd"] > 0:
            wins += 1
        elif t["pnl_usd"] < 0:
            losses += 1

    print("\n=== Summary ===")
    print(f"  Trades:    {len(trades)}")
    print(f"  Wins:      {wins}")
    print(f"  Losses:    {losses}")
    if trades:
        print(f"  Win rate:  {wins / len(trades) * 100:.1f}%")
    print(f"  Total P&L: ${total:+.2f}")


if __name__ == "__main__":
    main()
