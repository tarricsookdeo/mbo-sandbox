"""Order-by-order (L3) book reconstruction from MBO events.

A faithful Python port of the dashboard's Book Replay logic
(dashboard/app.js: applyReplayEvent), with O(log n) best-bid/ask access so
it can run over the full multi-million-event stream rather than a paginated
window.

Event semantics (Databento MBO, CME MDP3):
  R  snapshot/clear   -> wipe the book
  A  add              -> insert resting order at (side, price, size)
  C  cancel           -> reduce an order's size by event.size (partial ok)
  M  modify           -> remove the order, re-insert at new price/size
  T  trade            -> aggressor print; does NOT change resting state
  F  fill             -> informational trade-against-order; does NOT change
                         resting state on its own
  N  none             -> no-op

Prices are kept as the raw Int64 fixed-point integers (1 unit = 1e-9) so
level keys compare exactly with no float error. Use PRICE_SCALE to convert
to a display price only when needed.

NOTE on F handling: in this CME MDP3 / Databento normalization, F is an
informational fill notice — the liquidity it represents is removed by a
SEPARATE C (cancel) or M (modify) message. Reducing the book on F as well
double-counts: it deletes the order early, so the real C that follows
references a missing order. Validated empirically — treating F as a size
reduction produced ~1.5M dangling cancels/day (≈ the F count); treating it
as a no-op (as the dashboard does) eliminates them.
"""
from __future__ import annotations

from dataclasses import dataclass

from sortedcontainers import SortedDict

from .config import PRICE_SCALE

# Databento sentinel for an undefined price (Int64 max).
UNDEF_PRICE = 9223372036854775807


@dataclass
class _Order:
    __slots__ = ("side", "price", "size")
    side: str   # "B" or "A"
    price: int  # raw fixed-point int
    size: int


@dataclass
class Level:
    """Aggregated state at one price level."""
    price: int    # raw fixed-point int
    size: int     # total resting size
    count: int    # number of resting orders

    @property
    def price_display(self) -> float:
        return self.price / PRICE_SCALE


class OrderBook:
    """Single-instrument L3 book. Feed events in timestamp/sequence order."""

    def __init__(self) -> None:
        self.orders: dict[int, _Order] = {}
        # bids: descending best-first via negated-key peek; asks: ascending.
        self._bids: SortedDict = SortedDict()   # price -> [size, count]
        self._asks: SortedDict = SortedDict()   # price -> [size, count]
        self.last_ts: int | None = None

    # ----- level bookkeeping -----

    def _levels(self, side: str) -> SortedDict:
        return self._bids if side == "B" else self._asks

    def _adjust_level(self, side: str, price: int,
                      size_delta: int, count_delta: int) -> None:
        levels = self._levels(side)
        cur = levels.get(price)
        if cur is None:
            cur = [0, 0]
        cur[0] += size_delta
        cur[1] += count_delta
        if cur[0] <= 0 or cur[1] <= 0:
            levels.pop(price, None)
        else:
            levels[price] = cur

    def _remove_order(self, order_id: int) -> _Order | None:
        existing = self.orders.pop(order_id, None)
        if existing is None:
            return None
        self._adjust_level(existing.side, existing.price, -existing.size, -1)
        return existing

    def _add_order(self, order_id: int, side: str, price: int, size: int) -> bool:
        if side not in ("B", "A") or price == UNDEF_PRICE or size <= 0:
            return False
        # An add re-using a live id replaces it (matches app.js).
        self._remove_order(order_id)
        self.orders[order_id] = _Order(side, price, size)
        self._adjust_level(side, price, size, 1)
        return True

    def _reduce_order(self, order_id: int, reduce_size: int) -> None:
        """Shrink a resting order by reduce_size (cancel or fill)."""
        order = self.orders.get(order_id)
        if order is None:
            return
        amt = min(reduce_size, order.size)
        full = amt >= order.size
        self._adjust_level(order.side, order.price, -amt, -1 if full else 0)
        order.size -= amt
        if order.size <= 0:
            self.orders.pop(order_id, None)

    # ----- event application -----

    def apply(self, action: str, side: str, price: int,
              size: int, order_id: int, ts: int | None = None) -> None:
        if ts is not None:
            self.last_ts = ts

        if action == "A":
            self._add_order(order_id, side, price, size)
        elif action == "C":
            self._reduce_order(order_id, size)
        elif action == "M":
            self._remove_order(order_id)
            self._add_order(order_id, side, price, size)
        elif action == "R":
            self.clear()
        # "T", "F", and "N": no resting-state change (see module docstring).

    def clear(self) -> None:
        self.orders.clear()
        self._bids.clear()
        self._asks.clear()

    # ----- accessors -----

    def best_bid(self) -> Level | None:
        if not self._bids:
            return None
        price = self._bids.keys()[-1]          # highest bid
        size, count = self._bids[price]
        return Level(price, size, count)

    def best_ask(self) -> Level | None:
        if not self._asks:
            return None
        price = self._asks.keys()[0]           # lowest ask
        size, count = self._asks[price]
        return Level(price, size, count)

    def bids(self, depth: int = 10) -> list[Level]:
        out = []
        for price in reversed(self._bids.keys()[-depth:]):
            size, count = self._bids[price]
            out.append(Level(price, size, count))
        return out

    def asks(self, depth: int = 10) -> list[Level]:
        out = []
        for price in self._asks.keys()[:depth]:
            size, count = self._asks[price]
            out.append(Level(price, size, count))
        return out

    # ----- derived microstructure quantities -----

    def mid(self) -> float | None:
        b, a = self.best_bid(), self.best_ask()
        if b is None or a is None:
            return None
        return (b.price + a.price) / 2 / PRICE_SCALE

    def spread_ticks(self, tick_size: float) -> float | None:
        b, a = self.best_bid(), self.best_ask()
        if b is None or a is None:
            return None
        return (a.price - b.price) / PRICE_SCALE / tick_size

    def imbalance(self) -> float | None:
        """Top-of-book size imbalance in [-1, 1]: +1 all bid, -1 all ask."""
        b, a = self.best_bid(), self.best_ask()
        if b is None or a is None:
            return None
        denom = b.size + a.size
        return (b.size - a.size) / denom if denom else 0.0

    def microprice(self) -> float | None:
        """Size-weighted fair value: leans toward the heavier side's quote."""
        b, a = self.best_bid(), self.best_ask()
        if b is None or a is None:
            return None
        denom = b.size + a.size
        if not denom:
            return self.mid()
        # weight each quote by the size on the OPPOSITE side
        micro = (a.price * b.size + b.price * a.size) / denom
        return micro / PRICE_SCALE
