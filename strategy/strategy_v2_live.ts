/*
 * Live Trading Integration for High-Frequency Nifty Option Strategy
 *
 * This module integrates the strategy_v2 backtesting logic with the Zerodha
 * KiteConnect API to place actual orders in the market. It includes:
 * - Real-time market data fetching
 * - Order placement with limit orders
 * - Dynamic trailing stop-loss management
 * - Position monitoring and exit management
 *
 * IMPORTANT: This is real money trading. Test thoroughly in paper trading
 * mode before using with real capital. Use at your own risk.
 */

import { KiteConnect } from '../lib';
import { Varieties, Exchanges, TransactionTypes, Products, OrderTypes, Validities } from '../interfaces';
import * as fs from 'fs';
import { parse as csvParse } from 'csv-parse/sync';

// Import types from strategy_v2
import { DailyBar, Signal, TradeRecord } from './strategy_v2';

/**
 * Minute-level bar interface
 */
export interface MinuteBar {
  datetime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * 15-minute bar interface (same structure as DailyBar but for 15-min intervals)
 */
export interface Bar15Min {
  datetime: Date;
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

/**
 * Option chain row interface
 */
export interface OptionChainRow {
  tradingsymbol: string;
  strike: number;
  expiry: Date;
  instrument_type: 'CE' | 'PE';
  last_price: number;
  oi: number;
  volume: number;
  bid: number;
  ask: number;
}

/**
 * Configuration interface for live trading
 */
export interface LiveTradingConfig {
  apiKey: string;
  accessToken: string;
  capital: number;
  riskPerTrade: number;
  entryBuffer: number;
  strikeStep: number;
  lotSize: number;
  finalRR: number; // Final Risk:Reward ratio (default 8 for 1:8)
  enableTrailing: boolean;
  maxPositions: number;
  debugMode: boolean;
}

// ============================================================================
// INDICATOR CALCULATION FUNCTIONS (adapted for 15-minute bars)
// ============================================================================

/**
 * Aggregate minute bars into 15-minute OHLC bars
 */
function aggregateTo15Min(minuteBars: MinuteBar[]): Bar15Min[] {
  const bars15Min: Bar15Min[] = [];
  
  // Group bars by 15-minute intervals
  let currentBar: MinuteBar[] = [];
  let barStartTime: Date | null = null;
  
  minuteBars.forEach((bar, index) => {
    const barTime = new Date(bar.datetime);
    const minutes = barTime.getHours() * 60 + barTime.getMinutes();
    
    // Calculate which 15-min slot this belongs to (9:15, 9:30, 9:45, etc.)
    const slotMinutes = Math.floor(minutes / 15) * 15;
    const slotTime = new Date(barTime);
    slotTime.setHours(Math.floor(slotMinutes / 60));
    slotTime.setMinutes(slotMinutes % 60);
    slotTime.setSeconds(0);
    slotTime.setMilliseconds(0);
    
    // If new slot, create bar from previous slot
    if (barStartTime && slotTime.getTime() !== barStartTime.getTime()) {
      if (currentBar.length > 0) {
        const open = currentBar[0].open;
        const high = Math.max(...currentBar.map(b => b.high));
        const low = Math.min(...currentBar.map(b => b.low));
        const close = currentBar[currentBar.length - 1].close;
        
        bars15Min.push({
          datetime: barStartTime,
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
      }
      currentBar = [];
    }
    
    barStartTime = slotTime;
    currentBar.push(bar);
    
    // Handle last bar
    if (index === minuteBars.length - 1 && currentBar.length > 0) {
      const open = currentBar[0].open;
      const high = Math.max(...currentBar.map(b => b.high));
      const low = Math.min(...currentBar.map(b => b.low));
      const close = currentBar[currentBar.length - 1].close;
      
      bars15Min.push({
        datetime: barStartTime,
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
    }
  });
  
  return bars15Min;
}

/**
 * Compute indicators for 15-minute bars
 * Adjusted periods for 15-min timeframe:
 * - BB: 40 bars (10 hours of trading)
 * - SMA: 80 bars (20 hours of trading) 
 * - ATR: 40 bars (10 hours of trading)
 * This gives similar lookback to daily strategy (10/20/10 days)
 */
function computeIndicators15Min(
  bars: Bar15Min[],
  bbPeriod = 50,
  smaPeriod = 100,
  atrPeriod = 14
): Bar15Min[] {
  const closes = bars.map((d) => d.close);
  const highs = bars.map((d) => d.high);
  const lows = bars.map((d) => d.low);
  
  // Compute SMA
  const sma: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < smaPeriod - 1) {
      sma.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - smaPeriod + 1; j <= i; j++) sum += closes[j];
      sma.push(sum / smaPeriod);
    }
  }
  
  // Compute Bollinger Bands
  const bbMid: number[] = [];
  const bbUpper: number[] = [];
  const bbLower: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < bbPeriod - 1) {
      bbMid.push(NaN);
      bbUpper.push(NaN);
      bbLower.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - bbPeriod + 1; j <= i; j++) sum += closes[j];
      const mean = sum / bbPeriod;
      
      // Compute standard deviation
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
  
  // Compute ATR
  const trueRanges: number[] = [];
  for (let i = 0; i < bars.length; i++) {
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
  for (let i = 0; i < bars.length; i++) {
    if (i < atrPeriod) {
      atr.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - atrPeriod + 1; j <= i; j++) sum += trueRanges[j];
      atr.push(sum / atrPeriod);
    }
  }
  
  // Assign values back to bars; backfill NaNs for early periods
  let lastSma = 0;
  let lastBbMid = 0;
  let lastBbUpper = 0;
  let lastBbLower = 0;
  let lastAtr = 0;
  
  return bars.map((d, i) => {
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
 * Generate trading signals from 15-minute bars with indicators
 * Same logic as daily strategy but on 15-min timeframe
 */
function generateSignals15Min(bars: Bar15Min[]): Signal[] {
  const signals: Signal[] = [];
  
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const prev = bars[i - 1];
    
    // Skip if indicators not ready
    if (bar.atr === 0 || bar.sma === 0) continue;
    
    // Bollinger Band reversal signals
    if (bar.close < bar.bbLower) {
      signals.push({
        index: i,
        date: bar.datetime,
        side: 'long',
        type: 'BB_reversal'
      });
    } else if (bar.close > bar.bbUpper) {
      signals.push({
        index: i,
        date: bar.datetime,
        side: 'short',
        type: 'BB_reversal'
      });
    }
    
    // Trend-filtered breakout signals (0.3 × ATR threshold)
    const threshold = 0.3;
    if (
      bar.close > prev.close + threshold * bar.atr &&
      bar.close > bar.sma &&
      bar.sma > prev.sma
    ) {
      signals.push({
        index: i,
        date: bar.datetime,
        side: 'long',
        type: 'breakout'
      });
    }
    
    if (
      bar.close < prev.close - threshold * bar.atr &&
      bar.close < bar.sma &&
      bar.sma < prev.sma
    ) {
      signals.push({
        index: i,
        date: bar.datetime,
        side: 'short',
        type: 'breakout'
      });
    }
  }
  
  return signals;
}

/**
 * Position tracking interface
 */
export interface LivePosition {
  orderId: string;
  entryDate: Date;
  entryBarIndex: number; // Track which 15-min bar we entered (for holding period)
  side: 'long' | 'short';
  strike: number;
  expiry: string;
  tradingSymbol: string;
  entryPrice: number;
  quantity: number;
  initialStop: number;
  target1: number; // 1:3 target
  trailingStop: number; // 1:2 stop after hitting 1:3
  finalTarget: number; // 1:8 or configured target
  status: 'active' | 'trailing' | 'closed';
  currentPrice?: number;
  intradayHigh?: number; // Track intraday high for accurate target detection
  intradayLow?: number;  // Track intraday low for accurate stop detection
  profit?: number;
  signalType?: string; // BB_reversal or breakout
}


/**
 * Live Trading Manager for Nifty Options Strategy
 */
export class LiveStrategyManager {
  private kc: KiteConnect;
  private config: LiveTradingConfig;
  private positions: Map<string, LivePosition>;
  private capital: number;
  private tradingActive: boolean;
  private bars15Min: Bar15Min[]; // Store computed 15-min bars with indicators
  private currentBarIndex: number; // Track current 15-min bar index

  constructor(config: LiveTradingConfig) {
    this.config = config;
    this.capital = config.capital;
    this.positions = new Map();
    this.tradingActive = false;
    this.bars15Min = [];
    this.currentBarIndex = 0;

    // Initialize KiteConnect
    this.kc = new KiteConnect({
      api_key: config.apiKey,
      access_token: config.accessToken,
      debug: false  // Disable axios verbose logging
    });

    this.log('Live Strategy Manager initialized (15-min timeframe)');
  }

  /**
   * Logging helper
   */
  private log(...args: any[]) {
    if (this.config.debugMode) {
      console.log(`[${new Date().toISOString()}]`, ...args);
    }
  }

  /**
   * Fetch historical minute data from KiteConnect API
   * @param days Number of days to fetch (default 60 for sufficient indicator calculation)
   */
  public async fetchHistoricalData(days: number = 60): Promise<MinuteBar[]> {
    try {
      this.log(`Fetching ${days} days of historical minute data...`);
      
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - days);
      
      // Fetch minute data for Nifty 50
      const response = await this.kc.getHistoricalData(
        '256265', // Nifty 50 instrument token
        'minute',
        fromDate.toISOString().slice(0, 10),
        toDate.toISOString().slice(0, 10)
      );
      
      // Extract data from response
      const historicalData = Array.isArray(response) ? response : (response as any).data || [];
      
      const minuteBars: MinuteBar[] = historicalData.map((candle: any) => ({
        datetime: new Date(candle.date),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      }));
      
      this.log(`Fetched ${minuteBars.length} minute bars`);
      return minuteBars;
    } catch (error) {
      this.log('Error fetching historical data:', error);
      throw error;
    }
  }

  /**
   * Update 15-minute bars and indicators with latest data
   */
  public async updateIndicators(): Promise<void> {
    try {
      const minuteBars = await this.fetchHistoricalData(10); // Fetch 10 days for sufficient 15-min bars
      const bars15Min = aggregateTo15Min(minuteBars);
      this.bars15Min = computeIndicators15Min(bars15Min);
      
      // Update current bar index - find the latest complete 15-min bar
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const currentSlot = Math.floor(currentMinutes / 15) * 15;
      
      // Find index of current or most recent bar
      let foundIndex = -1;
      for (let i = this.bars15Min.length - 1; i >= 0; i--) {
        const barTime = this.bars15Min[i].datetime;
        const barMinutes = barTime.getHours() * 60 + barTime.getMinutes();
        if (barMinutes <= currentSlot) {
          foundIndex = i;
          break;
        }
      }
      
      if (foundIndex >= 0) {
        this.currentBarIndex = foundIndex;
      } else {
        this.currentBarIndex = this.bars15Min.length - 1;
      }
      
      this.log(`Updated indicators. 15-min bars: ${this.bars15Min.length}, Current index: ${this.currentBarIndex}`);
      
      if (this.config.debugMode && this.bars15Min.length > 0) {
        const latest = this.bars15Min[this.bars15Min.length - 1];
        this.log('Latest 15-min bar indicators:', {
          time: latest.datetime.toISOString(),
          close: latest.close.toFixed(2),
          sma: latest.sma.toFixed(2),
          bbUpper: latest.bbUpper.toFixed(2),
          bbMid: latest.bbMid.toFixed(2),
          bbLower: latest.bbLower.toFixed(2),
          atr: latest.atr.toFixed(2)
        });
      }
    } catch (error) {
      this.log('Error updating indicators:', error);
      throw error;
    }
  }

  /**
   * Generate trading signals based on current indicators
   * Returns signals from recent bars (last 10 bars to catch latest signals)
   */
  public generateTodaySignals(): Signal[] {
    if (this.bars15Min.length < 2) {
      this.log('Not enough 15-min bars to generate signals');
      return [];
    }
    
    // Generate all signals
    const allSignals = generateSignals15Min(this.bars15Min);
    
    // Filter for recent signals (last 10 bars - about 2.5 hours)
    const recentBarStart = Math.max(0, this.bars15Min.length - 10);
    const recentSignals = allSignals.filter((s: Signal) => s.index >= recentBarStart);
    
    if (recentSignals.length > 0) {
      this.log(`Generated ${recentSignals.length} signals from recent bars:`, recentSignals);
    }
    
    return recentSignals;
  }

  /**
   * Get number of lots based on current capital
   */
  private getNumLots(): number {
    if(this.capital >= 2400000) return 24;
    if (this.capital > 200000) return Math.floor(this.capital / 100000);
    return 1;
  }

  /**
   * Find the nearest strike based on spot price
   */
  private async findNearestStrike(spotPrice: number, side: 'CE' | 'PE'): Promise<number> {
    const atmStrike = Math.round(spotPrice / this.config.strikeStep) * this.config.strikeStep;
    
    // For CE (long), go one strike above ATM
    // For PE (short), go one strike below ATM
    if (side === 'CE') {
      return atmStrike + this.config.strikeStep;
    } else {
      return atmStrike - this.config.strikeStep;
    }
  }

  /**
   * Get option chain and select best contract based on OI and volume
   * This matches the selectContract logic from strategy_v2.ts
   */
  private async selectBestContract(
    spotPrice: number,
    side: 'long' | 'short',
    expiry: Date
  ): Promise<OptionChainRow | null> {
    try {
      const optionType = side === 'long' ? 'CE' : 'PE';
      const targetStrike = await this.findNearestStrike(spotPrice, optionType);
      
      this.log(`Selecting contract: strike=${targetStrike}, type=${optionType}, expiry=${expiry.toISOString().slice(0, 10)}`);
      
      // Fetch option chain from KiteConnect
      const instruments = await this.kc.getInstruments(Exchanges.NFO);
      
      // Filter for Nifty options with target strike and type
      const candidates = instruments
        .filter((inst: any) => 
          inst.name === 'NIFTY' &&
          inst.instrument_type === optionType &&
          inst.strike === targetStrike &&
          new Date(inst.expiry) >= new Date() // Not expired
        )
        .map((inst: any) => ({
          tradingsymbol: inst.tradingsymbol,
          strike: inst.strike,
          expiry: new Date(inst.expiry),
          instrument_type: inst.instrument_type,
          instrument_token: inst.instrument_token
        }));
      
      if (candidates.length === 0) {
        this.log('No candidates found for strike', targetStrike);
        return null;
      }
      
      // Sort by expiry (nearest first)
      candidates.sort((a: any, b: any) => a.expiry.getTime() - b.expiry.getTime());
      
      // Get quotes for candidates to check OI and volume
      const symbols = candidates.slice(0, 5).map((c: any) => `NFO:${c.tradingsymbol}`);
      const quotes = await this.kc.getQuote(symbols);
      
      // Enhance candidates with OI and volume data
      const enhancedCandidates: OptionChainRow[] = candidates.slice(0, 5).map((c: any) => {
        const quote = quotes[`NFO:${c.tradingsymbol}`] || {};
        return {
          tradingsymbol: c.tradingsymbol,
          strike: c.strike,
          expiry: c.expiry,
          instrument_type: c.instrument_type,
          last_price: quote.last_price || 0,
          oi: quote.oi || 0,
          volume: quote.volume || 0,
          bid: quote.depth?.buy?.[0]?.price || 0,
          ask: quote.depth?.sell?.[0]?.price || 0
        };
      });
      
      // Sort by OI descending (prefer high liquidity)
      enhancedCandidates.sort((a, b) => b.oi - a.oi);
      
      const selected = enhancedCandidates[0];
      
      if (selected) {
        this.log(`Selected contract: ${selected.tradingsymbol}, OI=${selected.oi}, LTP=${selected.last_price}`);
      }
      
      return selected;
    } catch (error) {
      this.log('Error selecting contract:', error);
      return null;
    }
  }


  /**
   * Get the trading symbol for the option
   * Format: NIFTY[YY][MMM][DD][STRIKE][CE/PE]
   * Example: NIFTY24OCT2424500CE
   */
  private async getOptionTradingSymbol(
    strike: number, 
    optionType: 'CE' | 'PE', 
    expiry: Date
  ): Promise<string> {
    const year = expiry.getFullYear().toString().slice(-2);
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 
                    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const month = months[expiry.getMonth()];
    const day = expiry.getDate().toString().padStart(2, '0');
    
    return `NIFTY${year}${month}${day}${strike}${optionType}`;
  }

  /**
   * Get current market price for an option
   */
  private async getOptionLTP(tradingSymbol: string): Promise<number> {
    try {
      const quote = await this.kc.getLTP([`NFO:${tradingSymbol}`]);
      const ltp = quote[`NFO:${tradingSymbol}`]?.last_price;
      
      if (!ltp) {
        throw new Error(`Could not get LTP for ${tradingSymbol}`);
      }
      
      return ltp;
    } catch (error) {
      this.log(`Error getting LTP for ${tradingSymbol}:`, error);
      throw error;
    }
  }

  /**
   * Get the next weekly expiry for Nifty options
   */
  private async getNextExpiry(): Promise<Date> {
    try {
      // Fetch instruments to get exact expiry dates
      const instruments = await this.kc.getInstruments(Exchanges.NFO);
      
      // Filter for Nifty options and get unique expiry dates
      const niftyExpiries = instruments
        .filter((inst: any) => inst.name === 'NIFTY' && inst.instrument_type === 'CE')
        .map((inst: any) => new Date(inst.expiry))
        .filter((date: Date) => date > new Date())
        .sort((a: Date, b: Date) => a.getTime() - b.getTime());
      
      if (niftyExpiries.length === 0) {
        throw new Error('No upcoming expiries found');
      }
      
      return niftyExpiries[0]; // Return nearest expiry
    } catch (error) {
      this.log('Error fetching expiry dates:', error);
      // Fallback: calculate next Thursday
      const today = new Date();
      const daysUntilThursday = (4 - today.getDay() + 7) % 7 || 7;
      const nextThursday = new Date(today);
      nextThursday.setDate(today.getDate() + daysUntilThursday);
      return nextThursday;
    }
  }

  /**
   * Place a limit order for an option
   */
  private async placeOptionOrder(
    tradingSymbol: string,
    quantity: number,
    limitPrice: number,
    transactionType: 'BUY' | 'SELL'
  ): Promise<string> {
    try {
      this.log(`Placing ${transactionType} order: ${tradingSymbol} @ ₹${limitPrice} x ${quantity}`);
      
      const orderParams = {
        exchange: Exchanges.NFO,
        tradingsymbol: tradingSymbol,
        transaction_type: transactionType === 'BUY' ? TransactionTypes.BUY : TransactionTypes.SELL,
        quantity: quantity,
        product: Products.MIS, // Intraday product
        order_type: OrderTypes.LIMIT,
        price: limitPrice,
        validity: Validities.DAY,
        tag: 'strategy_v2_live'
      };

      const response = await this.kc.placeOrder(Varieties.VARIETY_REGULAR, orderParams);
      this.log(`Order placed successfully. Order ID: ${response.order_id}`);
      
      return response.order_id;
    } catch (error) {
      this.log(`Error placing order:`, error);
      throw error;
    }
  }

  /**
   * Enter a new position based on a signal
   */
  public async enterPosition(signal: Signal, spotPrice: number): Promise<LivePosition | null> {
    const entryAttempt = {
      timestamp: new Date().toISOString(),
      signal: signal.type,
      side: signal.side,
      spotPrice,
      status: 'ATTEMPT',
      error: null as string | null
    };

    try {
      // Check if max positions reached
      if (this.positions.size >= this.config.maxPositions) {
        this.log('Max positions reached. Skipping entry.');
        entryAttempt.status = 'REJECTED';
        entryAttempt.error = 'Max positions reached';
        this.logOrderAttempt(entryAttempt);
        return null;
      }

      // Get expiry
      const expiry = await this.getNextExpiry();
      const expiryStr = expiry.toISOString().slice(0, 10);
      
      // Select best contract based on OI and volume
      const contract = await this.selectBestContract(spotPrice, signal.side, expiry);
      
      if (!contract) {
        this.log('Could not select contract');
        entryAttempt.status = 'FAILED';
        entryAttempt.error = 'Contract selection failed';
        this.logOrderAttempt(entryAttempt);
        return null;
      }
      
      const tradingSymbol = contract.tradingsymbol;
      const strike = contract.strike;
      const ltp = contract.last_price;
      
      // Validate LTP
      if (!ltp || ltp <= 0) {
        this.log('Invalid LTP:', ltp);
        entryAttempt.status = 'FAILED';
        entryAttempt.error = 'Invalid LTP';
        this.logOrderAttempt(entryAttempt);
        return null;
      }
      
      // Calculate entry price (10 rupees below LTP)
      const entryPrice = Math.max(ltp - this.config.entryBuffer, 0.05);
      
      // Validate entry price is reachable (within bid-ask spread or close to LTP)
      if (contract.bid > 0 && entryPrice < contract.bid * 0.95) {
        this.log('Entry price too far from bid. Adjusting...');
        // Adjust to be within reasonable range
      }
      
      // Calculate stop loss and targets
      const initialStop = entryPrice - this.config.riskPerTrade;
      const target1 = entryPrice + (this.config.riskPerTrade * 3); // 1:3
      const trailingStop = entryPrice + (this.config.riskPerTrade * 2); // 1:2
      const finalTarget = entryPrice + (this.config.riskPerTrade * this.config.finalRR); // 1:8
      
      // Calculate quantity
      const numLots = this.getNumLots();
      const quantity = numLots * this.config.lotSize;
      
      // Check if we have sufficient capital
      const cost = entryPrice * quantity;
      if (cost > this.capital * 0.8) { // Use max 80% of capital per trade
        this.log('Insufficient capital for trade');
        entryAttempt.status = 'REJECTED';
        entryAttempt.error = 'Insufficient capital';
        this.logOrderAttempt(entryAttempt);
        return null;
      }
      
      // Place order
      const orderId = await this.placeOptionOrder(tradingSymbol, quantity, entryPrice, 'BUY');
      
      // Wait a moment and verify order status
      await new Promise(resolve => setTimeout(resolve, 1000));
      const orderStatus = await this.verifyOrderFill(orderId);
      
      if (!orderStatus.filled) {
        this.log('Order not filled. Status:', orderStatus.status);
        entryAttempt.status = 'FAILED';
        entryAttempt.error = `Order not filled: ${orderStatus.status}`;
        this.logOrderAttempt(entryAttempt);
        return null;
      }
      
      // Create position record
      const position: LivePosition = {
        orderId,
        entryDate: new Date(),
        entryBarIndex: this.currentBarIndex, // Track entry bar for holding period
        side: signal.side,
        strike,
        expiry: expiryStr,
        tradingSymbol,
        entryPrice: orderStatus.averagePrice || entryPrice, // Use actual fill price
        quantity,
        initialStop,
        target1,
        trailingStop,
        finalTarget,
        status: 'active',
        intradayHigh: orderStatus.averagePrice || entryPrice,
        intradayLow: orderStatus.averagePrice || entryPrice,
        signalType: signal.type
      };
      
      // Store position
      this.positions.set(orderId, position);
      
      this.log(`Position entered: ${tradingSymbol} @ ₹${position.entryPrice}`);
      this.log(`Targets: T1=₹${target1}, Final=₹${finalTarget}, Stop=₹${initialStop}`);
      
      // Log successful entry
      entryAttempt.status = 'SUCCESS';
      const entryLog = {
        ...entryAttempt,
        orderId,
        tradingSymbol,
        strike,
        optionType: contract.instrument_type,
        ltp,
        entryPrice: position.entryPrice,
        quantity,
        targets: { target1, trailingStop, finalTarget },
        initialStop,
        oi: contract.oi,
        volume: contract.volume
      };
      this.logOrderAttempt(entryLog);
      
      return position;
    } catch (error) {
      this.log('Error entering position:', error);
      entryAttempt.status = 'FAILED';
      entryAttempt.error = error instanceof Error ? error.message : String(error);
      this.logOrderAttempt(entryAttempt);
      return null;
    }
  }

  /**
   * Verify if an order was filled
   */
  private async verifyOrderFill(orderId: string): Promise<{ filled: boolean; status: string; averagePrice?: number }> {
    try {
      const orders = await this.kc.getOrders();
      const order = orders.find((o: any) => o.order_id === orderId);
      
      if (!order) {
        return { filled: false, status: 'NOT_FOUND' };
      }
      
      const filled = order.status === 'COMPLETE';
      return {
        filled,
        status: order.status,
        averagePrice: order.average_price
      };
    } catch (error) {
      this.log('Error verifying order:', error);
      return { filled: false, status: 'ERROR' };
    }
  }

  /**
   * Monitor and manage open positions
   * Now includes intraday high/low tracking and bar-based holding logic
   * For 15-min bars: 3 days = 3 * 6.25 hours * 4 bars/hour = ~75 bars
   */
  public async monitorPositions(): Promise<void> {
    if (this.positions.size === 0) {
      return;
    }

    const MAX_HOLDING_BARS = 75; // Approximately 3 trading days in 15-min bars

    for (const [orderId, position] of this.positions) {
      try {
        // Get current price
        const currentPrice = await this.getOptionLTP(position.tradingSymbol);
        position.currentPrice = currentPrice;
        
        // Update intraday high/low for accurate stop/target detection
        if (!position.intradayHigh || currentPrice > position.intradayHigh) {
          position.intradayHigh = currentPrice;
        }
        if (!position.intradayLow || currentPrice < position.intradayLow) {
          position.intradayLow = currentPrice;
        }
        
        this.log(`Monitoring ${position.tradingSymbol}: Current=₹${currentPrice}, High=₹${position.intradayHigh}, Low=₹${position.intradayLow}, Entry=₹${position.entryPrice}`);
        
        // Check bar-based holding period (max ~75 bars = 3 trading days)
        const barsHeld = this.currentBarIndex - position.entryBarIndex;
        if (barsHeld >= MAX_HOLDING_BARS) {
          this.log(`Max holding period reached for ${position.tradingSymbol} (${barsHeld} bars). Exiting...`);
          await this.exitPosition(orderId, currentPrice, 'max_holding_period');
          continue;
        }
        
        // Check if initial stop-loss is hit (using intraday low)
        if (position.status === 'active' && position.intradayLow <= position.initialStop) {
          this.log(`Stop-loss hit for ${position.tradingSymbol}. Exiting...`);
          await this.exitPosition(orderId, currentPrice, 'stop_loss');
          continue;
        }
        
        // Check if first target (1:3) is hit - activate trailing stop (using intraday high)
        if (position.status === 'active' && position.intradayHigh >= position.target1) {
          this.log(`Target 1:3 hit for ${position.tradingSymbol}. Activating trailing stop at ₹${position.trailingStop}`);
          position.status = 'trailing';
        }
        
        // Check trailing stop (using intraday low)
        if (position.status === 'trailing' && position.intradayLow <= position.trailingStop) {
          this.log(`Trailing stop hit for ${position.tradingSymbol}. Exiting...`);
          await this.exitPosition(orderId, currentPrice, 'trailing_stop');
          continue;
        }
        
        // Check final target (using intraday high)
        if (position.intradayHigh >= position.finalTarget) {
          this.log(`Final target hit for ${position.tradingSymbol}. Exiting...`);
          await this.exitPosition(orderId, currentPrice, 'target');
          continue;
        }
        
        // Check for Friday exit (if today is Friday and after 3:15pm)
        const now = new Date();
        if (now.getDay() === 5 && now.getHours() >= 15 && now.getMinutes() >= 15) {
          this.log(`Friday exit for ${position.tradingSymbol}. Exiting...`);
          await this.exitPosition(orderId, currentPrice, 'friday_exit');
          continue;
        }
        
      } catch (error) {
        this.log(`Error monitoring position ${orderId}:`, error);
      }
    }
  }

  /**
   * Exit a position
   */
  private async exitPosition(orderId: string, exitPrice: number, reason: string): Promise<void> {
    const position = this.positions.get(orderId);
    if (!position) {
      this.log(`Position ${orderId} not found`);
      return;
    }

    try {
      // Place exit order (sell)
      await this.placeOptionOrder(
        position.tradingSymbol,
        position.quantity,
        exitPrice,
        'SELL'
      );
      
      // Calculate profit
      const profit = (exitPrice - position.entryPrice) * position.quantity;
      position.profit = profit;
      position.status = 'closed';
      
      // Update capital
      this.capital += profit;
      
      this.log(`Position closed: ${position.tradingSymbol}`);
      this.log(`Exit: ₹${exitPrice}, Profit: ₹${profit.toFixed(2)}, Reason: ${reason}`);
      this.log(`Updated capital: ₹${this.capital.toFixed(2)}`);
      
      // Remove from active positions
      this.positions.delete(orderId);
      
      // Save trade record
      await this.saveTradeRecord(position, exitPrice, reason);
      
    } catch (error) {
      this.log(`Error exiting position ${orderId}:`, error);
      throw error;
    }
  }

  /**
   * Log order attempt (entry/exit)
   */
  private logOrderAttempt(data: any): void {
    try {
      const logEntry = {
        timestamp: new Date().toISOString(),
        type: 'ORDER_ATTEMPT',
        ...data
      };
      const line = JSON.stringify(logEntry) + '\n';
      fs.appendFileSync('strategy/order_log.jsonl', line, 'utf8');
      
      // Also log to console in debug mode
      if (this.config.debugMode) {
        console.log('[ORDER LOG]', logEntry.status, logEntry);
      }
    } catch (error) {
      console.error('Error writing order log:', error);
    }
  }

  /**
   * Save trade record to file
   */
  private async saveTradeRecord(position: LivePosition, exitPrice: number, reason: string): Promise<void> {
    const barsHeld = this.currentBarIndex - position.entryBarIndex;
    const hoursHeld = (barsHeld * 15) / 60; // Convert 15-min bars to hours
    
    const record = {
      entryDate: position.entryDate.toISOString(),
      exitDate: new Date().toISOString(),
      orderId: position.orderId,
      tradingSymbol: position.tradingSymbol,
      side: position.side,
      strike: position.strike,
      expiry: position.expiry,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      profit: position.profit,
      profitPercentage: ((exitPrice - position.entryPrice) / position.entryPrice * 100).toFixed(2),
      capital: this.capital,
      reason,
      status: position.status,
      signalType: position.signalType,
      barsHeld,
      hoursHeld: hoursHeld.toFixed(2)
    };
    
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync('strategy/live_trades.jsonl', line, 'utf8');
    
    // Also log exit attempt
    this.logOrderAttempt({
      type: 'EXIT',
      status: 'SUCCESS',
      orderId: position.orderId,
      tradingSymbol: position.tradingSymbol,
      exitPrice,
      profit: position.profit,
      reason
    });
  }

  /**
   * Get today's P&L from closed positions
   */
  public getTodayPnL(): number {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const logPath = 'strategy/live_trades.jsonl';
      
      if (!fs.existsSync(logPath)) return 0;
      
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.trim().split('\n').filter(l => l);
      
      let todayPnL = 0;
      lines.forEach(line => {
        try {
          const record = JSON.parse(line);
          const exitDate = new Date(record.exitDate).toISOString().slice(0, 10);
          if (exitDate === today) {
            todayPnL += record.profit || 0;
          }
        } catch (e) {
          // Skip invalid lines
        }
      });
      
      return todayPnL;
    } catch (error) {
      this.log('Error calculating today PnL:', error);
      return 0;
    }
  }

  /**
   * Get today's trade count
   */
  public getTodayTradeCount(): number {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const logPath = 'strategy/live_trades.jsonl';
      
      if (!fs.existsSync(logPath)) return 0;
      
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.trim().split('\n').filter(l => l);
      
      let count = 0;
      lines.forEach(line => {
        try {
          const record = JSON.parse(line);
          const entryDate = new Date(record.entryDate).toISOString().slice(0, 10);
          if (entryDate === today) {
            count++;
          }
        } catch (e) {
          // Skip invalid lines
        }
      });
      
      return count;
    } catch (error) {
      this.log('Error calculating today trade count:', error);
      return 0;
    }
  }


