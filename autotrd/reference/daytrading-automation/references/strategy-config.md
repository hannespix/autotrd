# Strategy Configuration Reference

Location: `~/.hermes/trading/strategy.yaml`

## Full Config Schema

```yaml
broker:
  paper_trading: true              # false = NOT IMPLEMENTED YET, always start true
  initial_capital: 25000           # starting equity in $

watchlist: [SPY, QQQ, AAPL, TSLA]   # symbols to scan each cycle

engine:
  check_interval_min: 5            # minutes between scans (cron should match)
  max_position_pct: 10             # max equity % per single position
  stop_loss_pct: 2.0              # auto-sell at -2% from entry
  take_profit_pct: 4.0            # auto-sell at +4% from entry

indicators:
  rsi:
    enabled: true
    threshold_buy: 30           # RSI below this = oversold (buy vote)
    threshold_sell: 70          # RSI above this = overbought (sell vote)
    window: 14                  # standard RSI period

  macd:
    enabled: true
    crossover_buy: true         # line > signal + positive histogram = buy vote

  bollinger:
    enabled: true
    bb_breakout_pct: 95        # price above 95% of band = overbought, below 5% = oversold

signals:
  min_confluence: 2            # require N/3 indicators to agree before trading
  period: "3mo"                # lookback for all TA indicator computations
```

## Confluence Voting Logic

For each ticker in the watchlist:
1. All enabled indicators cast 0 or 1 vote (buy OR sell)
2. If buy_votes >= min_confluence AND buy > sell → BUY signal
3. If sell_votes >= min_confluence AND sell > buy → SELL signal
4. Otherwise → HOLD

Example with all 3 indicators enabled and min_confluence=2:
- RSI oversold (buy) + MACD bullish (buy) + BB neutral = **BUY** (2 votes)
- RSI neutral + MACD bearish (sell) + BB overbought (sell) = **SELL** (2 votes)
- RSI buy(1) + MACD sell(1) + BB neutral = **HOLD** (neither side hits 2)

## Period Requirements

| Indicator | Min Bars Needed | Recommended yfinance period |
|-----------|----------------|--------------------------|
| RSI       | 14             | 3mo                      |
| MACD      | 35 (slow=26+signal=9) | 3mo        |
| BBands    | 20             | 3mo                      |
| Golden Cross | 257         | 1y or more               |

Using a period shorter than needed causes `IndexError: out-of-bounds`.
