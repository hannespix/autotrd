import pandas as pd
import numpy as np
from datetime import datetime
import matplotlib.pyplot as plt

# === Strategy Implementations ===

def sma_crossover(data, fast=20, slow=50):
    """Simple Moving Average Crossover (Golden/Death Cross)"""
    data = data.copy()
    data['SMA_Fast'] = data['Close'].rolling(window=fast).mean()
    data['SMA_Slow'] = data['Close'].rolling(window=slow).mean()
    
    signals = pd.Series(0, index=data.index)
    # Buy on golden cross (fast crosses above slow)
    signals[(data['SMA_Fast'] > data['SMA_Slow']) & 
            (data['SMA_Fast'].shift(1) <= data['SMA_Slow'].shift(1))] = 2
    # Sell on death cross
    signals[(data['SMA_Fast'] < data['SMA_Slow']) & 
            (data['SMA_Fast'].shift(1) >= data['SMA_Slow'].shift(1))] = -2
    return signals


def rsi_reversal(data, length=14, oversold=30, overbought=70):
    """RSI Mean Reversion"""
    data = data.copy()
    delta = data['Close'].diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=length).mean()
    loss_ = (-delta.where(delta < 0, 0)).rolling(window=length).mean()
    rs = gain / (loss_ + 1e-9)
    rsi_val = 100 - (100 / (1 + rs))
    data['RSI'] = rsi_val
    
    signals = pd.Series(0, index=data.index)
    signals[data['RSI'] < oversold] = 2
    signals[data['RSI'] > overbought] = -2
    return signals


def macd_strategy(data, fast=12, slow=26, signal_period=9):
    """MACD Signal Line Crossover"""
    data = data.copy()
    ema_fast = data['Close'].ewm(span=fast, adjust=False).mean()
    ema_slow = data['Close'].ewm(span=slow, adjust=False).mean()
    data['MACD'] = ema_fast - ema_slow
    data['Signal'] = data['MACD'].ewm(span=signal_period, adjust=False).mean()
    
    signals = pd.Series(0, index=data.index)
    signals[data['MACD'] > data['Signal']] = 1
    signals[data['MACD'] < data['Signal']] = -1
    return signals


def bollinger_bounce(data, window=20, num_std=2):
    """Bollinger Band Mean Reversion"""
    data = data.copy()
    sma = data['Close'].rolling(window=window).mean()
    std = data['Close'].rolling(window=window).std(ddof=0)
    data['BB_Upper'] = sma + (num_std * std)
    data['BB_Lower'] = sma - (num_std * std)
    
    signals = pd.Series(0, index=data.index)
    signals[data['Close'] <= data['BB_Lower']] = 2
    signals[data['Close'] >= data['BB_Upper']] = -2
    return signals


def momentum_breakout(data, lookback=20):
    """Donchian Channel Breakout"""
    data = data.copy()
    highest_high = data['High'].rolling(window=lookback).max().shift(1)
    lowest_low = data['Low'].rolling(window=lookback).min().shift(1)
    
    signals = pd.Series(0, index=data.index)
    signals[data['Close'] > highest_high] = 2
    signals[data['Close'] < lowest_low] = -2
    return signals


