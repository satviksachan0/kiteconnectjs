/*
 * High‑Frequency Nifty Option Strategy with Dynamic Trailing Stop
 *
 * This TypeScript module implements a complete backtesting engine for the
 * user's high‑frequency options strategy.  The underlying index data is
 * expected at the minute granularity and will be aggregated into daily
 * bars internally.  Signals are generated from 10‑day Bollinger Bands,
 * a 20‑day simple moving average and a 0.3×ATR breakout filter.  The
 * strategy selects a single lot of the option one strike above (for
 * bullish signals) or below (for bearish signals) the at‑the‑money
 * strike, places a limit order 10 rupees below the last traded price
 * and manages risk with a 1:3 initial target.  Once the option hits
 * 1:3, the stop is tightened to 1:2 and the position is allowed to run
 * toward a larger final target (default 1:8, but configurable).
 *
 * Notes for use:
 *
 * 1. CSV Parsing:  This code relies on the `csv-parse` package from
 *    npm to read the option and minute data.  Install it with:
 *
 *      npm install csv-parse
 *
 * 2. Data Requirements:  The minute data CSV must contain columns
 *    `datetime`, `Open`, `High`, `Low` and `Close`.  The option chain
 *    CSVs must include at least `Date`, `Expiry`, `Option type`,
 *    `Strike Price`, `LTP`, `Low`, `High`, `Open Int` and `Change in OI`.
 *
 * 3. Running the backtest:  Configure the file paths at the bottom of
 *    this script and call `main()`.  The script will print a summary
 *    of trades and save detailed results to CSV.
 */

import * as fs from 'fs';
import { parse as csvParse } from 'csv-parse/sync';

/**
 * Clean a numeric string by removing commas and dashes then parsing as
 * a float.  Returns NaN if the input is empty or cannot be parsed.
 */
function cleanNumber(val: any): number {
  if (val === null || val === undefined) return NaN;
  const str = String(val).replace(/,/g, '').replace(/-/g, '').trim();
  return str ? parseFloat(str) : NaN;
}

/**
 * Parse dates coming from CSVs.  Accepts ISO (YYYY-MM-DD), or DD-MMM-YY(/YYYY)
 * formats like `02-Jan-23` or `02-Jan-2023`. Returns an Invalid Date when
 * parsing fails (caller must check with isNaN(d.getTime())).
 */
function parseCsvDate(s: any): Date {
  if (s === null || s === undefined) return new Date(NaN);
  const str = String(s).trim();
  if (!str) return new Date(NaN);
  // ISO-ish dates are safe
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str);
  // Try DD-MMM-YY or DD-MMM-YYYY
  const parts = str.split('-');
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const mon = parts[1].toLowerCase().slice(0, 3);
    const yearPart = parts[2];
    const months: { [k: string]: number } = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
    };
    const m = months[mon];
    if (m !== undefined && !isNaN(day)) {
      const year = yearPart.length === 2 ? 2000 + parseInt(yearPart, 10) : parseInt(yearPart, 10);
      if (!isNaN(year)) return new Date(year, m, day);
    }
  }
  // Fallback to Date constructor
  return new Date(str);
}

/**
 * Return local YYYY-MM-DD key for a Date object to avoid UTC shift issues
 */