  /**
   * Get Nifty spot price
   */
  public async getNiftySpot(): Promise<number> {
    try {
      const quote = await this.kc.getLTP(['NSE:NIFTY 50']);
      return quote['NSE:NIFTY 50']?.last_price || 0;
    } catch (error) {
      this.log('Error getting Nifty spot:', error);
      throw error;
    }
  }

  /**
   * Get Nifty OHLC data
   */
  public async getNiftyOHLC(): Promise<any> {
    try {
      const ohlc = await this.kc.getOHLC(['NSE:NIFTY 50']);
      return ohlc['NSE:NIFTY 50'] || { open: 0, high: 0, low: 0, close: 0 };
    } catch (error) {
      this.log('Error getting Nifty OHLC:', error);
      throw error;
    }
  }

  /**
   * Get Nifty full quote with all details
   */
  public async getNiftyQuote(): Promise<any> {
    try {
      const quote = await this.kc.getQuote(['NSE:NIFTY 50']);
      return quote['NSE:NIFTY 50'] || null;
    } catch (error) {
      this.log('Error getting Nifty quote:', error);
      throw error;
    }
  }

  /**
   * Get current positions summary
   */
  public getPositionsSummary(): any[] {
    return Array.from(this.positions.values()).map(pos => ({
      tradingSymbol: pos.tradingSymbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      currentPrice: pos.currentPrice,
      quantity: pos.quantity,
      status: pos.status,
      unrealizedPnL: pos.currentPrice 
        ? (pos.currentPrice - pos.entryPrice) * pos.quantity 
        : 0
    }));
  }

