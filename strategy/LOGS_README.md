# Trading Logs Documentation

This directory contains log files generated during live trading sessions.

## Log Files

### 1. `order_log.jsonl`

**Purpose**: Logs every order attempt (entry and exit)

**Format**: JSON Lines (one JSON object per line)

**Example Entry Attempt**:

```json
{
  "timestamp": "2025-10-28T09:15:30.123Z",
  "type": "ORDER_ATTEMPT",
  "signal": "BB_reversal",
  "side": "long",
  "spotPrice": 24500,
  "status": "SUCCESS",
  "orderId": "240611801793632",
  "tradingSymbol": "NIFTY24OCT2424500CE",
  "strike": 24500,
  "optionType": "CE",
  "ltp": 95.5,
  "entryPrice": 85.5,
  "quantity": 75,
  "targets": {
    "target1": 115.5,
    "trailingStop": 105.5,
    "finalTarget": 165.5
  },
  "initialStop": 75.5
}
```

**Possible Status Values**:

- `ATTEMPT` - Order placement attempted
- `SUCCESS` - Order placed successfully
- `FAILED` - Order placement failed
- `REJECTED` - Order rejected (e.g., max positions reached)

### 2. `live_trades.jsonl`

**Purpose**: Records completed trades (entry + exit)

**Format**: JSON Lines

**Example**:

```json
{
  "entryDate": "2025-10-28T09:15:30.123Z",
  "exitDate": "2025-10-28T14:45:22.456Z",
  "orderId": "240611801793632",
  "tradingSymbol": "NIFTY24OCT2424500CE",
  "side": "long",
  "strike": 24500,
  "expiry": "2025-10-31",
  "entryPrice": 85.5,
  "exitPrice": 125.0,
  "quantity": 75,
  "profit": 2962.5,
  "profitPercentage": "46.20",
  "capital": 17962.5,
  "reason": "target",
  "status": "closed"
}
```

**Exit Reasons**:

- `stop_loss` - Initial stop loss hit
- `trailing_stop` - Trailing stop loss hit
- `target` - Final target reached
- `friday_exit` - Friday end-of-day exit
- `emergency_exit` - Manual emergency exit

### 3. `trading_summary.json`

**Purpose**: Daily trading summary statistics

**Format**: JSON

**Example**:

```json
{
  "date": "2025-10-28",
  "totalTrades": 5,
  "successfulEntries": 5,
  "failedEntries": 0,
  "rejectedEntries": 2,
  "wins": 3,
  "losses": 2,
  "winRate": 60.0,
  "totalProfit": 2450.0,
  "totalLoss": -450.0,
  "netProfit": 2000.0,
  "largestWin": 1200.0,
  "largestLoss": -250.0,
  "startingCapital": 15000.0,
  "endingCapital": 17000.0,
  "returnPercentage": 13.33
}
```

## Reading the Logs

### View Recent Order Attempts

```bash
# Last 10 order attempts
tail -n 10 strategy/order_log.jsonl | jq .

# All successful orders today
grep "SUCCESS" strategy/order_log.jsonl | jq .

# All failed orders
grep "FAILED" strategy/order_log.jsonl | jq .
```

### View Completed Trades

```bash
# Last 5 completed trades
tail -n 5 strategy/live_trades.jsonl | jq .

# Calculate total profit
cat strategy/live_trades.jsonl | jq '.profit' | awk '{sum+=$1} END {print "Total Profit: ₹"sum}'

# Win rate
cat strategy/live_trades.jsonl | jq 'select(.profit > 0)' | wc -l
```

### Generate Daily Report

```bash
# Count trades by exit reason
cat strategy/live_trades.jsonl | jq -r '.reason' | sort | uniq -c

# Average profit per trade
cat strategy/live_trades.jsonl | jq '.profit' | awk '{sum+=$1; count++} END {print "Avg: ₹"sum/count}'
```

## Log Rotation

Logs are appended to files continuously. To prevent files from growing too large:

### Manual Rotation

```bash
# Archive old logs (do this weekly/monthly)
mkdir -p strategy/logs_archive/$(date +%Y-%m)
mv strategy/order_log.jsonl strategy/logs_archive/$(date +%Y-%m)/order_log_$(date +%Y%m%d).jsonl
mv strategy/live_trades.jsonl strategy/logs_archive/$(date +%Y-%m)/live_trades_$(date +%Y%m%d).jsonl
```

### Automated Script (Optional)

Create `strategy/rotate_logs.sh`:

```bash
#!/bin/bash
DATE=$(date +%Y%m%d)
ARCHIVE_DIR="strategy/logs_archive/$(date +%Y-%m)"

mkdir -p "$ARCHIVE_DIR"

if [ -f "strategy/order_log.jsonl" ]; then
    mv "strategy/order_log.jsonl" "$ARCHIVE_DIR/order_log_$DATE.jsonl"
fi

if [ -f "strategy/live_trades.jsonl" ]; then
    mv "strategy/live_trades.jsonl" "$ARCHIVE_DIR/live_trades_$DATE.jsonl"
fi

echo "Logs rotated to $ARCHIVE_DIR"
```

Run daily via cron:

```bash
0 0 * * * /path/to/strategy/rotate_logs.sh
```

## Analysis Tips

### Python Analysis

```python
import json
import pandas as pd

# Load trades into DataFrame
trades = []
with open('strategy/live_trades.jsonl', 'r') as f:
    for line in f:
        trades.append(json.loads(line))

df = pd.DataFrame(trades)
print(df.describe())
print(f"Win Rate: {(df['profit'] > 0).mean() * 100:.2f}%")
print(f"Average Win: ₹{df[df['profit'] > 0]['profit'].mean():.2f}")
print(f"Average Loss: ₹{df[df['profit'] < 0]['profit'].mean():.2f}")
```

### Excel Analysis

1. Convert JSONL to CSV:

```bash
cat strategy/live_trades.jsonl | jq -r '[.entryDate, .exitDate, .tradingSymbol, .entryPrice, .exitPrice, .profit, .reason] | @csv' > trades.csv
```

2. Open `trades.csv` in Excel for pivot tables and charts

## Troubleshooting

### Empty Log Files

- Check file permissions
- Ensure `strategy/` directory exists
- Verify DEBUG_MODE is enabled in .env

### Parsing Errors

```bash
# Validate JSON format
cat strategy/order_log.jsonl | while read line; do echo "$line" | jq . > /dev/null || echo "Invalid JSON: $line"; done
```

### Large Files

```bash
# Check file sizes
ls -lh strategy/*.jsonl

# Compress old logs
gzip strategy/logs_archive/*/*.jsonl
```

---

**Note**: These log files contain sensitive trading information. Keep them secure and do not share publicly.