function dateKey(d: Date): string {
  if (isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Interfaces for the data structures used in the backtest

export interface MinuteRecord {
  datetime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DailyBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  sma: number;
  bbMid: number;
  bbUpper: number;
  bbLower: number;
  atr: number;
}

export interface Signal {
  index: number;
  date: Date;
  side: 'long' | 'short';
  type: 'BB_reversal' | 'breakout';
}

export interface OptionRow {
  date: Date;
  expiry: string;
  expiryDt: Date;
  type: string;
  strike: number;
  ltp: number;
  low: number;
  high: number;
  oi: number;
  oiChange: number;
  contracts: number;
}

export interface TradeRecord {
  entryDate: Date;
  exitDate: Date;
  signalType: string;
  side: 'long' | 'short';
  strike: number;
  expiry: string;
  entryLimit: number;
  initialStop: number;
  target1: number;
  trailingStop: number;
  finalTarget: number;
  exitPrice: number;
  profit: number;
  capitalAfter: number;
}

// Configuration constants
const STRIKE_STEP = 50;   // Nifty strikes increment in 50 points
const LOT_SIZE = 75;      // Nifty option lot size
const START_CAPITAL = 15_000;
const ENTRY_BUFFER = 10;  // buy 10 below LTP
const RISK_PER_TRADE = 10; // stop amount in rupees

// Debugging helper
const DEBUG = true;
function debugLog(...args: any[]) {
  if (DEBUG) console.log('[DEBUG]', ...args);
}

/**
 * Parse a minute-level CSV into an array of MinuteRecord objects.  The
 * CSV must have columns named `datetime`, `Open`, `High`, `Low` and
 * `Close`.
 */
function loadMinuteData(path: string): MinuteRecord[] {
  const content = fs.readFileSync(path, 'utf8');
  const records: any[] = csvParse(content, {
    columns: true,
    skip_empty_lines: true
  });
  const out = records.map((row) => {
    const dtRaw = row['datetime'] || row['Datetime'] || row['date'] || row['Date'];
    return {
      datetime: parseCsvDate(dtRaw),
      open: cleanNumber(row['Open'] || row['open']),
      high: cleanNumber(row['High'] || row['high']),
      low: cleanNumber(row['Low'] || row['low']),
      close: cleanNumber(row['Close'] || row['close'])
    } as MinuteRecord;
  });
  const cleaned = out.filter(r => !isNaN(r.datetime.getTime()) && !isNaN(r.open) && !isNaN(r.high) && !isNaN(r.low) && !isNaN(r.close));
  debugLog('loadMinuteData:', path, 'rawRows=', out.length, 'validRows=', cleaned.length, 'firstValid=', cleaned[0]);
  return cleaned;
}

/**
 * Aggregate minute data into daily OHLC bars.
 */
function aggregateToDaily(minuteData: MinuteRecord[]): DailyBar[] {
  const byDate: { [key: string]: MinuteRecord[] } = {};
  minuteData.forEach((rec) => {
    const dKey = dateKey(rec.datetime); // yyyy-mm-dd local
    if (!byDate[dKey]) byDate[dKey] = [];
    byDate[dKey].push(rec);
  });
  const days = Object.keys(byDate).sort();
  const result: DailyBar[] = [];
  days.forEach((dKey) => {
    const records = byDate[dKey];
    records.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
    const open = records[0].open;
    const high = Math.max(...records.map((r) => r.high));
    const low = Math.min(...records.map((r) => r.low));
    const close = records[records.length - 1].close;
    result.push({
      date: new Date(dKey),
      open,
      high,
      low,
      close,
      sma: 0,
      bbMid: 0,
      bbUpper: 0,
      bbLower: 0,
      atr: 0
    });
  });
  return result;
}

/**
 * Compute indicators for the high‑frequency strategy.  Bollinger bands use a
 * window of 10 periods, the SMA uses a window of 20 and the ATR uses 10.
 */
function computeIndicators(daily: DailyBar[], bbPeriod = 10, smaPeriod = 20, atrPeriod = 10): DailyBar[] {
  const closes = daily.map((d) => d.close);
  const highs = daily.map((d) => d.high);
  const lows = daily.map((d) => d.low);
  // compute SMA
  const sma: number[] = [];
  for (let i = 0; i < daily.length; i++) {
    if (i < smaPeriod - 1) {
      sma.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - smaPeriod + 1; j <= i; j++) sum += closes[j];
      sma.push(sum / smaPeriod);
    }
  }
  // compute Bollinger bands
  const bbMid: number[] = [];
  const bbUpper: number[] = [];
  const bbLower: number[] = [];
  for (let i = 0; i < daily.length; i++) {
    if (i < bbPeriod - 1) {
      bbMid.push(NaN);
      bbUpper.push(NaN);
      bbLower.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - bbPeriod + 1; j <= i; j++) sum += closes[j];
      const mean = sum / bbPeriod;
      // compute standard deviation
      let variance = 0;
      for (let j = i - bbPeriod + 1; j <= i; j++) {
        const diff = closes[j] - mean;
        variance += diff * diff;
      }
      const std = Math.sqrt(variance / bbPeriod);
      bbMid.push(mean);
      bbUpper.push(mean + 2 * std);
      bbLower.push(mean - 2 * std);
    }
  }
  // compute ATR
  const trueRanges: number[] = [];
  for (let i = 0; i < daily.length; i++) {
    if (i === 0) {
      trueRanges.push(NaN);
    } else {
      const highLow = highs[i] - lows[i];
      const highPrevClose = Math.abs(highs[i] - closes[i - 1]);
      const lowPrevClose = Math.abs(lows[i] - closes[i - 1]);
      trueRanges.push(Math.max(highLow, highPrevClose, lowPrevClose));
    }
  }
  const atr: number[] = [];
  for (let i = 0; i < daily.length; i++) {
    if (i < atrPeriod) {
      atr.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - atrPeriod + 1; j <= i; j++) sum += trueRanges[j];
      atr.push(sum / atrPeriod);
    }
  }
  // assign values back to daily bars; backfill NaNs for early periods
  let lastSma = 0;
  let lastBbMid = 0;
  let lastBbUpper = 0;
  let lastBbLower = 0;
  let lastAtr = 0;
  return daily.map((d, i) => {
    if (!isNaN(sma[i])) lastSma = sma[i];
    if (!isNaN(bbMid[i])) {
      lastBbMid = bbMid[i];
      lastBbUpper = bbUpper[i];
      lastBbLower = bbLower[i];
    }
    if (!isNaN(atr[i])) lastAtr = atr[i];
    return {
      ...d,
      sma: lastSma,
      bbMid: lastBbMid,
      bbUpper: lastBbUpper,
      bbLower: lastBbLower,
      atr: lastAtr
    };
  });
}

