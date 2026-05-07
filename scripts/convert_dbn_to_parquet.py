#!/usr/bin/env python3
"""Convert Databento DBN files under data/raw into partitioned Parquet.

By default prices stay in Databento's native fixed integer representation,
where one price unit is 1e-9. This keeps MBO data exact and efficient.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

import databento as db


DATE_RE = re.compile(r"(\d{4})(\d{2})(\d{2})")


def date_from_name(path: Path) -> str:
    match = DATE_RE.search(path.name)
    if not match:
        raise ValueError(f"Could not find YYYYMMDD date in {path.name}")
    year, month, day = match.groups()
    return f"{year}-{month}-{day}"


def convert_one(
    src: Path,
    out_root: Path,
    *,
    price_type: str,
    map_symbols: bool,
    overwrite: bool,
) -> Path:
    session_date = date_from_name(src)
    out_dir = out_root / f"date={session_date}"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "mbo.parquet"

    if out_path.exists() and not overwrite:
        print(f"skip existing {out_path}")
        return out_path

    print(f"convert {src} -> {out_path}")
    store = db.DBNStore.from_file(src)
    store.to_parquet(
        out_path,
        price_type=price_type,
        pretty_ts=True,
        map_symbols=map_symbols,
        schema="mbo",
        mode="w",
        compression="zstd",
    )
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert Databento MBO DBN .zst files to daily Parquet partitions."
    )
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--out-dir", type=Path, default=Path("data/parquet/mbo"))
    parser.add_argument(
        "--glob",
        default="*.mbo.dbn.zst",
        help="Input glob relative to --raw-dir.",
    )
    parser.add_argument(
        "--price-type",
        choices=("fixed", "float"),
        default="fixed",
        help=(
            "Price representation for Parquet output. Defaults to fixed, which "
            "preserves Databento 1e-9 integer prices. Use float only for easier "
            "ad hoc charting."
        ),
    )
    parser.add_argument(
        "--no-map-symbols",
        action="store_true",
        help="Do not add a symbol column from Databento symbology metadata.",
    )
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    files = sorted(args.raw_dir.glob(args.glob))
    if not files:
        raise SystemExit(f"No files matched {args.raw_dir / args.glob}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for src in files:
        convert_one(
            src,
            args.out_dir,
            price_type=args.price_type,
            map_symbols=not args.no_map_symbols,
            overwrite=args.overwrite,
        )

    print(f"done: wrote {len(files)} partition(s) under {args.out_dir}")


if __name__ == "__main__":
    main()
