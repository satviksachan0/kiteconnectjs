# Live Trading Integration for Strategy V2

This guide explains how to connect your Strategy V2 backtesting code to the Zerodha KiteConnect API for live trading.

## ⚠️ Important Warnings

**THIS IS REAL MONEY TRADING. USE AT YOUR OWN RISK.**

- Always test thoroughly in paper trading mode first
- Start with small capital amounts
- Monitor your positions actively
- Have a plan for emergency exits
- Understand the risks involved in options trading
- Past backtest performance does not guarantee future results

## 📋 Prerequisites

1. **Zerodha Trading Account**: You need an active Zerodha trading and demat account
2. **KiteConnect App**: Register for a KiteConnect app at https://kite.trade/
3. **API Credentials**: Get your API Key and API Secret from the Kite developer console
4. **Node.js**: Version 14 or higher
5. **TypeScript**: Installed globally or in the project

## 🚀 Quick Start

### Step 1: Install Dependencies

```bash
# Navigate to project directory
cd /Users/satviksachan/codes/Trading/kiteconnectjs

# Install dependencies (if not already installed)
npm install

# Build the project
npm run build
```

### Step 2: Setup Configuration

```bash
# Copy the environment template
cp strategy/.env.template strategy/.env

# Edit the .env file with your credentials
nano strategy/.env
```

### Step 3: Generate Access Token

The KiteConnect API requires an access token for authentication. Generate it once:

```bash
# Run the authentication script
npx ts-node strategy/live_trading_example.ts auth
```

Follow these steps:

1. The script will display a login URL
2. Open that URL in your browser
3. Login with your Zerodha credentials
4. After login, you'll be redirected to a URL with a `request_token` parameter
5. Copy the `request_token` and paste it in the terminal
6. The script will generate an access token
7. Copy the access token to your `.env` file

**Note**: Access tokens are valid for 24 hours. You'll need to regenerate daily.

### Step 4: Test in Dry Run Mode

Before live trading, test with dry run mode:

```bash
# Make sure DRY_RUN=true in your .env file
# Then run:
npx ts-node strategy/live_trading_example.ts live
```

This will:

- Connect to the API
- Fetch market data
- Generate signals (in memory only)
- Show what trades would be placed
- NOT place actual orders

### Step 5: Run Live Trading

When you're ready for live trading:

1. Set `DRY_RUN=false` in your `.env` file
2. Start the trading bot:

```bash
npx ts-node strategy/live_trading_example.ts live
```

3. Monitor the console output
4. Press `Ctrl+C` to stop gracefully (will close all positions)

## 📁 File Structure

```
strategy/
├── strategy_v2.ts              # Original backtest code
├── strategy_v2_live.ts         # Live trading integration
├── live_trading_example.ts     # Example usage and main entry point
├── config.ts                   # Configuration management
├── .env.template               # Template for environment variables
├── .env                        # Your actual config (DO NOT COMMIT)
└── live_trades.jsonl           # Trade log (auto-generated)
```

## 🔧 Configuration Options

Edit your `.env` file to customize these parameters:

### API Credentials

```env
KITE_API_KEY=your_api_key
KITE_API_SECRET=your_api_secret
KITE_ACCESS_TOKEN=your_access_token
```

### Trading Parameters

```env
INITIAL_CAPITAL=15000        # Starting capital in rupees
RISK_PER_TRADE=10           # Stop loss amount per trade
ENTRY_BUFFER=10             # Buy X rupees below LTP
STRIKE_STEP=50              # Nifty strike step (usually 50)
LOT_SIZE=75                 # Nifty option lot size
FINAL_RR=8                  # Final risk:reward ratio (1:8)
MAX_POSITIONS=3             # Maximum concurrent positions
```

### Trading Controls

```env
ENABLE_TRAILING=true        # Enable trailing stops
DEBUG_MODE=true            # Verbose logging
DRY_RUN=true              # Paper trading mode
```

### Risk Management

```env
MAX_DAILY_LOSS=5000        # Stop trading if daily loss exceeds this
MAX_DAILY_TRADES=10        # Maximum trades per day
```

## 🎯 How It Works

### Entry Logic

1. **Signal Generation**: The strategy monitors Nifty using:

   - 10-day Bollinger Bands
   - 20-day SMA
   - 0.3×ATR breakout filter

2. **Strike Selection**:

   - For bullish signals: Select CE one strike above ATM
   - For bearish signals: Select PE one strike below ATM

3. **Order Placement**:
   - Limit order at LTP - 10 rupees
   - Quantity based on capital (1 lot per 1L)

### Exit Logic

1. **Initial Stop Loss**: Entry price - 10 rupees

2. **First Target (1:3)**:

   - When profit reaches 3× risk
   - Tighten stop to 1:2 (entry + 20 rupees)
   - Let position run toward final target

3. **Final Target (1:8)**:

   - Exit at entry + 80 rupees (configurable)

4. **Friday Exit**:

   - Close all positions at 3:15 PM on Fridays

5. **Emergency Exit**:
   - Press Ctrl+C for graceful shutdown
   - All positions closed at market price

## 💻 Usage Examples

### Example 1: Automated Live Trading

```typescript
import { runLiveStrategy } from "./live_trading_example";

// Run automated strategy
await runLiveStrategy();
```

### Example 2: Manual Position Entry