/**
 * Generate signals using Bollinger reversals and breakout logic.  This uses
 * the high‑frequency parameters (0.3×ATR threshold and 20‑day SMA).
 */
function generateSignals(daily: DailyBar[]): Signal[] {
  const signals: Signal[] = [];
  for (let i = 1; i < daily.length; i++) {
    const d = daily[i];
    const prev = daily[i - 1];
    // Bollinger band reversal
    if (d.close < d.bbLower) {
      signals.push({ index: i, date: d.date, side: 'long', type: 'BB_reversal' });
    } else if (d.close > d.bbUpper) {
      signals.push({ index: i, date: d.date, side: 'short', type: 'BB_reversal' });
    }
    // Trend‑filtered breakout
    const threshold = 0.3;
    if (
      d.close > prev.close + threshold * d.atr &&
      d.close > d.sma &&
      d.sma > prev.sma
    ) {
      signals.push({ index: i, date: d.date, side: 'long', type: 'breakout' });
    }
    if (
      d.close < prev.close - threshold * d.atr &&
      d.close < d.sma &&
      d.sma < prev.sma
    ) {
      signals.push({ index: i, date: d.date, side: 'short', type: 'breakout' });
    }
  }
  return signals;
}

// Debug wrapper to print signals
function generateSignalsDebug(daily: DailyBar[]): Signal[] {
  const s = generateSignals(daily);
  debugLog('generateSignals: total=', s.length, 'sample=', s.slice(0, 5));
  return s;
}

/**
 * Load and normalise option chain data.  This function expects multiple
 * option CSV files.  Comma‑separated numeric fields are cleaned and
 * parsed into numbers; dates are parsed to Date objects.  Expiry is
 * stored both as a string and as a Date for comparison.
 */
function loadOptionData(files: string[]): OptionRow[] {
  const records: OptionRow[] = [];
  files.forEach((path) => {
    const content = fs.readFileSync(path, 'utf8');
    const rows: any[] = csvParse(content, {
      columns: true,
      skip_empty_lines: true
    });
    rows.forEach((row) => {
      const dateStr = row['Date'] || row['date'];
      const expiryStr = row['Expiry'] || row['expiry'];
      const type = (row['Option type'] || row['type'] || '').toString().trim();
      const parsedDate = parseCsvDate(dateStr);
      const parsedExpiry = expiryStr ? parseCsvDate(expiryStr) : new Date(NaN);
      const rec: OptionRow = {
        date: parsedDate,
        expiry: expiryStr || '',
        expiryDt: parsedExpiry,
        type,
        strike: cleanNumber(row['Strike Price'] || row['strike']),
        ltp: cleanNumber(row['LTP'] || row['ltp'] || row['Close']),
        low: cleanNumber(row['Low'] || row['low_p']),
        high: cleanNumber(row['High'] || row['high_p']),
        oi: cleanNumber(row['Open Int'] || row['oi']),
        oiChange: cleanNumber(row['Change in OI'] || row['oi_change']),
        contracts: cleanNumber(row['No. of contracts'] || row['contracts'])
      };
      records.push(rec);
    });
  });
  debugLog('loadOptionData: files=', files, 'rows=', records.length, 'sampleValidDate=', records.find(r => !isNaN(r.date.getTime()))?.date || 'none');
  return records;
}

