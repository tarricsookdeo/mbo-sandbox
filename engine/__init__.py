"""Headless strategy engine for the MBO sandbox.

Layered modules:
    config        contract specs, session windows, risk limits, indicator params
    bars          5-min OHLCV aggregator that consumes MBO trade events
    indicators    buff (per-session cumulative mean), ATR, RSI, dir
    strategy      entry/exit state machine implementing STRATEGY.md
    replay_runner orchestrator that walks Parquet events and emits a timeline
"""