```typescript
import LiveStrategyManager from "./strategy_v2_live";
import { loadConfig } from "./config";

const config = loadConfig();
const manager = new LiveStrategyManager({
  apiKey: config.apiKey,
  accessToken: config.accessToken,
  capital: config.initialCapital,
  riskPerTrade: 10,
  entryBuffer: 10,
  strikeStep: 50,
  lotSize: 75,
  finalRR: 8,
  enableTrailing: true,
  maxPositions: 3,
  debugMode: true,
});

manager.startTrading();

// Enter a long position
const spotPrice = await manager.getNiftySpot();
const signal = {
  index: 0,
  date: new Date(),
  side: "long",
  type: "BB_reversal",
};

await manager.enterPosition(signal, spotPrice);

// Monitor positions
setInterval(async () => {
  await manager.monitorPositions();
}, 30000);
```

### Example 3: Get Account Summary

```typescript
const summary = await manager.getAccountSummary();
console.log("Capital:", summary.capital);
console.log("Available Margin:", summary.availableMargin);
console.log("Open Positions:", summary.openPositions);
console.log("Position Details:", summary.positionDetails);
```

## 📊 Monitoring

### Console Output

The live trading system provides real-time updates:

```
[14:30:00] Status:
  Capital: ₹15234.50
  Open Positions: 2
  Daily Trades: 5
  Daily P&L: ₹234.50
  Positions:
    NIFTY24OCT2424500CE: Entry=₹85.00, Current=₹92.30, P&L=₹547.50
    NIFTY24OCT2424400PE: Entry=₹78.50, Current=₹72.10, P&L=₹-480.00
```

### Trade Log

All trades are logged to `live_trades.jsonl`:

```json
{
  "entryDate": "2024-10-26T09:30:00.000Z",
  "exitDate": "2024-10-26T14:45:00.000Z",
  "tradingSymbol": "NIFTY24OCT2424500CE",
  "side": "long",
  "strike": 24500,
  "expiry": "2024-10-26",
  "entryPrice": 85,
  "exitPrice": 125,
  "quantity": 75,
  "profit": 3000,
  "capital": 18000,
  "reason": "target",
  "status": "closed"
}
```

## 🛡️ Risk Management

### Built-in Safety Features

1. **Daily Loss Limit**: Trading stops if daily loss exceeds configured amount
2. **Daily Trade Limit**: Maximum number of trades per day
3. **Position Limits**: Maximum concurrent positions
4. **Market Hours Check**: Only trades during market hours
5. **Friday Exit**: Automatic position closure before weekend
6. **Graceful Shutdown**: Ctrl+C closes all positions safely

### Additional Recommendations

1. Start with minimum capital (₹15,000)
2. Test for at least 1-2 weeks in live market
3. Keep risk per trade low (₹10-20)
4. Don't override stop losses
5. Monitor during trading hours
6. Keep emergency funds for margin calls
7. Understand Nifty options Greeks and behavior

## 🐛 Troubleshooting

### Issue: Access token expired

**Solution**: Regenerate access token using `npx ts-node strategy/live_trading_example.ts auth`

### Issue: Orders not getting filled

**Solution**:

- Check if limit price is reasonable
- Increase ENTRY_BUFFER in config
- Check option liquidity

### Issue: Connection errors

**Solution**:

- Check internet connection
- Verify API credentials
- Check Zerodha system status

### Issue: Positions not closing at stop loss

**Solution**:

- Check DEBUG_MODE logs
- Verify position monitoring interval
- Manually close via Zerodha Kite app if needed

## 📞 Emergency Procedures

### If something goes wrong:

1. **Press Ctrl+C**: This will trigger graceful shutdown
2. **Manual Exit**: Login to Zerodha Kite and close positions manually
3. **Check Logs**: Review `live_trades.jsonl` for trade history
4. **Contact Support**: Reach out to Zerodha support if needed

### Emergency Stop Command

```bash
# If the script is not responding, kill the process:
pkill -f "live_trading_example"

# Then manually close positions via Zerodha Kite
```

## 📝 Best Practices

1. **Always test in DRY_RUN mode first**
2. **Start trading with small capital**
3. **Monitor actively during market hours**
4. **Review trade logs regularly**
5. **Keep access tokens secure**
6. **Don't commit `.env` file to git**
7. **Maintain adequate margin in your account**
8. **Understand the strategy before going live**
9. **Have a plan for various market scenarios**
10. **Don't leave automated trading unattended**

## 🔒 Security

- Never commit your `.env` file to version control
- Store API credentials securely
- Regenerate access tokens regularly
- Use IP whitelisting in Kite developer console
- Enable 2FA on your Zerodha account
- Monitor API usage and limits

## 📚 Additional Resources

- [Zerodha KiteConnect Documentation](https://kite.trade/docs/connect/v3/)
- [Zerodha Varsity - Options Trading](https://zerodha.com/varsity/module/option-theory/)
- [Strategy V2 Backtest Documentation](./strategy_v2.ts)

## 🤝 Support

For issues specific to:

- **KiteConnect API**: Contact Zerodha support
- **Trading Strategy**: Review backtest results and strategy logic
- **This Integration**: Check logs and error messages

## ⚖️ Disclaimer

This software is provided "as is" without warranty of any kind. Trading in securities and derivatives involves substantial risk of loss. Past performance does not guarantee future results. The authors and contributors are not responsible for any financial losses incurred through the use of this software.

**USE AT YOUR OWN RISK.**

---

_Last Updated: October 26, 2024_