/**
 * Group option records by date (YYYY‑MM‑DD key) for quick lookup.
 */
function groupOptionsByDate(data: OptionRow[]): Map<string, OptionRow[]> {
  const map = new Map<string, OptionRow[]>();
  data.forEach((row) => {
    // Skip rows with invalid dates
    if (isNaN(row.date.getTime())) return;
    const key = dateKey(row.date);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  });
  return map;
}

/**
 * Select the option contract to trade based on the underlying price,
 * desired side (long/short) and available snapshot for that date.  For
 * long signals the next 50‑point strike above the ATM is selected; for
 * short signals the strike below is chosen.  Contracts are sorted by
 * expiry (earliest) and by descending open interest and contracts.  If
 * no matching contract is found, null is returned.
 */
function selectContract(snapshot: OptionRow[], side: 'long' | 'short', underlyingClose: number): OptionRow | null {
  // Determine at‑the‑money strike (nearest 50)
  const atm = Math.round(underlyingClose / STRIKE_STEP) * STRIKE_STEP;
  const targetStrike = side === 'long' ? atm + STRIKE_STEP : atm - STRIKE_STEP;
  const desiredType = side === 'long' ? 'CE' : 'PE';
  // Filter by type and strike
  let candidates = snapshot.filter((row) => row.type === desiredType && row.strike === targetStrike);
  if (candidates.length === 0) return null;
  // Discard contracts expiring before the trade date
  const tradeDate = snapshot[0].date;
  candidates = candidates.filter((row) => !isNaN(row.expiryDt.getTime()) && row.expiryDt >= tradeDate);
  if (candidates.length === 0) return null;
  // Sort by expiry ascending, then OI descending, then contracts descending
  candidates.sort((a, b) => {
    const expComp = a.expiryDt.getTime() - b.expiryDt.getTime();
    if (expComp !== 0) return expComp;
    const oiComp = (b.oi - a.oi);
    if (oiComp !== 0) return oiComp;
    return (b.contracts - a.contracts);
  });
  return candidates[0];
}

/**
 * Run the backtest with a dynamic trailing stop.  Once the option hits
 * 1:3 reward, the stop is tightened to 1:2.  The position is then
 * allowed to run toward a larger final target.  If the option price
 * hits the stop or final target on any of the three trading days,
 * the trade is closed.  Otherwise it is closed at the end of the
 * third day at the available LTP or close price.
 *
 * @param daily The array of daily bars with indicators.
 * @param signals The signals generated from the indicators.
 * @param groupedOpts The map of option records keyed by date.
 * @param finalRR The multiple of risk for the final target (e.g. 8 for 1:8).
 */