class BacktestEngine:
    """Realistic backtester with commission and slippage."""
    
    def __init__(self, initial_capital=10000.0, commission_pct=0.001, slippage_bps=5):
        self.initial_capital = initial_capital
        self.commission_rate = commission_pct
        self.slippage_bps = slippage_bps / 10000
    
    def run(self, df, signal_fn, strat_name="Custom"):
        """Run backtest. Signal: +2 Buy, -2 Sell, else 0/1/-1 hold/bias."""
        signals = signal_fn(df)
        
        capital = self.initial_capital
        shares = 0
        entry_price = None
        equity_curve = []
        trade_log = []
        
        def adj_buy(p): return p * (1 + self.commission_rate + self.slippage_bps)
        def adj_sell(p): return p * (1 - self.commission_rate - self.slippage_bps)
        
        for i in range(len(df)):
            price = df.iloc[i]['Close']
            sig = signals.iloc[i]
            
            if sig >= 2 and shares == 0:
                entry_price = adj_buy(price)
                max_shares = int(capital / entry_price)
                if max_shares > 0:
                    shares = max_shares
                    capital -= entry_price * shares
            
            elif sig <= -2 and shares > 0:
                exit_price = adj_sell(price)
                pnl = (exit_price - entry_price) * shares
                trade_log.append({
                    'date': str(df.index[i]),
                    'pnl': round(pnl, 2),
                })
                capital += exit_price * shares
                shares = 0
            
            equity_val = capital + (shares * price if shares > 0 else 0)
            equity_curve.append(equity_val)
        
        # Close remaining position
        if shares > 0:
            last_close = df.iloc[-1]['Close']
            pnl = (adj_sell(last_close) - entry_price) * shares
            trade_log.append({'date': str(df.index[-1]), 'pnl': round(pnl, 2)})
            capital += adj_sell(last_close) * shares
        
        eq_series = pd.Series(equity_curve)
        final_equity = eq_series.iloc[-1]
        
        # Max drawdown
        peak = eq_series.cummax()
        dd = (eq_series - peak) / peak * 100
        max_dd = float(dd.min())
        
        # Sharpe ratio
        daily_ret = eq_series.pct_change().dropna()
        sharpe = float((daily_ret.mean() / daily_ret.std()) * np.sqrt(252)) if len(daily_ret) > 1 and daily_ret.std() != 0 else 0.0
        
        # Trade stats
        pnl_list = [t['pnl'] for t in trade_log]
        winning = sum(1 for p in pnl_list if p > 0)
        win_rate = (winning / max(len(pnl_list), 1)) * 100
        avg_pnl = np.mean(pnl_list) if pnl_list else 0.0
        
        # Buy and hold return
        bh = ((df.iloc[-1]['Close'] - df.iloc[0]['Close']) / df.iloc[0]['Close']) * 100
        
        total_return = ((final_equity - self.initial_capital) / self.initial_capital) * 100
        
        # Save chart — sanitize name to avoid path-separator issues (e.g. "SMA 10/30")
        safe_name = "".join(c if c.isalnum() or c == '_' else '_' for c in strat_name).lower()
        chart_path = f'/tmp/backtest_{safe_name}_{datetime.now().strftime("%Y%m%d_%H%M%S")}.png'
        eq_norm = eq_series / eq_series.iloc[0]
        bh_norm = np.arange(len(eq_norm)) * (bh / max(len(eq_norm), 1) / 100 + 0.01) + 1
        
        plt.figure(figsize=(12, 6))
        plt.plot(eq_norm.values, label='Strategy', linewidth=2, color='#4CAF50')
        plt.axhline(1.0, color='gray', linestyle='--', alpha=0.5, label='Start Capital')
        plt.title(f'{strat_name} | Return: {total_return:+.1f}% | Max DD: {max_dd:.1f}%')
        plt.legend()
        plt.grid(True, alpha=0.3)
        plt.tight_layout()
        plt.savefig(chart_path, dpi=150)
        plt.close()
        
        return {
            'final_equity': round(final_equity, 2),
            'total_return_pct': round(total_return, 2),
            'buy_hold_pct': round(bh, 2),
            'num_trades': len(trade_log),
            'win_rate_pct': round(win_rate, 1),
            'avg_pnl': round(float(avg_pnl), 2),
            'max_drawdown_pct': round(max_dd, 2),
            'sharpe_ratio': round(sharpe, 3),
            'best_trade': round(float(max(pnl_list)), 2) if pnl_list else 0,
            'worst_trade': round(float(min(pnl_list)), 2) if pnl_list else 0,
        }, chart_path


def compare_strategies(ticker='SPY', period='1y'):
    """Run multiple strategies side by side."""
    import yfinance as yf
    
    data = yf.download(ticker, period=period, interval='1d')
    # Flatten MultiIndex columns that yfinance returns for single tickers
    if isinstance(data.columns, pd.MultiIndex):
        data.columns = data.columns.droplevel(1)
    engine = BacktestEngine(initial_capital=10000)
    
    strats = [
        (lambda d: sma_crossover(d, 10, 30), 'SMA 10/30'),
        (lambda d: rsi_reversal(d, 14, 30, 70), 'RSI Reversal'),
        (lambda d: macd_strategy(d), 'MACD'),
        (lambda d: bollinger_bounce(d), 'BB Bounce'),
    ]
    
    results = {}
    for fn, name in strats:
        res, _ = engine.run(data, fn, strat_name=name)
        results[name] = res
    
    best = max(results.items(), key=lambda x: x[1]['total_return_pct'])
    return {'results': results, 'best_strategy': best[0], 'best_return': best[1]['total_return_pct']}
