This is the pinescript code for the strategy.

```pinescript
//@version=5
indicator("Mean indicator (dot version) — Pine v5 port", overlay=true)

// ===== Inputs (mirror of Lua params) =====
tf      = input.timeframe("D", "Anchor Timeframe (TF)")    // Lua default: "D1"
src     = input.source(close, "Source")
clrUP   = input.color(color.lime,  "UP Color")
clrDN   = input.color(color.red,   "DN Color")
clrPrev = input.color(color.blue,  "Prev Color")
dotSize = input.int(3, "Dot Size (linewidth)", minval=1, maxval=5)

// ===== Detect start of a new anchor TF candle (Lua used core.getcandle + bookmarks) =====
isNewTF = nz(ta.change(time(tf))) != 0  // true on the first bar of each new TF candle

// ===== Running mean from the start of current TF candle to "now" (Lua used core.avg(range)) =====
var float cum   = na
var int   count = na

// Reset/accumulate per anchor TF
if barstate.isfirst or isNewTF
    cum   := src
    count := 1
else
    cum   += src
    count += 1

buff = cum / count  // this is Buff[period] in Lua

// ===== PrevBuff: flat line at the LAST value of the previous TF's mean (Lua: Buff[start-1]) =====
var float prevTFBuff = na
if isNewTF and not na(buff[1])
    // when a new TF begins, capture the terminal mean from the prior TF
    prevTFBuff := buff[1]

prevBuff = prevTFBuff  // shown as dots across current TF

// ===== Direction-based dot coloring (same inheritance behavior as Lua) =====
var int dir = 0  // 1 = rising, -1 = falling, 0 = unknown (first bar)
dir := na(buff[1]) ? dir : buff > buff[1] ? 1 : buff < buff[1] ? -1 : dir[1]

// ===== Plots (dot-style) =====
plot(dir == 1 ? buff : na, title="MeanUP", color=clrUP,  style=plot.style_circles, linewidth=dotSize)
plot(dir == -1 ? buff : na, title="MeanDN", color=clrDN, style=plot.style_circles, linewidth=dotSize)
plot(prevBuff, title="Prev", color=clrPrev, style=plot.style_circles, linewidth=dotSize)

// ===== Optional Alerts (match to your trading rules if needed) =====
alertcondition(dir == 1 and dir[1] != 1, "Mean Rising",  "Mean turned UP this bar")
alertcondition(dir == -1 and dir[1] != -1, "Mean Falling", "Mean turned DOWN this bar")
```

These are the rules for the strategy in plain English:
### Instruments & Session

- Trade **MNQ, MES, MGC, and MCL** simultaneously, independently. All four are CME/NYMEX micros (Micro Nasdaq, Micro S&P, Micro Gold, Micro WTI Crude). MGC and MCL were added after the original MNQ/MES build; their `max_stop_ticks` caps in `engine/config.py` are placeholder values and have not been replay-calibrated.
- Session: **09:45 ET → 15:00 ET** (RTH only, skip first 15 minutes)
- No new entries after **15:00 ET**
- Hard flatten all positions at **15:45 ET** regardless of P&L
- No overnight positions under any circumstances

---

### Indicator Definitions

|Indicator|Settings|Notes|
|---|---|---|
|`buff`|Cumulative mean of close, resets daily|The running mean|
|`prev_buff`|Terminal `buff` value from prior Globex day|Prior session's settled mean — used by entry rules and exits|
|`weekly_prev_buff`|Terminal `buff` value from prior Globex week|Reference level used only for position-sizing confluence; does not drive entries|
|`monthly_prev_buff`|Terminal `buff` value from prior calendar month|Reference level used only for position-sizing confluence; does not drive entries|
|`dir`|1 = rising, -1 = falling, 0 = unknown|Inherited when flat|
|`atr`|ATR(14), 5m bars|Used for proximity, stops, gap filter|
|`rsi`|RSI(14), 5m bars|Entry timing filter|

