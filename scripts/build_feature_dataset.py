#!/usr/bin/env python3
"""Build a [signed-flow features at entry -> trade outcome] research dataset.

Decouples feature research from the strategy: we run the existing strategy
to get its trades, then independently compute the order flow leading into
each entry. The output table lets us test whether flow separates winners
from losers BEFORE wiring anything into the strategy.

Example:
    uv run python scripts/build_feature_dataset.py --out data/features/signed_flow.parquet
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.config import INSTRUMENTS, TZ_ET
from engine.features import DEFAULT_WINDOWS, flow_features_at, load_trade_flow
from engine.replay_runner import run_from_parquet


def parse_dates(value: str | None) -> list[str] | None:
    if not value:
        return None
    return [d.strip() for d in value.split(",") if d.strip()]


def build_rows(runner, ts_ns, signed, size, windows) -> list[dict]:
    rows = []
    for t in runner.strategy.trades:
        end_ns = t.entry_ts.value if hasattr(t.entry_ts, "value") else \
            int(t.entry_ts.timestamp() * 1_000_000_000)
        dir_sign = t.side.value  # LONG=+1, SHORT=-1
        row = {
            "entry_ts": t.entry_ts.astimezone(TZ_ET).isoformat(),
            "date": t.entry_ts.astimezone(TZ_ET).date().isoformat(),
            "side": t.side.name,
            "dir_sign": dir_sign,
            "entry_price": t.entry_price,
            "exit_reason": t.exit_reason.value,
            "pnl_usd": t.pnl_usd,
            "pnl_ticks": t.pnl_ticks,
            "win": t.pnl_usd > 0,
        }
        for w in windows:
            f = flow_features_at(ts_ns, signed, size, end_ns, w)
            row[f"ofi_{w}m"] = f["ofi"]
            row[f"trade_imb_{w}m"] = f["trade_imbalance"]
            row[f"signed_vol_{w}m"] = f["signed_volume"]
            row[f"volume_{w}m"] = f["total_volume"]
            # Direction-aligned: positive => flow agrees with the trade side.
            row[f"ofi_aligned_{w}m"] = f["ofi"] * dir_sign
        rows.append(row)
    return rows


def analyze(df: pl.DataFrame, windows) -> None:
    """Print winners-vs-losers separation for each flow feature."""
    wins = df.filter(pl.col("win"))
    losses = df.filter(~pl.col("win"))
    nw, nl = wins.height, losses.height
    print(f"\n=== Winners vs Losers (n={nw} win / {nl} loss) ===")
    print("  Direction-aligned OFI > 0 means flow agreed with the trade side.\n")

    feats = []
    for w in windows:
        feats += [f"ofi_aligned_{w}m", f"ofi_{w}m", f"trade_imb_{w}m"]

    header = f"  {'feature':<20}{'win_mean':>12}{'loss_mean':>12}{'separation':>12}"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for f in feats:
        wm = wins[f].mean() if nw else None
        lm = losses[f].mean() if nl else None
        sep = (wm - lm) if (wm is not None and lm is not None) else None
        wm_s = f"{wm:>12.3f}" if wm is not None else f"{'n/a':>12}"
        lm_s = f"{lm:>12.3f}" if lm is not None else f"{'n/a':>12}"
        sep_s = f"{sep:>+12.3f}" if sep is not None else f"{'n/a':>12}"
        print(f"  {f:<20}{wm_s}{lm_s}{sep_s}")

    print("\n  NOTE: 36 trades is a tiny sample — read separations as hypotheses,")
    print("  not conclusions. A large |separation| flags a feature worth a")
    print("  proper out-of-sample test, nothing more.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build the signed-flow feature/outcome dataset.")
    parser.add_argument("--dataset", default="data/parquet/mbo/date=*/mbo.parquet")
    parser.add_argument("--symbol", default="ESM6")
    parser.add_argument("--instrument", default="MES",
                        choices=sorted(INSTRUMENTS.keys()))
    parser.add_argument("--dates",
                        help="Comma-separated YYYY-MM-DD list. Defaults to all dates.")
    parser.add_argument("--out", default="data/features/signed_flow.parquet",
                        help="Output path (.parquet). A .csv sibling is also written.")
    args = parser.parse_args()

    dates = parse_dates(args.dates)
    instrument = INSTRUMENTS[args.instrument]

    print(f"Running strategy on {args.symbol}/{args.instrument} ...", file=sys.stderr)
    runner = run_from_parquet(args.dataset, args.symbol, dates, instrument)

    print("Loading signed trade flow ...", file=sys.stderr)
    ts_ns, signed, size = load_trade_flow(args.dataset, args.symbol, dates)
    print(f"  {len(ts_ns):,} trade records loaded.", file=sys.stderr)

    rows = build_rows(runner, ts_ns, signed, size, DEFAULT_WINDOWS)
    if not rows:
        print("No trades produced — nothing to write.")
        return
    df = pl.DataFrame(rows)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(out)
    df.write_csv(out.with_suffix(".csv"))
    print(f"Wrote {df.height} rows x {df.width} cols to {out} (+ .csv)",
          file=sys.stderr)

    analyze(df, DEFAULT_WINDOWS)


if __name__ == "__main__":
    main()
