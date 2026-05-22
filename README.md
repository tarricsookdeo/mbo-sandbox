# MBO Sandbox

This workspace contains Databento `GLBX.MDP3` market-by-order files for ES futures in `data/raw`.

## Prepare the Data

Install the Python dependencies:

```bash
uv sync
```

Convert the daily DBN files to partitioned Parquet:

```bash
uv run python scripts/convert_dbn_to_parquet.py
```

The output is a Parquet dataset, not one giant Parquet file. Each raw daily DBN
file becomes one daily Parquet partition:

```text
data/parquet/mbo/
  date=2026-03-29/mbo.parquet
  date=2026-03-30/mbo.parquet
  ...
```

Prices are written as Databento fixed integers by default, where one unit is
`1e-9`. This is the recommended storage format for financial event data because
it is exact, compact, and fast. Use `--price-type float` only if you want easier
ad hoc plotting.

## Explore With Polars

```python
import polars as pl

mbo = pl.scan_parquet("data/parquet/mbo/date=*/mbo.parquet")

sample = (
    mbo
    .filter(pl.col("date") == "2026-04-01")
    .select("ts_event", "instrument_id", "symbol", "action", "side", "price", "size")
    .head(20)
    .collect()
)

print(sample)
```

For fixed prices:

```python
with_prices = mbo.with_columns((pl.col("price") / 1_000_000_000).alias("price_float"))
```

## Explore With DuckDB

```sql
SELECT
  date,
  instrument_id,
  symbol,
  count(*) AS messages
FROM read_parquet('data/parquet/mbo/date=*/mbo.parquet', hive_partitioning = true)
GROUP BY 1, 2, 3
ORDER BY 1, 2;
```

## Inspect Events In The Dashboard

Start the local dashboard:

```bash
uv run python scripts/dashboard_server.py
```

Then open:

```text
http://127.0.0.1:8000
```

If you are opening the page from a Windows browser while the server is running
inside WSL2, use the `WSL/LAN` URL printed by the command, for example
`http://172.x.x.x:8000`.

The dashboard lists each ES orderbook by `symbol` and `instrument_id`. Select an
orderbook to load its first 200 and last 200 MBO events from the Parquet dataset.
By default it only shows the `ESM6` orderbook.

The `Book Replay` tab lets you walk forward through `ESM6` events and see how
each action changes the resting order book. Choose a session date before loading
replay rows; this reads one daily Parquet partition instead of scanning the
entire multi-day dataset. `Start Row` is zero-based within the selected session,
and `Chunk` is the number of MBO rows to fetch for each replay page. The `All
dates` option keeps the old cross-session behavior, but it is slower.

Replay uses Databento's MBO state rules: `A`, `M`, `C`, and `R` update the book,
while `T`, `F`, and `N` do not change resting order state. Replay is forward-only
so the book state stays consistent.

The `Trade Candles` tab walks through the same event stream and builds an OHLC
chart from `T` trade records. Non-trade records still advance the current event,
but only trades update the candle chart. Use the `T` control to jump to the next
trade if the current session starts with book-building messages.

To inspect a different symbol:

```bash
uv run python scripts/dashboard_server.py --symbol ESU6
```

To show every symbol again:

```bash
uv run python scripts/dashboard_server.py --symbol ''
```
