# MBO Feature Primer

A reference for five microstructure features and techniques that are uniquely enabled by market-by-order data. Each entry covers the concept, why MBO is required (vs. bars or L1/L2 snapshots), pros, cons, and a starting point.

The animating principle: **if a feature can be computed from 1-second bars, MBO doesn't add value.** These five all fail that test in interesting ways.

---

## 1. Order Flow Imbalance (OFI)

### Concept

OFI measures the net pressure on price from book-modifying events at the best bid and ask. Introduced by Cont, Kukanov, and Stoikov (2014), it has a near-linear relationship with short-horizon price changes — one of the few microstructure findings that replicates across markets and decades.

### The math

Walk through every event that touches the top of the book. For each event `n`, compute a contribution `e_n`:

- When the best bid grows (price up, or size increases at the same price): `e_n = +Δsize`
- When the best bid shrinks (price down, or size decreases): `e_n = -Δsize`
- When the best ask grows: `e_n = -Δsize`
- When the best ask shrinks: `e_n = +Δsize`

OFI over a window is the sum of `e_n`. Positive OFI = net buying pressure. Intuition: thickening the bid or thinning the ask both indicate buying interest, and OFI counts these symmetrically.

### Why MBO

Every `A` (add), `M` (modify), `C` (cancel), and `T` (trade) event at the inside contributes. Bar data destroys this completely — even L1 snapshots at 1s intervals miss most of the event sequence between snapshots, which is exactly where the predictive signal lives.

### Pros

- Strong empirical evidence of short-horizon predictability (seconds to ~1 minute)
- Approximately linear in price changes — works well in simple linear models
- Cheap to compute incrementally as events arrive
- Useful as a feature, a regime detector, and an execution timing signal

### Cons

- Signal decays within seconds. After taker fees and slippage, realizable alpha is much smaller than the predictive R²
- Crowded — every HFT desk computes this; you are not finding it first
- Spoofable: layering creates fake OFI
- Top-of-book OFI is noisy on thick books like ES; multi-level OFI (MLOFI) at the first 5–10 levels is often a stronger signal for futures

### Starting point

Compute single-level OFI in 1-second buckets across one trading day. Correlate against forward returns at 1s, 5s, 30s, and 1m horizons. Identify the half-life of the signal. If top-of-book is weak, upgrade to MLOFI.

---

## 2. Exact Signed Flow (Trade Aggressor Classification)

### Concept

Every trade has a buyer and a seller. The "aggressor" is whoever took liquidity by crossing the spread. For analysis you want **signed volume**: positive for buy-aggressor trades, negative for sell-aggressor.

Without MBO you have to guess. The Lee-Ready algorithm (1991) uses the tick rule plus the quote rule to infer aggressor side from bars or L1, with ~80–85% accuracy in modern markets. BVC (Bulk Volume Classification) is another estimator. Both leak error into everything built on top of them.

