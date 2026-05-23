#!/usr/bin/env python3
"""Run the strategy across sessions and report aggregate performance metrics.

This is the baseline harness: it produces the numbers any future change
(MBO feature filters, fill-model tweaks, sizing) must be compared against.
Use --save to write a JSON snapshot, and --compare to diff against one.

Examples:
    # Baseline over all available dates, save snapshot
    uv run python scripts/backtest_metrics.py --save baseline.json

    # Re-run after a change and diff against the saved baseline
    uv run python scripts/backtest_metrics.py --compare baseline.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.config import INSTRUMENTS
from engine.metrics import compute_metrics, format_report
from engine.replay_runner import run_from_parquet, trades_as_records


def parse_dates(value: str | None) -> list[str] | None:
    if not value:
        return None
    return [d.strip() for d in value.split(",") if d.strip()]


# Headline fields shown in a baseline-vs-current comparison.
COMPARE_FIELDS = [
    ("trade_count", "Trades", False),
    ("win_rate", "Win rate", False),
    ("net_pnl_usd", "Net P&L", True),
    ("profit_factor", "Profit factor", False),
    ("expectancy_usd", "Expectancy", True),
    ("max_drawdown_usd", "Max drawdown", True),
]


def print_comparison(base: dict, cur: dict) -> None:
    print("\n=== Baseline vs Current ===")
    print(f"  {'Metric':<16}{'Baseline':>14}{'Current':>14}{'Delta':>14}")
    print("  " + "-" * 56)
    for key, label, money in COMPARE_FIELDS:
        b = base.get(key)
        c = cur.get(key)
        if b is None or c is None:
            continue
        if money:
            bs, cs = f"${b:+,.2f}", f"${c:+,.2f}"
            ds = f"${c - b:+,.2f}"
        elif key == "win_rate":
            bs, cs = f"{b * 100:.1f}%", f"{c * 100:.1f}%"
            ds = f"{(c - b) * 100:+.1f}pp"
        elif key == "trade_count":
            bs, cs, ds = str(b), str(c), f"{c - b:+d}"
        else:
            bs, cs, ds = f"{b:.2f}", f"{c:.2f}", f"{c - b:+.2f}"
        print(f"  {label:<16}{bs:>14}{cs:>14}{ds:>14}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Aggregate strategy performance metrics.")
    parser.add_argument("--dataset", default="data/parquet/mbo/date=*/mbo.parquet")
    parser.add_argument("--symbol", default="ESM6")
    parser.add_argument("--instrument", default="MES",
                        choices=sorted(INSTRUMENTS.keys()))
    parser.add_argument("--dates",
                        help="Comma-separated YYYY-MM-DD list. Defaults to all dates.")
    parser.add_argument("--save", metavar="PATH",
                        help="Write the metrics snapshot to a JSON file.")
    parser.add_argument("--compare", metavar="PATH",
                        help="Diff this run against a saved baseline JSON.")
    parser.add_argument("--json", action="store_true",
                        help="Print the full metrics dict as JSON instead of a report.")
    args = parser.parse_args()

    instrument = INSTRUMENTS[args.instrument]
    print(f"Loading {args.dataset} for symbol={args.symbol} "
          f"instrument={args.instrument} ...", file=sys.stderr)
    runner = run_from_parquet(
        args.dataset, args.symbol, parse_dates(args.dates), instrument)
    trades = trades_as_records(runner)
    metrics = compute_metrics(trades)

    if args.json:
        print(json.dumps(metrics, indent=2))
    else:
        print(format_report(metrics))

    if args.compare:
        baseline = json.loads(Path(args.compare).read_text())
        print_comparison(baseline, metrics)

    if args.save:
        # Drop the equity curve from the saved snapshot to keep it small;
        # everything needed for comparison is in the scalar fields.
        snapshot = {k: v for k, v in metrics.items() if k != "equity_curve"}
        snapshot["_meta"] = {
            "symbol": args.symbol,
            "instrument": args.instrument,
            "dates": args.dates or "all",
        }
        Path(args.save).write_text(json.dumps(snapshot, indent=2))
        print(f"\nSnapshot written to {args.save}", file=sys.stderr)


if __name__ == "__main__":
    main()
