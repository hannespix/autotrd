"""
broker — execution abstraction so the strategy is decoupled from where orders go.

Two backends behind one interface:
  * PaperBroker  — the built-in local simulation (positions.json / trade_log.json).
                   Zero setup, the default. Behaves exactly like before.
  * AlpacaBroker — a real brokerage account via alpaca-py. Defaults to Alpaca's
                   PAPER endpoint (fake money, identical API to live). Going live
                   is a deliberate, guarded opt-in.

Switch via strategy.yaml:
    broker:
      provider: paper        # or: alpaca
      mode: paper            # alpaca only: paper | live   (live is hard-guarded)
      initial_capital: 25000 # paper sim only

API keys are read from the environment or ~/.hermes/.env — this module NEVER
stores or logs them:
    ALPACA_API_KEY / ALPACA_SECRET_KEY   (also accepts APCA_API_KEY_ID / APCA_API_SECRET_KEY)

SAFETY: live trading requires BOTH mode=live AND env ALPACA_ALLOW_LIVE=1. Without
the explicit allow-flag, a 'live' request is refused and downgraded to paper.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

TRADING_DIR = Path.home() / ".hermes" / "trading"


class BrokerError(Exception):
    pass


# ── env / key loading (never logged) ─────────────────────────────────────────

def _load_env_file():
    """Populate os.environ from ~/.hermes/.env for keys not already set."""
    envp = Path.home() / ".hermes" / ".env"
    if not envp.exists():
        return
    try:
        for line in envp.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            if k not in os.environ:
                os.environ[k] = v.strip().strip('"').strip("'")
    except Exception:
        pass


def _alpaca_keys():
    _load_env_file()
    key = os.environ.get("ALPACA_API_KEY") or os.environ.get("APCA_API_KEY_ID")
    sec = os.environ.get("ALPACA_SECRET_KEY") or os.environ.get("APCA_API_SECRET_KEY")
    return key, sec


# ── interface ────────────────────────────────────────────────────────────────

class Broker:
    provider = "base"
    mode = "paper"

    def connected(self) -> bool:
        return True

    def status(self) -> dict:
        try:
            acct = self.get_account()
        except Exception as exc:
            acct = {"error": str(exc)}
        return {"provider": self.provider, "mode": self.mode,
                "connected": self.connected(), "account": acct}

    def get_account(self) -> dict:
        raise NotImplementedError

    def get_positions(self) -> dict:
        raise NotImplementedError

    def submit_order(self, symbol: str, side: str, qty: int, price: float | None = None) -> dict:
        raise NotImplementedError

    def close_position(self, symbol: str) -> dict:
        raise NotImplementedError


# ── local paper simulation (unchanged behaviour) ─────────────────────────────

class PaperBroker(Broker):
    provider = "paper"
    mode = "paper"

    def __init__(self, strategy: dict | None = None):
        self.strategy = strategy or {}

    @staticmethod
    def _load(name, default):
        p = TRADING_DIR / name
        if p.exists():
            try:
                return json.loads(p.read_text())
            except Exception:
                pass
        return default

    @staticmethod
    def _save(name, data):
        (TRADING_DIR / name).write_text(json.dumps(data, indent=2, default=str))

    def get_account(self) -> dict:
        capital = float(self.strategy.get("broker", {}).get("initial_capital", 25000))
        log = self._load("trade_log.json", [])
        closed = sum(t.get("pnl", 0) for t in log if "pnl" in t)
        return {"cash": round(capital + closed, 2), "equity": round(capital + closed, 2),
                "buying_power": round(capital + closed, 2), "currency": "USD", "simulated": True}

    def get_positions(self) -> dict:
        return self._load("positions.json", {})

    def submit_order(self, symbol, side, qty, price=None):
        # kept for completeness; the engine already owns paper execution/persistence
        return {"ok": True, "provider": "paper", "symbol": symbol, "side": side,
                "qty": qty, "price": price, "ts": datetime.now().isoformat()}

    def close_position(self, symbol):
        return {"ok": True, "provider": "paper", "symbol": symbol, "closed": True}


# ── Alpaca (paper by default, live hard-guarded) ─────────────────────────────

class AlpacaBroker(Broker):
    provider = "alpaca"

    def __init__(self, mode: str = "paper"):
        key, sec = _alpaca_keys()
        if not key or not sec:
            raise BrokerError("Keine Alpaca-Keys (ALPACA_API_KEY / ALPACA_SECRET_KEY) in ~/.hermes/.env gefunden.")

        want_live = str(mode).lower() == "live"
        if want_live and os.environ.get("ALPACA_ALLOW_LIVE") != "1":
            # refuse un-flagged live → downgrade to paper
            want_live = False
            self._downgraded = True
        else:
            self._downgraded = False
        self.mode = "live" if want_live else "paper"

        try:
            from alpaca.trading.client import TradingClient
            self._client = TradingClient(key, sec, paper=(self.mode != "live"))
        except Exception as exc:
            raise BrokerError(f"Alpaca-Verbindung fehlgeschlagen: {exc}")

    def connected(self) -> bool:
        try:
            self._client.get_account()
            return True
        except Exception:
            return False

    def get_account(self) -> dict:
        a = self._client.get_account()
        return {
            "cash": float(a.cash), "equity": float(a.equity),
            "buying_power": float(a.buying_power), "portfolio_value": float(a.portfolio_value),
            "currency": getattr(a, "currency", "USD"), "simulated": self.mode != "live",
            "account_number": getattr(a, "account_number", None),
            "downgraded_from_live": getattr(self, "_downgraded", False),
        }

    def get_positions(self) -> dict:
        out = {}
        for p in self._client.get_all_positions():
            out[p.symbol] = {
                "qty": int(float(p.qty)), "entry_price": float(p.avg_entry_price),
                "live_price": float(p.current_price) if getattr(p, "current_price", None) else None,
                "unrealized_pnl": float(p.unrealized_pl) if getattr(p, "unrealized_pl", None) else None,
                "change_pct": round(float(p.unrealized_plpc) * 100, 2) if getattr(p, "unrealized_plpc", None) else None,
                "market_value": float(p.market_value) if getattr(p, "market_value", None) else None,
            }
        return out

    def submit_order(self, symbol, side, qty, price=None):
        from alpaca.trading.requests import MarketOrderRequest
        from alpaca.trading.enums import OrderSide, TimeInForce
        req = MarketOrderRequest(
            symbol=symbol, qty=qty,
            side=OrderSide.BUY if side.lower() == "buy" else OrderSide.SELL,
            time_in_force=TimeInForce.DAY)
        o = self._client.submit_order(req)
        return {"ok": True, "provider": "alpaca", "mode": self.mode, "order_id": str(o.id),
                "symbol": symbol, "side": side, "qty": qty, "status": str(o.status)}

    def close_position(self, symbol):
        o = self._client.close_position(symbol)
        return {"ok": True, "provider": "alpaca", "symbol": symbol, "order_id": str(getattr(o, "id", ""))}


# ── factory ──────────────────────────────────────────────────────────────────

def get_broker(strategy: dict | None = None) -> Broker:
    strategy = strategy or {}
    cfg = strategy.get("broker", {})
    provider = str(cfg.get("provider", "paper")).lower()
    if provider == "alpaca":
        try:
            return AlpacaBroker(mode=cfg.get("mode", "paper"))
        except BrokerError as exc:
            # graceful: log the reason and fall back to the local sim
            print(f"⚠️  Alpaca nicht verbunden ({exc}) → lokale Paper-Simulation.")
    return PaperBroker(strategy)


if __name__ == "__main__":
    import yaml
    sp = TRADING_DIR / "strategy.yaml"
    strat = yaml.safe_load(sp.read_text()) if sp.exists() else {}
    b = get_broker(strat)
    print(json.dumps(b.status(), indent=2, ensure_ascii=False))