With MBO, the `side` field on `T` records resolves aggressor side directly (verify Databento's exact convention — vendors differ on whether `side` is the aggressor or the resting side, but either way it is unambiguous).

### The math

```
signed_volume = +size  if aggressor is buyer
              = -size  if aggressor is seller
```

From this you can build:

- **CVD (cumulative volume delta)** — running sum of signed volume; a session-long flow gauge
- **VPIN** — volume-synchronized probability of informed trading; a flow toxicity measure
- **Size-stratified flow** — split by aggressor trade size (small ≈ retail; large ≈ institutional) and track each cohort separately

### Why MBO

You can approximate signed flow from L1 with Lee-Ready, but the residual error is correlated with the very things you care about (fast moves, high-volatility regimes, around news). For research and tight execution, ground truth matters.

### Pros

- Ground truth instead of inference — removes a known noise source
- Foundation for downstream features (CVD, VPIN, signed OFI, toxicity scores)
- Enables clean stratification by aggressor size, which is where most of the signal actually lives

### Cons

- It is a primitive, not a strategy — by itself it just describes the past direction of flow
- Doesn't capture hidden orders: a buyer hitting an iceberg shows one aggressor side, but the iceberg-holder's intent is invisible
- For many active strategies, Lee-Ready accuracy is "good enough"; the marginal value of exact signing is smaller than people think
- On CME, implied trades print on outright books but originate from spread orders — their aggressor semantics can be subtle, and Databento's `is_implied` flag (or equivalent) should be respected

### Starting point

Build a per-session CVD and overlay it on price. Look for divergences (price up, CVD flat or down → weak rally). Then layer in trade-size stratification: split into small / medium / large aggressor cohorts and check whether the large-aggressor CVD is the part that actually leads price.

---

## 3. Queue Position Dynamics

### Concept

When you place a limit order, you join a FIFO queue at that price level (CME outright futures, including ES, are FIFO). Your position in the queue determines whether you fill before the price moves on and how long you wait. Queue position dynamics is the study of how queues fill, drain, and migrate — and the use of that information to (a) decide when passive resting is worth it and (b) honestly simulate fills in a backtest.

### The math

For a hypothetical limit order placed at time `t` at price `p`:

- **Initial queue position** = total resting size at `p` at time `t` (you join at the back)
- **Position advances** as orders ahead of you are cancelled or filled
- **You fill** when cumulative trades at `p` exceed your initial position

The hard part: when an order is cancelled at price `p`, MBO tells you *which* order ID was cancelled. If it was ahead of you, your queue position improves; if behind, it doesn't. L2 data only shows total size, so you can't distinguish these cases.

Simulating this requires a full event-driven book replay: walk events forward, maintain per-order state, and for any hypothetical limit order, track its queue position event-by-event.

### Why MBO

L2 and snapshot data tell you total size at a level but not order-level identity. You cannot tell whether a cancellation removed an order ahead of or behind your hypothetical. MBO has the order IDs, so you can.

### Pros

- **The single biggest backtest-integrity unlock.** Passive-strategy backtests on bar data routinely overstate fill rates by 2–5x because they assume you fill when the price touches your level, ignoring queue
- Queue length is itself a feature: a short queue at a meaningful level means high fill probability; a very long queue means expensive optionality
- Queue depletion rate (how fast orders ahead cancel) is a regime indicator
- Enables realistic market-making and rebate-capture research

### Cons

- Heavy infrastructure: a stateful, event-driven book replay that tracks per-order state, not just aggregated levels
- CME pro-rata products (not ES, but legacy Eurodollar etc.) need different queue logic; ES being pure FIFO is the easy case
- Counterfactual problem: a real resting order from you would have changed others' behavior. Queue-aware backtests still ignore your own market impact — they are an upper bound on realism, not a perfect simulator
- Adds no value to taker/aggressor strategies — those don't queue

### Starting point

Build the book replay first (your dashboard's Book Replay tab is the skeleton). Then add: track a hypothetical resting order at the inside, log its queue position event-by-event for one day, plot the distribution of fill times and fill rates vs. starting queue position. Once that works it becomes the foundation for every passive-strategy backtest you ever run.

---

## 4. Hidden / Iceberg Liquidity Detection

### Concept

An iceberg order displays only a small visible quantity but has a larger hidden reserve that refreshes as the visible portion fills. Institutions use them to mask size. On CME there are also exchange-level iceberg implementations and the related phenomenon of **implied liquidity** — orders that exist only as legs of spread/butterfly instruments and surface in outright books.

If you trade at a price level and the visible size at that level doesn't decrease by the full trade quantity, there was hidden liquidity behind it.

### The math

Maintain visible size `V_p` at each price `p`. When a trade of size `q` prints at `p`:

```
expected_new_visible = V_p - q
actual_new_visible   = (observed after the event)
hidden_consumed      = expected_new_visible - actual_new_visible   (if > 0, hidden was present and refreshed)
```

Track cumulative hidden volume per price level over time. Persistent positive hidden volume at a level means real institutional defense of that level — not chart paint, real conviction backed by size.

### Why MBO

L1/L2 snapshots can hint at this, but only MBO gives you the order-by-order accounting needed to confidently attribute the gap to hidden liquidity rather than to a coincident new add from another participant in the same instant.

### Pros

- Reveals where conviction actually sits — visible book lies more than hidden flow does
- Anti-spoofing signal: spoofers show big, hidden liquidity is the opposite
- Useful S/R indicator: a level being defended by hidden refills is a stronger level than one with visible size that may evaporate

### Cons

- On CME, much of what *looks* like hidden is actually **implied** — orders surfacing from spread instruments. You must filter implied from outright (Databento exposes this) or you'll mis-attribute spread-induced fills to icebergs
- Truly hidden iceberg orders are rare on most CME outrights — sparse signal, hard to validate statistically
- Easy to fool yourself: many "hidden liquidity" events are just data-ordering quirks or near-simultaneous adds

### Starting point

Pick one heavily-traded day. For every trade, log `visible_before`, `visible_after`, `trade_size`, and the implied/outright flag. Bucket by price level. Look at the distribution of "size unaccounted for" *after filtering implied trades*. If clusters appear at specific price levels, that is a real signal worth pursuing.

---

## 5. Microprice

### Concept

The midpoint `(bid + ask) / 2` is the textbook fair value, but it's wrong when the book is imbalanced. If the ask has 10 contracts and the bid has 1000, the next tick is far more likely up than down — fair value lives closer to the ask.

The microprice (Stoikov, 2018) weights each side's price by the *opposite* side's size, which is the part of the book applying pressure.

### The math

```
microprice = (bid_price * ask_size + ask_price * bid_size) / (bid_size + ask_size)
```

Intuition: the heavier side "pushes" fair value toward the lighter side. Extensions:

- **Multi-level microprice** — incorporate L2/L3 depth, not just L1
- **Adjusted microprice** — Stoikov's full version uses a Markov model and converges to a probabilistic fair value rather than this naive weighting; the simple form above is a good starting approximation

### Why MBO

You *can* compute microprice from L1 snapshots, so strictly speaking it isn't MBO-exclusive. But the useful version updates on every book event, and only MBO gives you that continuous event-level book state for free. Snapshots miss the moments microprice matters most: fast, transient imbalances right before a tick move.

### Pros

- Trivial to compute
- A better midpoint for mean-reversion features, fair-value anchors, and execution decisions
- Robust across asset classes — well-studied
- Useful as a backtest reference price (closer to where you could actually transact than midpoint)

### Cons

- Sensitive to spoofing/layering on the thick side, which inflates bias toward the thin side
- Top-of-book only by default — for thick markets like ES, you may want multi-level
- Not a signal by itself, just a better number. You need to combine it with something — microprice vs. midpoint divergence, microprice momentum, microprice slope under OFI pressure

### Starting point

Compute microprice continuously, then study `microprice - midpoint` over time. Test whether large divergences predict short-horizon mid moves. If they do, you have a fast mean-reversion signal. If they don't, microprice is still worth using as the fair-value reference everywhere else in your stack.

---

## How these connect

These five aren't independent — they compose:

- **OFI + signed flow** → a sharper imbalance that incorporates adds and cancels, not just trades
- **Microprice + OFI** → microprice slope under sustained OFI pressure is a leading indicator
- **Queue dynamics + hidden detection** → distinguishing "queue advanced because of cancels" from "queue advanced because hidden fills consumed it" is necessary for accurate fill simulation
- **Queue dynamics + everything** → the backtest substrate that makes any of the others honest

If you build one thing first, build the queue-aware book replay. It pays for itself in every backtest you ever run.
