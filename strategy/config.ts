/*
 * Configuration Module for Live Trading
 * 
 * This module loads configuration from environment variables
 * and provides a typed configuration object for the trading system.
 */

import * as path from 'path';
import * as fs from 'fs';

// Simple .env file parser (no external dependencies)
function loadEnvFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        // Skip comments and empty lines
        if (!trimmed || trimmed.startsWith('#')) continue;
        
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('=').trim();
          process.env[key.trim()] = value;
        }
      }
    }
  } catch (error) {
    console.warn('Could not load .env file:', error);
  }
}

// Load environment variables from .env file
loadEnvFile(path.join(__dirname, '.env'));

export interface TradingConfig {
  // API Credentials
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  
  // Trading Parameters
  initialCapital: number;
  riskPerTrade: number;
  entryBuffer: number;
  strikeStep: number;
  lotSize: number;
  finalRR: number;
  maxPositions: number;
  
  // Trading Controls
  enableTrailing: boolean;
  debugMode: boolean;
  dryRun: boolean;
  
  // Market Hours
  marketStartHour: number;
  marketStartMinute: number;
  marketEndHour: number;
  marketEndMinute: number;
  
  // Risk Management
  maxDailyLoss: number;
  maxDailyTrades: number;
}

/**
 * Load and validate configuration
 */
export function loadConfig(): TradingConfig {
  const config: TradingConfig = {
    // API Credentials
    apiKey: process.env.KITE_API_KEY || '',
    apiSecret: process.env.KITE_API_SECRET || '',
    accessToken: process.env.KITE_ACCESS_TOKEN || '',
    
    // Trading Parameters
    initialCapital: parseInt(process.env.INITIAL_CAPITAL || '15000'),
    riskPerTrade: parseInt(process.env.RISK_PER_TRADE || '10'),
    entryBuffer: parseInt(process.env.ENTRY_BUFFER || '10'),
    strikeStep: parseInt(process.env.STRIKE_STEP || '50'),
    lotSize: parseInt(process.env.LOT_SIZE || '75'),
    finalRR: parseInt(process.env.FINAL_RR || '8'),
    maxPositions: parseInt(process.env.MAX_POSITIONS || '3'),
    
    // Trading Controls
    enableTrailing: process.env.ENABLE_TRAILING === 'true',
    debugMode: process.env.DEBUG_MODE === 'true',
    dryRun: process.env.DRY_RUN === 'true',
    
    // Market Hours
    marketStartHour: parseInt(process.env.MARKET_START_HOUR || '9'),
    marketStartMinute: parseInt(process.env.MARKET_START_MINUTE || '15'),
    marketEndHour: parseInt(process.env.MARKET_END_HOUR || '15'),
    marketEndMinute: parseInt(process.env.MARKET_END_MINUTE || '30'),
    
    // Risk Management
    maxDailyLoss: parseInt(process.env.MAX_DAILY_LOSS || '5000'),
    maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || '10')
  };
  
  // Validate required fields
  if (!config.apiKey) {
    throw new Error('KITE_API_KEY is required');
  }
  
  if (!config.accessToken && !config.dryRun) {
    throw new Error('KITE_ACCESS_TOKEN is required for live trading');
  }
  
  return config;
}

/**
 * Check if market is open
 */
export function isMarketOpen(config: TradingConfig): boolean {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday
  
  // Check if it's a weekend
  if (day === 0 || day === 6) {
    return false;
  }
  
  // Check time
  const hour = now.getHours();
  const minute = now.getMinutes();
  const currentMinutes = hour * 60 + minute;
  const startMinutes = config.marketStartHour * 60 + config.marketStartMinute;
  const endMinutes = config.marketEndHour * 60 + config.marketEndMinute;
  
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * Check if it's near market close
 */
export function isNearMarketClose(config: TradingConfig, minutesBefore: number = 15): boolean {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const currentMinutes = hour * 60 + minute;
  const endMinutes = config.marketEndHour * 60 + config.marketEndMinute;
  
  return (endMinutes - currentMinutes) <= minutesBefore;
}

export default loadConfig;