function backtestTrailing(
  daily: DailyBar[],
  signals: Signal[],
  groupedOpts: Map<string, OptionRow[]>,
  finalRR: number
): TradeRecord[] {
  const trades: TradeRecord[] = [];
  let capital = START_CAPITAL;
  signals.forEach((sig) => {
    const idx = sig.index;
  const tradeDate = sig.date;
  if (isNaN(tradeDate.getTime())) return;
    const side = sig.side;
    const sigType = sig.type;
    const underlyingClose = daily[idx].close;
    // Get snapshot of options for this date
  const key = tradeDate.toISOString().slice(0, 10);
    const snapshot = groupedOpts.get(key);
    if (!snapshot || snapshot.length === 0) {
      debugLog('backtestTrailing: no snapshot for', key, 'signalIndex', idx, 'signalDate', tradeDate.toISOString().slice(0,10));
      return;
    }
    // Choose contract
    const contract = selectContract(snapshot, side, underlyingClose);
    if (!contract) {
      debugLog('backtestTrailing: selectContract returned null', { key, side, underlyingClose });
      return;
    }
    // Determine entry LTP and limit price
    const ltp = contract.ltp || contract.high || contract.low;
    if (!ltp || isNaN(ltp) || ltp <= 0) {
      debugLog('backtestTrailing: invalid ltp for contract', contract);
      return;
    }
    const entryLimit = ltp - ENTRY_BUFFER;
    const cost = entryLimit * LOT_SIZE;
    if (cost > capital) {
      debugLog('backtestTrailing: insufficient capital', { cost, capital });
      return;
    }
    // Risk and targets
    const initialStop = entryLimit - RISK_PER_TRADE;
    const target1 = entryLimit + 3 * RISK_PER_TRADE;
    const trailingStop = entryLimit + 2 * RISK_PER_TRADE;
    const finalTarget = entryLimit + finalRR * RISK_PER_TRADE;
    // Verify limit execution on day 0
    if (isNaN(contract.low) || isNaN(contract.high)) {
      debugLog('backtestTrailing: contract low/high NaN', contract);
      return;
    }
    if (contract.low > entryLimit || contract.high < entryLimit) {
      debugLog('backtestTrailing: entryLimit not within day-0 range', { entryLimit, low: contract.low, high: contract.high });
      return;
    }
    let hitTarget1 = false;
    let currentStop = initialStop;
    let exitPrice: number | undefined;
    let exitDate: Date | undefined;
    // Day 0: check if final target or stop is hit
    if (contract.high >= finalTarget) {
      exitPrice = finalTarget;
      exitDate = tradeDate;
    } else {
      if (contract.high >= target1) {
        hitTarget1 = true;
        currentStop = trailingStop;
      }
      if (contract.low <= currentStop) {
        exitPrice = currentStop;
        exitDate = tradeDate;
      }
    }
    // Iterate up to 3 additional days
    if (exitPrice === undefined) {
      for (let j = 1; j <= 3; j++) {
        const nextIdx = idx + j;
        if (nextIdx >= daily.length) break;
  const nextDate = daily[nextIdx].date;
  if (isNaN(nextDate.getTime())) continue;
  const k = nextDate.toISOString().slice(0, 10);
        const snapNext = groupedOpts.get(k);
        if (!snapNext) continue;
        // Find matching option row
        const rows = snapNext.filter(
          (r) => r.type === contract.type && r.strike === contract.strike && r.expiry === contract.expiry
        );
        if (rows.length === 0) continue;
        const row = rows[0];
        const low = row.low;
        const high = row.high;
        if (isNaN(low) || isNaN(high)) continue;
        if (high >= finalTarget) {
          exitPrice = finalTarget;
          exitDate = nextDate;
          break;
        }
        if (!hitTarget1 && high >= target1) {
          hitTarget1 = true;
          currentStop = trailingStop;
        }
        if (low <= currentStop) {
          exitPrice = currentStop;
          exitDate = nextDate;
          break;
        }
      }
    }
    // If still open, exit at the end of the holding period (3 days after entry)
    if (exitPrice === undefined) {
      const endIdx = Math.min(idx + 3, daily.length - 1);
  const endDate = daily[endIdx].date;
  if (isNaN(endDate.getTime())) return;
  const k = endDate.toISOString().slice(0, 10);
      const snapEnd = groupedOpts.get(k);
      if (snapEnd) {
        const rows = snapEnd.filter(
          (r) => r.type === contract.type && r.strike === contract.strike && r.expiry === contract.expiry
        );
        if (rows.length > 0) {
          const row = rows[0];
          const ltpExit = row.ltp || row.high || row.low;
          if (ltpExit && !isNaN(ltpExit)) {
            exitPrice = ltpExit;
            exitDate = endDate;
          }
        }
      }
    }
    if (exitPrice === undefined) return;
    const profit = (exitPrice - entryLimit) * LOT_SIZE;
    capital += profit;
    trades.push({
      entryDate: tradeDate,
      exitDate: exitDate!,
      signalType: sigType,
      side,
      strike: contract.strike,
      expiry: contract.expiry,
      entryLimit,
      initialStop,
      target1,
      trailingStop,
      finalTarget,
      exitPrice,
      profit,
      capitalAfter: capital
    });
  });
  return trades;
}

