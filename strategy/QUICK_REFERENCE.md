# Quick Reference: Live Trading System

## 🚀 What's New

### Before (Old System)

- ❌ No signal generation - manual only
- ❌ No indicator calculation
- ❌ Basic strike selection (no OI filtering)
- ❌ No multi-day holding logic
- ❌ Current price checks only (missed intraday extremes)
- ❌ No order fill verification
- ❌ Manual trade tracking

### After (New System)

- ✅ **Automatic signal generation** (BB reversal + breakout)
- ✅ **Full indicator calculation** (BB, SMA, ATR)
- ✅ **OI-based contract selection** (picks most liquid)
- ✅ **3-day holding period** with auto-exit
- ✅ **Intraday high/low tracking** (accurate stop/target detection)
- ✅ **Order fill verification** (confirms before position creation)
- ✅ **Automatic trade/P&L tracking**

---

## 📊 Signal Generation Logic

The system now automatically generates signals using:

### Bollinger Band Reversal

```
LONG:  Close < BB Lower (10-day, 2σ)
SHORT: Close > BB Upper (10-day, 2σ)
```

### Breakout with Trend Filter

```
LONG:  Close > PrevClose + 0.3×ATR
       AND Close > SMA(20)
       AND SMA(20) > Prev SMA(20)

SHORT: Close < PrevClose - 0.3×ATR
       AND Close < SMA(20)
       AND SMA(20) < Prev SMA(20)
```

---

## 🎯 Position Management

### Entry

1. Signal generated → Check max positions
2. Fetch option chain → Filter by OI
3. Select best contract (highest OI)
4. Calculate entry price (LTP - 10)
5. Place limit order
6. **Verify fill** ← NEW
7. Create position with actual fill price

### Monitoring (Every 10 seconds)

```
Check in order:
1. Days held ≥ 3 → Exit
2. Intraday low ≤ Stop → Exit
3. Intraday high ≥ Target1 → Activate trailing
4. Intraday low ≤ Trailing stop → Exit
5. Intraday high ≥ Final target → Exit
6. Friday 3:15 PM → Exit
```

### Exit Prices

- **Stop-loss:** Entry - 10 (₹10 risk)
- **Target 1 (1:3):** Entry + 30
- **Trailing stop (1:2):** Entry + 20
- **Final target (1:8):** Entry + 80

---

## 📈 Key Methods

### For Strategy Manager

```typescript
// Initialize and update indicators
await manager.updateIndicators();

// Generate signals for today
const signals = manager.generateTodaySignals();

// Enter position
const position = await manager.enterPosition(signal, spotPrice);

// Monitor positions
await manager.monitorPositions();

// Get metrics
const pnl = manager.getTodayPnL();
const tradeCount = manager.getTodayTradeCount();
const barInfo = manager.getCurrentBarInfo();

// Emergency exit
await manager.closeAllPositions();
```

### For Debugging

```typescript
// Check current indicators
const barInfo = manager.getCurrentBarInfo();
console.log(barInfo);
// Output: { date, close, sma, bbUpper, bbMid, bbLower, atr }

// Check position details
const summary = await manager.getAccountSummary();
console.log(summary.positionDetails);
// Shows: symbol, entry, current, P&L, high, low

// Check logs
// order_log.jsonl - All attempts
// live_trades.jsonl - Completed trades
```

---

## ⚙️ Configuration

### Required Settings (.env)

```bash
# API Credentials
KITE_API_KEY=your_key
KITE_API_SECRET=your_secret
KITE_ACCESS_TOKEN=your_token

# Capital & Risk
INITIAL_CAPITAL=15000
RISK_PER_TRADE=10
MAX_DAILY_LOSS=5000
MAX_DAILY_TRADES=10

# Position Limits
MAX_POSITIONS=3

# Trading Parameters
ENTRY_BUFFER=10
STRIKE_STEP=50
LOT_SIZE=75
FINAL_RR=8

# Controls
ENABLE_TRAILING=true
DEBUG_MODE=true
DRY_RUN=true  # Set to false for live trading
```

---

## 🔄 Trading Loop Flow

```
Every 60 seconds:
├── Check market open
├── Check daily limits (loss/trades)
├── Update indicators (every 5 min)
├── Generate signals
├── Enter positions (if signals found)
├── Monitor positions
└── Display status

Every 10 seconds:
└── Monitor positions (stop/target checks)
```

---

## 📝 Position Lifecycle Example

