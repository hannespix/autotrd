"""
Trading Engine — Automatisierte Paper-Trading Logik
Prüft Signale basierend auf RSI, MACD, BBands + Konfluenz-Logik
Führt Paper-Trades aus, verwaltet Portfolio, Stop-Loss/Take-Profit
"""
import json
import yaml  # type: ignore
import sys
from pathlib import Path
from datetime import datetime

# Ensure imports work
_skill_dir = Path(__file__).resolve().parent.parent  # daytrading/
_ta_dir = _skill_dir / "technical-analysis" / "scripts"
for _p in [_skill_dir, _ta_dir]:
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from market_data import fetch_price


class TradingEngine:
    """Core auto-trading engine with paper trading and risk management."""

    @staticmethod
    def _data_path(name):
        return Path.home() / ".hermes" / "trading" / name

    def __init__(self):
        self.strategy = self._load_strategy()
        self.broker = self._make_broker()
        # Alpaca is the source of truth for its own positions; paper uses local file.
        if getattr(self.broker, "provider", "paper") == "alpaca":
            try:
                self.positions = self.broker.get_positions()
            except Exception:
                self.positions = {}
        else:
            self.positions = self._load_json("positions.json", {})
        self.trade_log = self._load_json("trade_log.json", [])
        self.running = False

    def _make_broker(self):
        try:
            import broker
            return broker.get_broker(self.strategy)
        except Exception as exc:
            print(f"⚠️  Broker-Init fehlgeschlagen ({exc}) → lokale Paper-Simulation.")
            import broker
            return broker.PaperBroker(self.strategy)

    # ── Data Persistence ────────────────────────────

    @staticmethod
    def _load_json(name, default=None):
        if default is None:
            default = {}
        p = Path.home() / ".hermes" / "trading" / name
        if p.exists():
            try:
                return json.loads(p.read_text())
            except Exception:
                pass
        return default

    @staticmethod
    def _save_json(name, data):
        p = Path.home() / ".hermes" / "trading" / name
        p.write_text(json.dumps(data, indent=2, default=str))

    def _load_strategy(self):
        sp = Path.home() / ".hermes" / "trading" / "strategy.yaml"
        if sp.exists():
            return yaml.safe_load(sp.read_text())
        return {}

    # ── Portfolio State ─────────────────────────────

    @property
    def portfolio(self):
        """Current portfolio state with live P&L."""
        if getattr(self, "broker", None) and self.broker.provider == "alpaca":
            return self._alpaca_portfolio()

        broker = self.strategy.get("broker", {})
        capital = float(broker.get("initial_capital", 25000))

        open_pnl = 0.0
        pos_summary = {}
        for sym, pos in self.positions.items():
            try:
                live = fetch_price(sym)
                live_price = live.get("price", 0) if live else 0
                cost = float(pos.get("entry_price", 0))
                qty = int(pos.get("qty", 0))
                pnl = (live_price - cost) * qty
                change_pct = ((live_price / cost) - 1) * 100 if cost else 0
                pos_summary[sym] = {
                    **pos,
                    "live_price": live_price,
                    "unrealized_pnl": round(pnl, 2),
                    "change_pct": round(change_pct, 2),
                }
                open_pnl += pnl
            except Exception:
                pos_summary[sym] = pos

        closed_pnls = [t.get("pnl", 0) for t in self.trade_log if "pnl" in t]
        total_closed = sum(closed_pnls)
        wins = sum(1 for p in closed_pnls if p > 0)
        wr = (wins / max(len(closed_pnls), 1)) * 100

        return {
            "base_capital": capital,
            "current_equity": round(capital + total_closed + open_pnl, 2),
            "total_pnl": round(total_closed + open_pnl, 2),
            "unrealized_pnl": round(open_pnl, 2),
            "closed_pnl": round(total_closed, 2),
            "win_rate": round(wr, 1),
            "positions": pos_summary,
        }

    def _alpaca_portfolio(self):
        """Portfolio built from the live Alpaca account (paper or live)."""
        try:
            acct = self.broker.get_account()
            pos = self.broker.get_positions()
            equity = float(acct.get("equity", 0))
            unreal = round(sum((p.get("unrealized_pnl") or 0) for p in pos.values()), 2)
            return {
                "base_capital": round(equity - unreal, 2),
                "current_equity": round(equity, 2),
                "total_pnl": unreal, "unrealized_pnl": unreal, "closed_pnl": 0,
                "win_rate": 0.0, "positions": pos,
                "provider": "alpaca", "mode": self.broker.mode,
                "buying_power": acct.get("buying_power"),
            }
        except Exception as exc:
            return {"base_capital": 0, "current_equity": 0, "total_pnl": 0,
                    "unrealized_pnl": 0, "closed_pnl": 0, "win_rate": 0,
                    "positions": {}, "provider": "alpaca", "error": str(exc)}

    # ── Signal Detection ────────────────────────────

    def _analyze_ticker(self, ticker):
        """Run all enabled indicators for a ticker. Return signal strength."""
        ind_cfg = self.strategy.get("indicators", {})
        conf_req = self.strategy.get("signals", {}).get("min_confluence", 2)
        period = self.strategy.get("signals", {}).get("period", "3mo")

        buy_votes = 0
        sell_votes = 0
        details = {}

        try:
            import technical_analysis as ta

            # RSI Signal
            if ind_cfg.get("rsi", {}).get("enabled"):
                rsi_cfg = ind_cfg["rsi"]
                rsi_val = float(ta.rsi(ticker, ticker=ticker, period=period).get("current_rsi", 50))
                details["rsi"] = round(rsi_val, 1)
                if rsi_val < rsi_cfg.get("threshold_buy", 30):
                    buy_votes += 1
                elif rsi_val > rsi_cfg.get("threshold_sell", 70):
                    sell_votes += 1

            # MACD Signal
            if ind_cfg.get("macd", {}).get("enabled"):
                macd_data = ta.macd(ticker, ticker=ticker, period=period)
                line = float(macd_data.get("macd_line", 0))
                signal_val = float(macd_data.get("signal_line", 0))
                details["macd"] = {"line": round(line, 3), "signal": round(signal_val, 3)}
                if ind_cfg["macd"].get("crossover_buy"):
                    hist = macd_data.get("histogram", 0)
                    if line > signal_val and hist > 0:
                        buy_votes += 1
                    elif line < signal_val and hist < 0:
                        sell_votes += 1

            # Bollinger Bands Signal
            if ind_cfg.get("bollinger", {}).get("enabled"):
                bb_data = ta.bollinger_bands(ticker, ticker=ticker, period=period)
                upper = float(bb_data.get("upper", 0))
                lower = float(bb_data.get("lower", 0))
                live = fetch_price(ticker)
                price = float(live.get("price", 0)) if live else 0
                bb_range = upper - lower or 1e-9
                pct = ((price - lower) / bb_range) * 100
                details["bb_pct"] = round(pct, 1)
                bb_threshold = ind_cfg["bollinger"].get("bb_breakout_pct", 95)
                if pct > bb_threshold:
                    sell_votes += 1
                elif pct < (100 - bb_threshold):
                    buy_votes += 1

        except Exception as e:
            details["error"] = str(e)

        # ── Forecast signal (the heart): the self-tuned, sentiment-weighted price
        # forecast is a first-class, strongly-weighted input to the trade decision.
        sig_cfg = self.strategy.get("signals", {})
        if sig_cfg.get("use_forecast", True):
            fc_vote, fc_det = self._forecast_vote(ticker)
            fc_weight = int(sig_cfg.get("forecast_weight", 2))
            details["forecast"] = fc_det
            if fc_vote > 0:
                buy_votes += fc_weight
            elif fc_vote < 0:
                sell_votes += fc_weight

        # Decision
        if buy_votes >= conf_req and buy_votes > sell_votes:
            decision = "BUY"
        elif sell_votes >= conf_req and sell_votes > buy_votes:
            decision = "SELL"
        else:
            decision = "HOLD"

        return {
            "ticker": ticker,
            "decision": decision,
            "buy_signals": buy_votes,
            "sell_signals": sell_votes,
            "required_confluence": conf_req,
            "indicators": details,
        }

    def _forecast_vote(self, ticker):
        """Directional vote from the self-tuned, sentiment-weighted forecast.
        Returns (+1 buy / -1 sell / 0 hold, detail dict). Also logs shadow forecasts
        so the self-improvement loop keeps learning from watchlist scans."""
        try:
            import forecaster
            import news_feed
            import sentiment as _sm
            from market_data import fetch_historical

            df = fetch_historical(ticker, period="3mo")
            closes = [float(r.get("Close", 0)) for _, r in df.iterrows() if float(r.get("Close", 0)) > 0]
            if len(closes) < 10:
                return 0, {}
            base_date = str(df.index[-1])[:10]
            agg = _sm.aggregate(_sm.analyze_items(news_feed.get_news(ticker, 40)))
            fc = forecaster.forecast(ticker, closes, base_date, agg.get("overall", 0.0))
            if not fc or not fc.get("points"):
                return 0, {}
            base = fc["base_close"] or 1e-9
            chg = (fc["points"][-1]["value"] / base - 1) * 100
            thr = float(self.strategy.get("signals", {}).get("forecast_threshold_pct", 1.5))
            vote = 1 if chg >= thr else -1 if chg <= -thr else 0
            return vote, {
                "pred_change_pct": round(chg, 2),
                "sentiment": round(agg.get("overall", 0.0), 2),
                "best_w": fc.get("w"),
                "direction": "up" if vote > 0 else "down" if vote < 0 else "flat",
            }
        except Exception as exc:
            return 0, {"error": str(exc)[:120]}

    # ── Trade Execution ─────────────────────────────

    def _execute_trade(self, ticker, side, price):
        """Route an order: real broker (Alpaca) or local paper simulation."""
        if getattr(self, "broker", None) and self.broker.provider == "alpaca":
            return self._execute_broker(ticker, side, price)

        # ── local paper simulation ──
        broker = self.strategy.get("broker", {})
        capital = float(broker.get("initial_capital", 25000))
        max_pct = float(self.strategy.get("engine", {}).get("max_position_pct", 10)) / 100
        ts = datetime.now().isoformat()
        rec = {
            "id": len(self.trade_log) + 1,
            "timestamp": ts,
            "symbol": ticker,
            "side": side,
            "price": round(price, 2),
            "auto": True,
        }

        if side == "buy":
            if ticker in self.positions:
                return None  # already holding — no averaging in
            # Position sizing: max N% of equity
            pos_value = capital * max_pct
            qty = int(pos_value / price) if price > 0 else 0
            if qty < 1:
                return None
            rec["qty"] = qty
            self.positions[ticker] = {
                "qty": qty,
                "entry_price": price,
                "ts": ts,
            }
        elif side == "sell" and ticker in self.positions:
            old = self.positions.pop(ticker)
            qty = int(old["qty"])
            pnl = (price - float(old["entry_price"])) * qty
            rec["qty"] = qty
            rec["pnl"] = round(pnl, 2)
        else:
            return None

        # Single log record per fill (no duplicate entry/exit rows)
        self.trade_log.append(rec)

        # Persist
        self._save_json("positions.json", self.positions)
        self._save_json("trade_log.json", self.trade_log)

        return {"ticker": ticker, "side": side, "price": round(price, 2)}

    def _execute_broker(self, ticker, side, price):
        """Submit a real order to the connected broker (Alpaca paper/live)."""
        try:
            if side == "buy":
                if ticker in self.positions:
                    return None
                acct = self.broker.get_account()
                bp = float(acct.get("buying_power", 0))
                max_pct = float(self.strategy.get("engine", {}).get("max_position_pct", 10)) / 100
                qty = int((bp * max_pct) / price) if price > 0 else 0
                if qty < 1:
                    return None
                self.broker.submit_order(ticker, "buy", qty)
                self.positions[ticker] = {"qty": qty, "entry_price": price,
                                          "ts": datetime.now().isoformat(), "broker": "alpaca"}
                return {"ticker": ticker, "side": "buy", "price": round(price, 2), "qty": qty}
            else:  # sell → close the position at the broker
                if ticker not in self.positions:
                    return None
                self.broker.close_position(ticker)
                self.positions.pop(ticker, None)
                return {"ticker": ticker, "side": "sell", "price": round(price, 2)}
        except Exception as exc:
            print(f"⚠️  Alpaca-Order fehlgeschlagen ({ticker} {side}): {exc}")
            return None

    # ── Risk Management ─────────────────────────────

    def _check_risk(self):
        """Check stop-loss and take-profit on open positions."""
        engine = self.strategy.get("engine", {})
        sl_pct = -float(engine.get("stop_loss_pct", 2.0)) / 100
        tp_pct = float(engine.get("take_profit_pct", 4.0)) / 100
        to_close = []

        for sym, pos in list(self.positions.items()):
            try:
                live = fetch_price(sym)
                price = float(live.get("price", 0))
                entry = float(pos["entry_price"])
                if entry <= 0:
                    continue
                change = (price / entry) - 1

                if change <= sl_pct or change >= tp_pct:
                    reason = "stop_loss" if change < 0 else "take_profit"
                    to_close.append((sym, price, reason))
            except Exception:
                pass

        for sym, price, reason in to_close:
            self._execute_trade(sym, "sell", price)
            if self.trade_log:
                self.trade_log[-1]["risk_exit"] = reason
            print(f"⚠️  Risk exit: {sym} @ {price:.2f} ({reason})")

    # ── Main Scan Loop ──────────────────────────────

    def run_scan(self):
        """Execute one full scan of the watchlist."""
        watchlist = self.strategy.get("watchlist", [])
        if not watchlist:
            print("⚠️  Watchlist leer — keine Symbole definiert")
            return []

        ts = datetime.now().strftime("%H:%M")
        print(f"\n🔍 Scan starten: {len(watchlist)} Symbole ... (T_{ts})")

        signals = [self._analyze_ticker(t) for t in watchlist]

        # Execute trades on BUY/SELL signals
        executed = []
        for sig in signals:
            sym = sig["ticker"]
            if sig["decision"] == "BUY" and sym not in self.positions:
                live = fetch_price(sym)
                price = float(live.get("price", 0))
                result = self._execute_trade(sym, "buy", price)
                if result:
                    executed.append(result)
                    rsi_str = sig["indicators"].get("rsi", "-")
                    print(f"  🟢 BUY {sym} @ {price:.2f} (RSI={rsi_str})")

            elif sig["decision"] == "SELL" and sym in self.positions:
                live = fetch_price(sym)
                price = float(live.get("price", 0))
                result = self._execute_trade(sym, "sell", price)
                if result:
                    executed.append(result)

        # Check risk management
        self._check_risk()

        # Append every signal to the time-series history store (for trend charts)
        try:
            import history_store
            ts = datetime.now().isoformat()
            for sig in signals:
                ind = sig.get("indicators", {})
                macd = ind.get("macd", {}) if isinstance(ind.get("macd"), dict) else {}
                live = fetch_price(sig["ticker"])
                history_store.log_observation(
                    sig["ticker"],
                    price=(live.get("price") if live else None),
                    rsi=ind.get("rsi"),
                    macd_line=macd.get("line"),
                    signal_line=macd.get("signal"),
                    bb_pct=ind.get("bb_pct"),
                    decision=sig.get("decision"),
                    source="scan", ts=ts,
                )
        except Exception:
            pass

        # Save signals for dashboard
        self._save_json(
            "signals.json",
            {"timestamp": datetime.now().isoformat(), "results": signals}
        )

        print(f"✅ Scan fertig. {len(executed)} Trade(s) ausgeführt.")
        return executed

    def get_signals(self):
        """Load last computed signals."""
        return self._load_json("signals.json", {})

    @staticmethod
    def set_running(flag: bool):
        sp = Path.home() / ".hermes" / "trading" / "engine_state.json"
        state = {"running": flag, "updated_at": datetime.now().isoformat()}
        (sp).write_text(json.dumps(state, indent=2))


# CLI Entry Point
if __name__ == "__main__":
    engine = TradingEngine()
    print("=" * 60)
    print("🤖 AutoTrading Engine v1.0 — Paper Trading Mode")
    print("=" * 60)

    # Show current state
    pf = engine.portfolio
    print(f"Kapital: ${pf['base_capital']:,.2f} | Equity: ${pf['current_equity']:,.2f}")
    pnl_val = pf["total_pnl"]
    wr_val = pf.get("win_rate", 0)
    n_pos = len(pf["positions"])
    print(f"P&L: {pnl_val:+,.2f} ({wr_val}% Winrate)")
    print(f"Offene Positionen: {n_pos}")

    # Run scan
    engine.run_scan()

    print("=" * 60)
