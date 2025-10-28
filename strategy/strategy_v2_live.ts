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

/**
 * Position tracking interface
 */
export interface LivePosition {
  orderId: string;
  entryDate: Date;
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
  profit?: number;
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

  constructor(config: LiveTradingConfig) {
    this.config = config;
    this.capital = config.capital;
    this.positions = new Map();
    this.tradingActive = false;

    // Initialize KiteConnect
    this.kc = new KiteConnect({
      api_key: config.apiKey,
      access_token: config.accessToken,
      debug: config.debugMode
    });

    this.log('Live Strategy Manager initialized');
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
   * Get number of lots based on current capital
   */
  private getNumLots(): number {
    if (this.capital > 300000) return Math.floor(this.capital / 100000);
    if (this.capital > 100000) return 2;
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
    try {
      // Check if max positions reached
      if (this.positions.size >= this.config.maxPositions) {
        this.log('Max positions reached. Skipping entry.');
        return null;
      }

      // Determine option type based on signal side
      const optionType = signal.side === 'long' ? 'CE' : 'PE';
      
      // Find strike
      const strike = await this.findNearestStrike(spotPrice, optionType);
      
      // Get expiry
      const expiry = await this.getNextExpiry();
      const expiryStr = expiry.toISOString().slice(0, 10);
      
      // Get trading symbol
      const tradingSymbol = await this.getOptionTradingSymbol(strike, optionType, expiry);
      
      // Get current LTP
      const ltp = await this.getOptionLTP(tradingSymbol);
      
      // Calculate entry price (10 rupees below LTP)
      const entryPrice = Math.max(ltp - this.config.entryBuffer, 0.05);
      
      // Calculate stop loss and targets
      const initialStop = entryPrice - this.config.riskPerTrade;
      const target1 = entryPrice + (this.config.riskPerTrade * 3); // 1:3
      const trailingStop = entryPrice + (this.config.riskPerTrade * 2); // 1:2
      const finalTarget = entryPrice + (this.config.riskPerTrade * this.config.finalRR); // 1:8
      
      // Calculate quantity
      const numLots = this.getNumLots();
      const quantity = numLots * this.config.lotSize;
      
      // Place order
      const orderId = await this.placeOptionOrder(tradingSymbol, quantity, entryPrice, 'BUY');
      
      // Create position record
      const position: LivePosition = {
        orderId,
        entryDate: new Date(),
        side: signal.side,
        strike,
        expiry: expiryStr,
        tradingSymbol,
        entryPrice,
        quantity,
        initialStop,
        target1,
        trailingStop,
        finalTarget,
        status: 'active'
      };
      
      // Store position
      this.positions.set(orderId, position);
      
      this.log(`Position entered: ${tradingSymbol} @ ₹${entryPrice}`);
      this.log(`Targets: T1=₹${target1}, Final=₹${finalTarget}, Stop=₹${initialStop}`);
      
      return position;
    } catch (error) {
      this.log('Error entering position:', error);
      return null;
    }
  }

  /**
   * Monitor and manage open positions
   */
  public async monitorPositions(): Promise<void> {
    if (this.positions.size === 0) {
      return;
    }

    for (const [orderId, position] of this.positions) {
      try {
        // Get current price
        const currentPrice = await this.getOptionLTP(position.tradingSymbol);
        position.currentPrice = currentPrice;
        
        this.log(`Monitoring ${position.tradingSymbol}: Current=₹${currentPrice}, Entry=₹${position.entryPrice}`);
        
        // Check if initial stop-loss is hit
        if (position.status === 'active' && currentPrice <= position.initialStop) {
          this.log(`Stop-loss hit for ${position.tradingSymbol}. Exiting...`);
          await this.exitPosition(orderId, currentPrice, 'stop_loss');
          continue;
        }
        
        // Check if first target (1:3) is hit - activate trailing stop
        if (position.status === 'active' && currentPrice >= position.target1) {
          this.log(`Target 1:3 hit for ${position.tradingSymbol}. Activating trailing stop at ₹${position.trailingStop}`);
          position.status = 'trailing';
        }
        
        // Check trailing stop
        if (position.status === 'trailing' && currentPrice <= position.trailingStop) {
          this.log(`Trailing stop hit for ${position.tradingSymbol}. Exiting...`);
          await this.exitPosition(orderId, currentPrice, 'trailing_stop');
          continue;
        }
        
        // Check final target
        if (currentPrice >= position.finalTarget) {
          this.log(`Final target hit for ${position.tradingSymbol}. Exiting...`);
          await this.exitPosition(orderId, currentPrice, 'target');
          continue;
        }
        
        // Check for Friday exit (if today is Friday and market is about to close)
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
   * Save trade record to file
   */
  private async saveTradeRecord(position: LivePosition, exitPrice: number, reason: string): Promise<void> {
    const record = {
      entryDate: position.entryDate.toISOString(),
      exitDate: new Date().toISOString(),
      tradingSymbol: position.tradingSymbol,
      side: position.side,
      strike: position.strike,
      expiry: position.expiry,
      entryPrice: position.entryPrice,
      exitPrice,
      quantity: position.quantity,
      profit: position.profit,
      capital: this.capital,
      reason,
      status: position.status
    };
    
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync('live_trades.jsonl', line, 'utf8');
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