```
T+0 (Entry Day - Index 100):
  09:30 - Signal generated (Close < BB Lower)
  09:31 - Contract selected (highest OI)
  09:32 - Order placed (LTP 200, Entry 190)
  09:33 - Order filled at 192 ✓
  09:34 - Position created:
          Entry: 192
          Stop: 182 (192 - 10)
          Target1: 222 (192 + 30)
          Trailing: 212 (192 + 20)
          Final: 272 (192 + 80)

T+0 Later:
  11:00 - Price hits 225 → Target1 reached
          Status: "active" → "trailing"
          New stop: 212

T+1 (Next Day - Index 101):
  10:30 - Price drops to 210 → Trailing stop hit
          Exit at 210, Profit: +18 per unit ✓

Alternative outcomes:
- T+0: Price hits 180 → Stop loss → Exit at 182, Loss: -10
- T+0: Price hits 275 → Final target → Exit at 272, Profit: +80
- T+3: Day 3 reached → Force exit at market
- Friday 3:15 PM → Force exit at market
```

---

## 🛡️ Safety Features

### Position Level

- ✅ Initial stop-loss (₹10 risk)
- ✅ Trailing stop after 1:3 (locks profit)
- ✅ 3-day holding limit
- ✅ Friday auto-exit (avoids expiry)
- ✅ Order fill verification

### Account Level

- ✅ Max 3 simultaneous positions
- ✅ Max ₹5,000 daily loss
- ✅ Max 10 daily trades
- ✅ Capital-based position sizing
- ✅ 80% max capital per trade

### System Level

- ✅ Market hours check
- ✅ Graceful shutdown (Ctrl+C)
- ✅ Error logging
- ✅ Trade recording
- ✅ Dry run mode

---

## 🧪 Pre-Launch Checklist

Before going live:

### 1. Authentication

```bash
ts-node strategy/live_trading_example.ts auth
```

- [ ] Generated access token
- [ ] Saved to .env file

### 2. Configuration

- [ ] Set initial capital
- [ ] Set risk per trade
- [ ] Set daily limits
- [ ] Verify lot size (75 for Nifty)
- [ ] Set DRY_RUN=true first

### 3. Test Run (Dry Mode)

```bash
DRY_RUN=true DEBUG_MODE=true
ts-node strategy/live_trading_example.ts live
```

- [ ] Indicators calculate correctly
- [ ] Signals generate properly
- [ ] Orders place successfully
- [ ] Positions track correctly
- [ ] Logs write properly

### 4. Paper Trading (1 week)

- [ ] Monitor for false signals
- [ ] Check entry/exit logic
- [ ] Verify P&L calculations
- [ ] Test emergency stop (Ctrl+C)
- [ ] Review trade logs

### 5. Go Live

```bash
DRY_RUN=false
ts-node strategy/live_trading_example.ts live
```

- [ ] Start with minimum capital
- [ ] Monitor first day closely
- [ ] Have kill switch ready
- [ ] Set alerts for daily loss limit

---

## 🚨 Emergency Procedures

### Stop Trading Immediately

```
Press: Ctrl+C

System will:
1. Stop trading flag
2. Close all positions
3. Save final metrics
4. Exit gracefully
```

### Manual Position Close

```bash
# In another terminal while running
# Send SIGTERM
kill -TERM <pid>
```

### Check Position Status

```typescript
// During runtime, check logs:
tail -f strategy/order_log.jsonl
tail -f strategy/live_trades.jsonl

// Or use KiteConnect dashboard
// to manually close positions
```

---

## 📞 Common Issues

### No signals generated

- Check if indicators calculated (need 20+ days data)
- Verify market conditions meet criteria
- Enable DEBUG_MODE to see indicator values

### Orders not filling

- Entry price too far from LTP
- Low liquidity contract
- Market moved before fill
- Check order_log.jsonl for details

### Positions not exiting

- Check position monitoring loop running
- Verify stop/target calculations
- Check error logs
- Manually close via KiteConnect if needed

### High/Low not updating

- Position monitoring may be delayed
- Check network connectivity
- Verify API rate limits not hit

---

## 📊 Performance Metrics

Track these daily:

- **Win Rate:** Wins / Total Trades
- **Avg Win:** Sum(Winning Trades) / Count(Wins)
- **Avg Loss:** Sum(Losing Trades) / Count(Losses)
- **Profit Factor:** Total Profit / Total Loss
- **Max Drawdown:** Largest peak-to-trough decline
- **Sharpe Ratio:** Risk-adjusted returns

All metrics available in `live_trades.jsonl`

---

## 🎓 Best Practices

### Daily Routine

1. **9:00 AM** - Start system, verify connection
2. **9:15 AM** - Market open, indicators update
3. **9:15-3:30 PM** - Monitor console for signals/trades
4. **3:15 PM** - Watch for Friday exits
5. **3:30 PM** - Review day's trades
6. **4:00 PM** - Analyze performance

### Weekly Review

- Review trade logs
- Calculate metrics
- Adjust parameters if needed
- Check for system errors
- Update strategy if required

### Risk Management

- Never risk > 2% per trade
- Keep daily loss limit strict
- Don't override safety features
- Have backup capital
- Stay disciplined

---

**Remember:** This system trades real money. Test thoroughly, start small, and monitor closely!

**Questions?** Check LIVE_TRADING_UPDATES.md for detailed documentation.
