# Quick Start Guide - Live Trading

## 🎯 5-Minute Setup

### 1. Get API Credentials (One-time)

1. Go to https://kite.trade/
2. Login with Zerodha credentials
3. Create a new app
4. Note down your **API Key** and **API Secret**

### 2. Configure Environment

```bash
# Copy template
cp strategy/.env.template strategy/.env

# Edit with your details
nano strategy/.env
```

Add your credentials:

```env
KITE_API_KEY=your_api_key_here
KITE_API_SECRET=your_api_secret_here
```

### 3. Generate Access Token (Daily)

```bash
npx ts-node strategy/live_trading_example.ts auth
```

1. Open the displayed URL in browser
2. Login to Zerodha
3. Copy the `request_token` from redirect URL
4. Paste in terminal
5. Copy the generated access token to `.env` file

### 4. Test First!

```bash
# Make sure DRY_RUN=true in .env
npx ts-node strategy/live_trading_example.ts live
```

Watch the console output. No real orders will be placed.

### 5. Go Live (When Ready)

```bash
# Set DRY_RUN=false in .env
npx ts-node strategy/live_trading_example.ts live
```

⚠️ **Real money trading starts now. Monitor actively!**

---

## 🎮 Commands

| Command                                               | Description           |
| ----------------------------------------------------- | --------------------- |
| `npx ts-node strategy/live_trading_example.ts auth`   | Generate access token |
| `npx ts-node strategy/live_trading_example.ts live`   | Run live trading      |
| `npx ts-node strategy/live_trading_example.ts manual` | Manual trading mode   |

---

## ⚙️ Key Settings (.env file)

### Essential

```env
KITE_API_KEY=your_key          # From Kite Connect
KITE_ACCESS_TOKEN=your_token   # Generate daily
INITIAL_CAPITAL=15000          # Starting amount
DRY_RUN=true                   # false for real trading
```

### Risk Management

```env
RISK_PER_TRADE=10              # Stop loss amount
MAX_DAILY_LOSS=5000           # Daily loss limit
MAX_DAILY_TRADES=10           # Max trades per day
MAX_POSITIONS=3               # Concurrent positions
```

### Strategy

```env
STRIKE_STEP=50                # Nifty strike step
LOT_SIZE=75                  # Nifty lot size
FINAL_RR=8                   # Target (1:8 = 8x risk)
ENABLE_TRAILING=true         # Trailing stops
```

---

## 📊 What Happens During Trading

### Entry

1. Strategy analyzes Nifty using Bollinger Bands + SMA + ATR
2. When signal triggers:
   - Selects option strike (CE for bullish, PE for bearish)
   - Places limit order 10₹ below LTP
   - Sets stop loss at entry - 10₹

### Exit

1. **Stop Loss**: Entry - 10₹
2. **First Target (1:3)**: Entry + 30₹
   - If hit, trailing stop activates at entry + 20₹
3. **Final Target (1:8)**: Entry + 80₹
4. **Friday 3:15 PM**: Auto-exit all positions

### Monitoring

- Checks positions every 10 seconds
- Updates console every 60 seconds
- Logs all trades to `live_trades.jsonl`

---

## 🚨 Emergency Stop

**If anything goes wrong:**

1. **Press Ctrl+C** in terminal (graceful shutdown)
2. **Or kill process**: `pkill -f "live_trading_example"`
3. **Manual exit**: Login to Zerodha Kite and close positions

---

## ✅ Pre-Trading Checklist

- [ ] API credentials configured
- [ ] Access token generated (valid today)
- [ ] Tested in DRY_RUN mode
- [ ] Sufficient margin in account
- [ ] Understand the strategy
- [ ] Ready to monitor actively
- [ ] Know how to emergency stop

---

## 🔍 Check Status

While trading is running, the console shows:

```
[14:30:00] Status:
  Capital: ₹15234.50
  Open Positions: 2
  Daily Trades: 5
  Daily P&L: ₹234.50
```

---

## ❓ Quick Troubleshooting

| Problem                | Solution                       |
| ---------------------- | ------------------------------ |
| "Access token expired" | Run auth command again         |
| "Orders not filling"   | Increase ENTRY_BUFFER          |
| "Connection error"     | Check internet/API credentials |
| "Market closed"        | Trading only 9:15 AM - 3:30 PM |

---

## 📱 During Trading Hours

### DO:

- ✅ Monitor console output
- ✅ Keep terminal window open
- ✅ Check Zerodha Kite for confirmations
- ✅ Have emergency stop plan ready
- ✅ Maintain sufficient margin

### DON'T:

- ❌ Leave unattended
- ❌ Close terminal accidentally
- ❌ Override stop losses
- ❌ Trade without testing first
- ❌ Use on unstable internet

---

## 💡 Tips

1. **Start Small**: Begin with ₹15,000 capital
2. **Test First**: Run in DRY_RUN for 1-2 days
3. **Monitor Actively**: Don't set and forget
4. **Review Daily**: Check trade logs each day
5. **Keep Learning**: Understand why trades win/lose

---

## 📞 Need Help?

1. Read: [LIVE_TRADING_README.md](./LIVE_TRADING_README.md)
2. Check: Console error messages
3. Review: `live_trades.jsonl` logs
4. Zerodha Support: https://support.zerodha.com/

---

**Remember**: This is real money. Test thoroughly. Trade responsibly. 🎯

---

_Generated: October 26, 2024_