The weekly and monthly indicator states run in parallel to the daily one — same accumulator logic, just anchored to the Globex week (Sun 18:00 ET → Fri 17:00 ET) or the calendar month respectively. Their `buff` is not consulted; only their captured `prev_buff` is used as a fixed reference for the duration of the current week/month.

---

### Pre-Session Checks (Run at 09:45 ET Before First Trade)

These run once per instrument per day before any entry is allowed:

1. **Gap filter** — if `abs(09:45 open − buff) > 1.5 × ATR`, mark instrument as **skip first trade**. Re-evaluate on each bar until gap closes below threshold before allowing entries.
2. **`dir` must not be 0** — if direction is unknown (insufficient data), no entries allowed until it resolves.
3. **`prev_buff` must not be None** — if there is no prior session data, no entries on that instrument for the day.

---

### Entry Rules

#### Long Entry

All 5 conditions must be true on the same bar:

1. `dir == 1` (mean is rising)
2. Price pulled back to within `1 × ATR` of `buff` from **above** (i.e. `buff ≤ close ≤ buff + 1×ATR`)
3. `RSI(14) < 50` on the pullback bar
4. The bar **closes above `buff`** (crossed back through from below during the bar, or held above)
5. `prev_close < buff` — prior bar was below or at `buff` (confirms the cross, not just proximity)

**Entry execution:** Enter at open of the next bar after trigger bar closes.

---

#### Short Entry

Mirror of long, all 5 must be true:

1. `dir == -1` (mean is falling)
2. Price rallied to within `1 × ATR` of `buff` from **below** (i.e. `buff − 1×ATR ≤ close ≤ buff`)
3. `RSI(14) > 50` on the rally bar
4. The bar **closes below `buff`**
5. `prev_close > buff` — prior bar was above or at `buff`

**Entry execution:** Enter at open of the next bar after trigger bar closes.

---

### Position Sizing — Confluence-Based

Once an entry signal fires (always a daily `buff` cross — see Entry Rules above), the **number of contracts** is determined by how many higher-timeframe references agree with the trade direction. The signal trigger is unchanged; sizing is layered on top.

|Confluence|Long check|Short check|Contracts|
|---|---|---|---|
|Daily cross only (baseline)|signal fired|signal fired|**1**|
|Daily + weekly agreement|`close > weekly_prev_buff`|`close < weekly_prev_buff`|**+1**|
|Daily + monthly agreement|`close > monthly_prev_buff`|`close < monthly_prev_buff`|**+1**|

The contract count is summed: minimum **1** (daily only), maximum **3** (all three timeframes agree). If a higher-TF reference is `None` (instrument hasn't accumulated a prior week or month yet, e.g. a newly-added symbol like MCL early in its data window), it contributes nothing — no penalty, just no boost.

**Rationale:** alignment across timeframes is a momentum-confluence signal. The longer the timeframe whose reference the price is on the right side of, the stronger the directional support for the trade.

**Implications:**

- All bracket components (stop, target, R-multiple, breakeven trigger) are per-contract — they don't change with size. Only realized and unrealized $-P&L scale linearly with contract count.
- The daily loss limit is in dollars, not trades — so a 3-contract loser uses up the budget 3× faster than a 1-contract loser. With the current $1000 cap and typical micros, a single max-size losing trade can be a meaningful fraction of the day's budget.

---

### Stop Loss Rules

#### Initial Stop Placement

```
Long stop  = buff − (0.5 × ATR)
Short stop = buff + (0.5 × ATR)
```

Anchored to the current session's running mean (`buff`), not the prior
session's terminal mean. (Initial draft used `prev_buff`; replay showed that
produced stops hundreds of ticks wide and frequently on the wrong side of
entry — superseded.)

#### Stop Adjustment (Trailing)

- Once position is up **1R**, move stop to **breakeven (entry price)**
- Stop never moves against the position after breakeven is set
- If `buff` crosses back through entry price before 1R is reached, exit immediately (see Exit Rule 3)

---

### Take Profit Rules

#### Primary Target