/**
 * Main driver to run the backtest.  Adjust the file paths for your minute
 * and option data here.  The script will print a summary and write a
 * detailed CSV of trades for further analysis.
 */
export function main() {
  // ===== Update these paths to point to your actual data files =====
    const minuteFile = 'data/2020-2025_1min.csv';
    const optionFiles = [
      'data/options/2023-25_PE.csv',
      'data/options/2023-25_CE.csv',
  'data/options/OPTIDX_NIFTY_CE_01-Jan-2015_TO_01-Mar-2015.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Mar-2015_TO_01-Jun-2015.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Jun-2015_TO_01-Sep-2015.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Sep-2015_TO_01-Dec-2015.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Dec-2015_TO_31-Dec-2015.csv',

  'data/options/OPTIDX_NIFTY_PE_01-Jan-2015_TO_01-Mar-2015.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Mar-2015_TO_01-Jun-2015.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Jun-2015_TO_01-Sep-2015.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Sep-2015_TO_01-Dec-2015.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Dec-2015_TO_31-Dec-2015.csv',

  'data/options/OPTIDX_NIFTY_CE_01-Jan-2016_TO_01-Mar-2016.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Mar-2016_TO_01-Jun-2016.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Jun-2016_TO_01-Sep-2016.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Sep-2016_TO_01-Dec-2016.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Dec-2016_TO_31-Dec-2016.csv',

  'data/options/OPTIDX_NIFTY_PE_01-Jan-2016_TO_01-Mar-2016.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Mar-2016_TO_01-Jun-2016.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Jun-2016_TO_01-Sep-2016.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Sep-2016_TO_01-Dec-2016.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Dec-2016_TO_31-Dec-2016.csv',

  'data/options/OPTIDX_NIFTY_CE_01-Jan-2017_TO_01-Mar-2017.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Mar-2017_TO_01-Jun-2017.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Jun-2017_TO_01-Sep-2017.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Sep-2017_TO_01-Dec-2017.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Dec-2017_TO_31-Dec-2017.csv',

  'data/options/OPTIDX_NIFTY_PE_01-Jan-2017_TO_01-Mar-2017.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Mar-2017_TO_01-Jun-2017.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Jun-2017_TO_01-Sep-2017.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Sep-2017_TO_01-Dec-2017.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Dec-2017_TO_31-Dec-2017.csv',

  'data/options/OPTIDX_NIFTY_CE_01-Jan-2018_TO_01-Mar-2018.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Mar-2018_TO_01-Jun-2018.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Jun-2018_TO_01-Sep-2018.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Sep-2018_TO_01-Dec-2018.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Dec-2018_TO_31-Dec-2018.csv',

  'data/options/OPTIDX_NIFTY_PE_01-Jan-2018_TO_01-Mar-2018.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Mar-2018_TO_01-Jun-2018.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Jun-2018_TO_01-Sep-2018.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Sep-2018_TO_01-Dec-2018.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Dec-2018_TO_31-Dec-2018.csv',

  'data/options/OPTIDX_NIFTY_CE_01-Jan-2019_TO_01-Mar-2019.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Mar-2019_TO_01-Jun-2019.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Jun-2019_TO_01-Sep-2019.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Sep-2019_TO_01-Dec-2019.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Dec-2019_TO_31-Dec-2019.csv',

  'data/options/OPTIDX_NIFTY_PE_01-Jan-2019_TO_01-Mar-2019.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Mar-2019_TO_01-Jun-2019.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Jun-2019_TO_01-Sep-2019.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Sep-2019_TO_01-Dec-2019.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Dec-2019_TO_31-Dec-2019.csv',

  'data/options/OPTIDX_NIFTY_CE_01-Jan-2020_TO_01-Mar-2020.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Mar-2020_TO_01-Jun-2020.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Jun-2020_TO_01-Sep-2020.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Sep-2020_TO_01-Dec-2020.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Dec-2020_TO_31-Dec-2020.csv',

  'data/options/OPTIDX_NIFTY_PE_01-Jan-2020_TO_01-Mar-2020.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Mar-2020_TO_01-Jun-2020.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Jun-2020_TO_01-Sep-2020.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Sep-2020_TO_01-Dec-2020.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Dec-2020_TO_31-Dec-2020.csv',

  'data/options/OPTIDX_NIFTY_CE_01-Jan-2021_TO_01-Mar-2021.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Mar-2021_TO_01-Jun-2021.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Jun-2021_TO_01-Sep-2021.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Sep-2021_TO_01-Dec-2021.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Dec-2021_TO_31-Dec-2021.csv',

  'data/options/OPTIDX_NIFTY_PE_01-Jan-2021_TO_01-Mar-2021.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Mar-2021_TO_01-Jun-2021.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Jun-2021_TO_01-Sep-2021.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Sep-2021_TO_01-Dec-2021.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Dec-2021_TO_31-Dec-2021.csv',

  'data/options/OPTIDX_NIFTY_CE_01-Jan-2022_TO_01-Mar-2022.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Mar-2022_TO_01-Jun-2022.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Jun-2022_TO_01-Sep-2022.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Sep-2022_TO_01-Dec-2022.csv',
  'data/options/OPTIDX_NIFTY_CE_02-Dec-2022_TO_31-Dec-2022.csv',

  'data/options/OPTIDX_NIFTY_PE_01-Jan-2022_TO_01-Mar-2022.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Mar-2022_TO_01-Jun-2022.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Jun-2022_TO_01-Sep-2022.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Sep-2022_TO_01-Dec-2022.csv',
  'data/options/OPTIDX_NIFTY_PE_02-Dec-2022_TO_31-Dec-2022.csv'

    ];
  // ===== End of configurable paths =====

  // Load and process minute data
  const minuteData = loadMinuteData(minuteFile);
  const daily = aggregateToDaily(minuteData);
  const dailyWithIndicators = computeIndicators(daily);
  // Generate signals
  const signals = generateSignalsDebug(dailyWithIndicators);
  // Load and group option data
  const optionData = loadOptionData(optionFiles);
  const grouped = groupOptionsByDate(optionData);
  // Run backtest with final target 1:8 (8× risk).  You can test 5 or 6 as well.
  const finalRR = 8;
  const trades = backtestTrailing(dailyWithIndicators, signals, grouped, finalRR);
  // Summarise results
  const wins = trades.filter((t) => t.profit > 0).length;
  const losses = trades.length - wins;
  const winRate = trades.length ? wins / trades.length : 0;
  const totalProfit = trades.reduce((acc, t) => acc + t.profit, 0);
  const finalCapital = START_CAPITAL + totalProfit;
  console.log(`Total trades: ${trades.length}`);
  console.log(`Wins: ${wins}, Losses: ${losses}, Win rate: ${(winRate * 100).toFixed(2)}%`);
  console.log(`Total profit: ₹${totalProfit.toFixed(2)}`);
  console.log(`Final capital: ₹${finalCapital.toFixed(2)}`);
  // Write CSV of trades
  const csvHeader = [
    'entryDate', 'exitDate', 'signalType', 'side', 'strike', 'expiry',
    'entryLimit', 'initialStop', 'target1', 'trailingStop', 'finalTarget',
    'exitPrice', 'profit', 'capitalAfter'
  ];
  const csvLines = [csvHeader.join(',')];
  trades.forEach((t) => {
    const line = [
      t.entryDate.toISOString().slice(0, 10),
      t.exitDate.toISOString().slice(0, 10),
      t.signalType,
      t.side,
      t.strike,
      t.expiry,
      t.entryLimit.toFixed(2),
      t.initialStop.toFixed(2),
      t.target1.toFixed(2),
      t.trailingStop.toFixed(2),
      t.finalTarget.toFixed(2),
      t.exitPrice.toFixed(2),
      t.profit.toFixed(2),
      t.capitalAfter.toFixed(2)
    ].join(',');
    csvLines.push(line);
  });
  fs.writeFileSync('trades_high_freq_trailing.csv', csvLines.join('\n'), 'utf8');
  console.log('Detailed trades written to trades_high_freq_trailing.csv');
}

// Execute main if run directly (not when imported)
if (require.main === module) {
  main();
}