  /**
   * Get account summary
   */
  public async getAccountSummary(): Promise<any> {
    try {
      const margins = await this.kc.getMargins();
      const positions = await this.kc.getPositions();
      
      return {
        capital: this.capital,
        availableMargin: margins.equity?.available?.live_balance || 0,
        cashBalance: margins.equity?.available?.cash || 0,
        collateral: margins.equity?.available?.collateral || 0,
        usedMargin: margins.equity?.utilised?.debits || 0,
        totalMargin: (margins.equity?.available?.live_balance || 0) + (margins.equity?.utilised?.debits || 0),
        openPositions: this.positions.size,
        positionDetails: this.getPositionsSummary(),
        marginDetails: margins.equity // Full margin object for detailed logging
      };
    } catch (error) {
      this.log('Error getting account summary:', error);
      throw error;
    }
  }

  /**
   * Emergency - close all positions
   */
  public async closeAllPositions(): Promise<void> {
    this.log('EMERGENCY: Closing all positions...');
    
    for (const [orderId, position] of this.positions) {
      try {
        const currentPrice = await this.getOptionLTP(position.tradingSymbol);
        await this.exitPosition(orderId, currentPrice, 'emergency_exit');
      } catch (error) {
        this.log(`Error closing position ${orderId}:`, error);
      }
    }
    
    this.tradingActive = false;
    this.log('All positions closed.');
  }

