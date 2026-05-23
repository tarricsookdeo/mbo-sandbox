"""Aggregate strategy trade records into performance metrics.

Pure functions over the dict-shaped trade records produced by
``replay_runner.trades_as_records``. Kept separate from the runner so the
same metrics can score the baseline today and a feature-filtered variant
later (just diff two ``compute_metrics`` outputs).
"""
from __future__ import annotations

from collections import defaultdict

from .config import FEE_PER_SIDE_USD


def _safe_div(num: float, den: float) -> float | None:
    return num / den if den else None


def compute_metrics(trades: list[dict]) -> dict:
    """Summarize a chronologically-ordered list of trade records.

    Each trade dict must carry: pnl_usd, pnl_ticks, qty, exit_reason,
    entry_ts (ISO string, ET). Returns a JSON-able metrics dict.
    """
    n = len(trades)
    if n == 0:
        return {"trade_count": 0}

    pnls = [t["pnl_usd"] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    scratches = [p for p in pnls if p == 0]

    gross_profit = sum(wins)
    gross_loss = sum(losses)  # negative
    net_pnl = sum(pnls)
    total_fees = sum(2 * FEE_PER_SIDE_USD * t["qty"] for t in trades)

    # Equity curve & max drawdown over trades in sequence.
    equity = 0.0
    peak = 0.0
    max_dd = 0.0
    curve = []
    for p in pnls:
        equity += p
        curve.append(equity)
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)

    # Worst losing streak (count and dollars).
    streak = streak_pnl = worst_streak = worst_streak_pnl = 0
    for p in pnls:
        if p < 0:
            streak += 1
            streak_pnl += p
            if streak > worst_streak:
                worst_streak = streak
            if streak_pnl < worst_streak_pnl:
                worst_streak_pnl = streak_pnl
        else:
            streak = streak_pnl = 0

    # Breakdown by exit reason.
    by_reason: dict[str, dict] = defaultdict(lambda: {"count": 0, "net_pnl": 0.0})
    for t in trades:
        r = by_reason[t["exit_reason"]]
        r["count"] += 1
        r["net_pnl"] += t["pnl_usd"]

    # Breakdown by session date (entry date in ET).
    by_day: dict[str, dict] = defaultdict(
        lambda: {"trades": 0, "wins": 0, "net_pnl": 0.0})
    for t in trades:
        day = t["entry_ts"][:10]
        d = by_day[day]
        d["trades"] += 1
        d["net_pnl"] += t["pnl_usd"]
        if t["pnl_usd"] > 0:
            d["wins"] += 1

    day_pnls = [d["net_pnl"] for d in by_day.values()]

    return {
        "trade_count": n,
        "wins": len(wins),
        "losses": len(losses),
        "scratches": len(scratches),
        "win_rate": _safe_div(len(wins), n),
        "net_pnl_usd": net_pnl,
        "gross_pnl_usd": net_pnl + total_fees,
        "total_fees_usd": total_fees,
        "gross_profit_usd": gross_profit,
        "gross_loss_usd": gross_loss,
        "profit_factor": _safe_div(gross_profit, -gross_loss),
        "expectancy_usd": net_pnl / n,
        "avg_win_usd": _safe_div(gross_profit, len(wins)),
        "avg_loss_usd": _safe_div(gross_loss, len(losses)),
        "payoff_ratio": _safe_div(
            _safe_div(gross_profit, len(wins)) or 0,
            -(_safe_div(gross_loss, len(losses)) or 0) or float("nan"),
        ),
        "largest_win_usd": max(pnls),
        "largest_loss_usd": min(pnls),
        "avg_pnl_ticks": sum(t["pnl_ticks"] for t in trades) / n,
        "max_drawdown_usd": max_dd,
        "worst_losing_streak": worst_streak,
        "worst_losing_streak_usd": worst_streak_pnl,
        "trading_days": len(by_day),
        "avg_daily_pnl_usd": _safe_div(sum(day_pnls), len(by_day)),
        "best_day_usd": max(day_pnls),
        "worst_day_usd": min(day_pnls),
        "green_days": sum(1 for p in day_pnls if p > 0),
        "red_days": sum(1 for p in day_pnls if p < 0),
        "by_exit_reason": dict(by_reason),
        "by_day": dict(sorted(by_day.items())),
        "equity_curve": curve,
    }


def _fmt(value, money: bool = False, pct: bool = False) -> str:
    if value is None:
        return "n/a"
    if pct:
        return f"{value * 100:.1f}%"
    if money:
        return f"${value:+,.2f}"
    return f"{value:.2f}"


def format_report(m: dict) -> str:
    """Render a human-readable metrics report."""
    if m.get("trade_count", 0) == 0:
        return "No trades."

    lines = ["=== Performance Summary ==="]
    rows = [
        ("Trades", str(m["trade_count"])),
        ("Win rate", f"{_fmt(m['win_rate'], pct=True)} "
                     f"({m['wins']}W / {m['losses']}L / {m['scratches']}S)"),
        ("Net P&L", _fmt(m["net_pnl_usd"], money=True)),
        ("Gross P&L", _fmt(m["gross_pnl_usd"], money=True)),
        ("Fees paid", _fmt(-m["total_fees_usd"], money=True)),
        ("Profit factor", _fmt(m["profit_factor"])),
        ("Expectancy/trade", _fmt(m["expectancy_usd"], money=True)),
        ("Avg win / loss", f"{_fmt(m['avg_win_usd'], money=True)} / "
                           f"{_fmt(m['avg_loss_usd'], money=True)}"),
        ("Payoff ratio", _fmt(m["payoff_ratio"])),
        ("Largest win / loss", f"{_fmt(m['largest_win_usd'], money=True)} / "
                               f"{_fmt(m['largest_loss_usd'], money=True)}"),
        ("Avg P&L (ticks)", _fmt(m["avg_pnl_ticks"])),
        ("Max drawdown", _fmt(-m["max_drawdown_usd"], money=True)),
        ("Worst losing streak", f"{m['worst_losing_streak']} trades "
                                f"({_fmt(m['worst_losing_streak_usd'], money=True)})"),
    ]
    width = max(len(label) for label, _ in rows)
    for label, val in rows:
        lines.append(f"  {label:<{width}}  {val}")

    lines.append("")
    lines.append(f"=== Daily ({m['trading_days']} sessions) ===")
    lines.append(f"  Avg/day: {_fmt(m['avg_daily_pnl_usd'], money=True)}  |  "
                 f"green {m['green_days']} / red {m['red_days']}  |  "
                 f"best {_fmt(m['best_day_usd'], money=True)}  |  "
                 f"worst {_fmt(m['worst_day_usd'], money=True)}")

    lines.append("")
    lines.append("=== By Exit Reason ===")
    reasons = sorted(m["by_exit_reason"].items(),
                     key=lambda kv: kv[1]["net_pnl"], reverse=True)
    rwidth = max((len(r) for r, _ in reasons), default=6)
    for reason, stat in reasons:
        lines.append(f"  {reason:<{rwidth}}  {stat['count']:>3} trades  "
                     f"{_fmt(stat['net_pnl'], money=True)}")

    lines.append("")
    lines.append("=== By Day ===")
    for day, stat in m["by_day"].items():
        lines.append(f"  {day}  {stat['trades']:>2} trades  "
                     f"{stat['wins']}W  {_fmt(stat['net_pnl'], money=True)}")

    return "\n".join(lines)