```
Target = entry + (2 × risk)    // Long
Target = entry − (2 × risk)    // Short
```

Where `risk = abs(entry − initial stop)`

#### Partial Exit Option (Optional, Not Required)

- Exit 50% at 1R, move stop to breakeven, let remainder run to 2R
- Only implement this if backtesting shows it improves expectancy — do not assume it does

---

### Exit Rules — All Conditions

Exits are checked on every bar close while in a position. First condition triggered wins.

|Priority|Condition|Action|
|---|---|---|
|1|Hard flatten time (15:45 ET)|Exit full position at market immediately|
|2|Target hit (2R)|Exit full position at limit|
|3|Stop hit|Exit full position at stop price|
|4|`buff` crosses back against position before 1R|Exit full position at market on bar close|
|5|`dir` flips against position|Exit full position at market on bar close|
|6|No new entries after 15:00 ET, but **hold existing position** until stop, target, or 15:45 flatten||

**Priority 4 detail:**

- Long position: if `close < buff` before 1R is reached → exit
- Short position: if `close > buff` before 1R is reached → exit
- After breakeven stop is set, this rule is superseded by the stop

**Priority 5 detail:**

- `dir` flip is a strong invalidation signal — the structural reason for the trade no longer exists
- Do not wait for stop or target, exit on the close of the bar where flip is confirmed

---

### Risk Rules

#### Per Trade

- Max risk per trade: defined by initial stop distance, not a fixed tick amount
- Per-instrument tick caps — if initial stop distance exceeds the cap, **skip the trade** (stop is too wide, likely a volatile session):

|Instrument|Cap|Calibrated?|
|---|---|---|
|MNQ|100 ticks|90-day replay (raised from spec's 20)|
|MES|50 ticks|90-day replay (raised from spec's 10)|
|MGC|200 ticks|Placeholder — not replay-calibrated|
|MCL|200 ticks|Placeholder — not replay-calibrated|

The MNQ/MES caps were relaxed from much tighter initial drafts (20/10) after a 90-day replay showed those were 5–18× tighter than what `buff ± 0.5×ATR` actually produces. MGC and MCL haven't been put through the same replay — their caps are conservative-but-untested.

The cap is on **per-contract** stop distance, not total dollar risk; it doesn't change with the size selected by confluence.

#### Per Day (Shared Across All Instruments)

- Max trades per day: **3 per instrument** (12 total across all 4 instruments). One "trade" counts whether it was 1, 2, or 3 contracts.
- Max daily loss: **$1000 USD combined** across all instruments (`DAILY_LOSS_LIMIT_USD` in `engine/config.py`). Cap unchanged when confluence sizing was added — a 3-contract loser eats the budget 3× as fast as a 1-contract loser, so the gate fires sooner in practice.
- After 2 consecutive losses on any instrument: **pause that instrument** for 30 minutes before allowing re-entry
- After daily loss limit hit: **halt all trading for the day**, flatten any open positions

#### Gap Filter (Revisited Intraday)

- If a large gap existed at 09:45 and closed during the session, entries are permitted once `abs(close − buff) ≤ 1.5 × ATR` for 2 consecutive bars

---

### Manual Override Rules

These take absolute priority over all strategy logic:

|Command|Behavior|
|---|---|
|`pause`|No new entries on either instrument. Open positions continue to be managed normally.|
|`resume`|Re-enables entries if session time and risk limits allow|
|`flatten`|Immediately market-exit all open positions on both instruments, no new entries until `resume`|
|`set_param`|Updates a config value (e.g. max trades). Takes effect on next bar.|

---

### Conditions Where No Trade Is Taken (Summary)

1. Outside session window
2. `dir == 0` (unknown direction)
3. `prev_buff` is None (no prior session)
4. Gap filter active and not yet resolved
5. Daily loss limit reached
6. Max trades per day reached for that instrument
7. Instrument is in 30-minute pause after 2 consecutive losses
8. Risk per trade exceeds max tick threshold
9. `trading_enabled == False` (manual pause)
10. Already in a position on that instrument