  /**
   * Start trading
   */
  public startTrading(): void {
    this.tradingActive = true;
    this.log('Trading started');
  }

  /**
   * Stop trading
   */
  public stopTrading(): void {
    this.tradingActive = false;
    this.log('Trading stopped');
  }

  /**
   * Check if trading is active
   */
  public isActive(): boolean {
    return this.tradingActive;
  }

  /**
   * Get current bar information for debugging
   */
  public getCurrentBarInfo(): any {
    if (this.bars15Min.length === 0) {
      return null;
    }
    
    const currentBar = this.bars15Min[this.currentBarIndex];
    return {
      time: currentBar.datetime.toISOString(),
      barIndex: this.currentBarIndex,
      close: currentBar.close,
      sma: currentBar.sma,
      bbUpper: currentBar.bbUpper,
      bbMid: currentBar.bbMid,
      bbLower: currentBar.bbLower,
      atr: currentBar.atr
    };
  }
}

/**
 * Example usage
 */
export async function runLiveTrading() {
  // Load configuration
  const config: LiveTradingConfig = {
    apiKey: process.env.KITE_API_KEY || 'your_api_key',
    accessToken: process.env.KITE_ACCESS_TOKEN || 'your_access_token',
    capital: 15000,
    riskPerTrade: 10,
    entryBuffer: 10,
    strikeStep: 50,
    lotSize: 75,
    finalRR: 8,
    enableTrailing: true,
    maxPositions: 3,
    debugMode: true
  };

  const manager = new LiveStrategyManager(config);
  manager.startTrading();

  // Monitor positions every 30 seconds
  const monitorInterval = setInterval(async () => {
    if (manager.isActive()) {
      await manager.monitorPositions();
      
      // Get account summary
      const summary = await manager.getAccountSummary();
      console.log('Account Summary:', summary);
    }
  }, 30000); // 30 seconds

  process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    manager.stopTrading();
    clearInterval(monitorInterval);
    await manager.closeAllPositions();
    process.exit(0);
  });

  console.log('Live trading started. Press Ctrl+C to stop.');
}

export default LiveStrategyManager;
