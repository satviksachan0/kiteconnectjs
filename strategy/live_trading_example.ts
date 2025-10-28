/*
 * Example: Live Trading with Strategy V2
 * 
 * This example demonstrates how to use the live trading integration
 * with the Zerodha KiteConnect API to execute the high-frequency
 * Nifty options strategy.
 * 
 * IMPORTANT STEPS BEFORE RUNNING:
 * 
 * 1. Get API Credentials:
 *    - Sign up for Kite Connect at https://kite.trade/
 *    - Create an app and get your API Key and API Secret
 * 
 * 2. Generate Access Token:
 *    - Run the authentication flow to get your access token
 *    - See the generateAccessToken() function below
 * 
 * 3. Configure Environment:
 *    - Copy .env.template to .env
 *    - Fill in your credentials and trading parameters
 * 
 * 4. Test in Paper Trading Mode:
 *    - Set DRY_RUN=true in .env
 *    - Test thoroughly before going live
 * 
 * 5. Run Live Trading:
 *    - Set DRY_RUN=false in .env
 *    - Monitor carefully and be ready to stop if needed
 */

import { KiteConnect } from '../lib';
import LiveStrategyManager from './strategy_v2_live';
import { loadConfig, isMarketOpen, isNearMarketClose } from './config';
import { LiveTradingConfig } from './strategy_v2_live';
import * as readline from 'readline';

/**
 * Step 1: Generate Access Token (One-time setup)
 * 
 * Run this function once to get your access token.
 * Store the access token securely and use it for subsequent trading sessions.
 */
export async function generateAccessToken() {
  const apiKey = process.env.KITE_API_KEY || 'your_api_key';
  const apiSecret = process.env.KITE_API_SECRET || 'your_api_secret';
  
  const kc = new KiteConnect({ api_key: apiKey });
  
  // Step 1: Get the login URL
  const loginUrl = kc.getLoginURL();
  console.log('\n=== Zerodha KiteConnect Authentication ===\n');
  console.log('1. Open this URL in your browser:');
  console.log(loginUrl);
  console.log('\n2. Login with your Zerodha credentials');
  console.log('3. After login, you will be redirected to a URL');
  console.log('4. Copy the "request_token" parameter from that URL\n');
  
  // Step 2: Get request token from user
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise<string>((resolve, reject) => {
    rl.question('Enter the request_token: ', async (requestToken) => {
      rl.close();
      
      try {
        // Step 3: Generate session
        const response = await kc.generateSession(requestToken, apiSecret);
        
        console.log('\n=== Authentication Successful! ===\n');
        console.log('Access Token:', response.access_token);
        console.log('User ID:', response.user_id);
        console.log('User Name:', response.user_name);
        console.log('\nAdd this to your .env file:');
        console.log(`KITE_ACCESS_TOKEN=${response.access_token}\n`);
        
        resolve(response.access_token);
      } catch (error) {
        console.error('Error generating session:', error);
        reject(error);
      }
    });
  });
}

/**
 * Step 2: Main Live Trading Function
 * 
 * This is the main function that runs the live trading strategy.
 * It monitors the market, generates signals, and manages positions.
 */
export async function runLiveStrategy() {
  try {
    console.log('\n=== Live Trading Strategy V2 ===\n');
    
    // Load configuration
    const config = loadConfig();
    
    // Check if market is open
    if (!isMarketOpen(config)) {
      console.log('Market is currently closed. Exiting...');
      return;
    }
    
    console.log('Configuration loaded:');
    console.log('- Initial Capital:', config.initialCapital);
    console.log('- Risk Per Trade:', config.riskPerTrade);
    console.log('- Max Positions:', config.maxPositions);
    console.log('- Dry Run Mode:', config.dryRun);
    console.log('- Debug Mode:', config.debugMode);
    console.log('');
    
    // Initialize trading manager
    const tradingConfig: LiveTradingConfig = {
      apiKey: config.apiKey,
      accessToken: config.accessToken,
      capital: config.initialCapital,
      riskPerTrade: config.riskPerTrade,
      entryBuffer: config.entryBuffer,
      strikeStep: config.strikeStep,
      lotSize: config.lotSize,
      finalRR: config.finalRR,
      enableTrailing: config.enableTrailing,
      maxPositions: config.maxPositions,
      debugMode: config.debugMode
    };
    
    const manager = new LiveStrategyManager(tradingConfig);
    
    // Verify connection
    console.log('Verifying connection to Kite API...');
    const summary = await manager.getAccountSummary();
    console.log('Connection successful!\n');
    
    // Display account details
    console.log('=== Account Details ===');
    console.log('Cash Balance: ₹', summary.cashBalance.toFixed(2));
    console.log('Available Margin: ₹', summary.availableMargin.toFixed(2));
    console.log('Used Margin: ₹', summary.usedMargin.toFixed(2));
    console.log('Collateral: ₹', summary.collateral.toFixed(2));
    console.log('Total Margin: ₹', summary.totalMargin.toFixed(2));
    console.log('');
    
    // Display Nifty current data
    try {
      const niftySpot = await manager.getNiftySpot();
      const niftyOHLC = await manager.getNiftyOHLC();
      
      console.log('=== Nifty 50 Current Data ===');
      console.log('LTP (Last Traded Price):', niftySpot.toFixed(2));
      console.log('Open:', niftyOHLC.last_price || niftyOHLC.open || 'N/A');
      console.log('High:', niftyOHLC.high || 'N/A');
      console.log('Low:', niftyOHLC.low || 'N/A');
      console.log('Close (Previous):', niftyOHLC.close || 'N/A');
      console.log('');
    } catch (error) {
      console.log('Could not fetch Nifty data (market may be closed)');
      console.log('');
    }
    
    if (config.dryRun) {
      console.log('=== DRY RUN MODE ===');
      console.log('No actual orders will be placed.');
      console.log('Set DRY_RUN=false in .env to enable live trading.\n');
      return;
    }
    
    // Start trading
    manager.startTrading();
    console.log('Trading started. Press Ctrl+C to stop gracefully.\n');
    
    // Track daily metrics
    let dailyTrades = 0;
    let dailyPnL = 0;
    
    // Main trading loop - runs every 60 seconds
    const tradingInterval = setInterval(async () => {
      try {
        // Check if market is still open
        if (!isMarketOpen(config)) {
          console.log('Market closed. Stopping trading...');
          clearInterval(tradingInterval);
          await manager.closeAllPositions();
          manager.stopTrading();
          return;
        }
        
        // Check daily loss limit
        if (Math.abs(dailyPnL) >= config.maxDailyLoss) {
          console.log(`Daily loss limit reached (₹${config.maxDailyLoss}). Stopping trading...`);
          clearInterval(tradingInterval);
          await manager.closeAllPositions();
          manager.stopTrading();
          return;
        }
        
        // Check daily trade limit
        if (dailyTrades >= config.maxDailyTrades) {
          console.log(`Daily trade limit reached (${config.maxDailyTrades}). Stopping trading...`);
          clearInterval(tradingInterval);
          await manager.closeAllPositions();
          manager.stopTrading();
          return;
        }
        
        // Monitor existing positions
        await manager.monitorPositions();
        
        // Close all positions if near market close
        if (isNearMarketClose(config, 15)) {
          console.log('Near market close. Closing all positions...');
          await manager.closeAllPositions();
          manager.stopTrading();
          clearInterval(tradingInterval);
          return;
        }
        
        // Get account summary and current Nifty price
        const summary = await manager.getAccountSummary();
        let niftySpot = 0;
        try {
          niftySpot = await manager.getNiftySpot();
        } catch (error) {
          // Ignore if market is closed
        }
        
        // Display status
        console.log(`[${new Date().toLocaleTimeString()}] Status:`);
        if (niftySpot > 0) {
          console.log(`  Nifty Spot: ${niftySpot.toFixed(2)}`);
        }
        console.log(`  Capital: ₹${summary.capital.toFixed(2)}`);
        console.log(`  Available Margin: ₹${summary.availableMargin.toFixed(2)}`);
        console.log(`  Used Margin: ₹${summary.usedMargin.toFixed(2)}`);
        console.log(`  Open Positions: ${summary.openPositions}`);
        console.log(`  Daily Trades: ${dailyTrades}`);
        console.log(`  Daily P&L: ₹${dailyPnL.toFixed(2)}`);
        
        if (summary.positionDetails.length > 0) {
          console.log('  Positions:');
          summary.positionDetails.forEach((pos: any) => {
            console.log(`    ${pos.tradingSymbol}: Entry=₹${pos.entryPrice}, Current=₹${pos.currentPrice}, P&L=₹${pos.unrealizedPnL.toFixed(2)}`);
          });
        }
        console.log('');
        
      } catch (error) {
        console.error('Error in trading loop:', error);
      }
    }, 60000); // Check every 60 seconds
    
    // Position monitoring loop - runs every 10 seconds for faster stop-loss checks
    const monitorInterval = setInterval(async () => {
      try {
        if (manager.isActive()) {
          await manager.monitorPositions();
        }
      } catch (error) {
        console.error('Error monitoring positions:', error);
      }
    }, 10000); // Check every 10 seconds
    
    // Graceful shutdown handler
    const shutdown = async () => {
      console.log('\n=== Shutting down gracefully ===\n');
      manager.stopTrading();
      clearInterval(tradingInterval);
      clearInterval(monitorInterval);
      
      console.log('Closing all positions...');
      await manager.closeAllPositions();
      
      console.log('Getting final summary...');
      const finalSummary = await manager.getAccountSummary();
      console.log('\nFinal Status:');
      console.log('Capital:', finalSummary.capital);
      console.log('Daily Trades:', dailyTrades);
      console.log('Daily P&L:', dailyPnL);
      
      console.log('\nTrading session ended. Goodbye!\n');
      process.exit(0);
    };
    
    // Handle various shutdown signals
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGUSR2', shutdown); // For nodemon
    
  } catch (error) {
    console.error('Error in live strategy:', error);
    process.exit(1);
  }
}

/**
 * Step 3: Manual Trading Example
 * 
 * This example shows how to manually enter and monitor positions
 * without the automated signal generation.
 */
export async function manualTrading() {
  const config = loadConfig();
  
  const tradingConfig: LiveTradingConfig = {
    apiKey: config.apiKey,
    accessToken: config.accessToken,
    capital: config.initialCapital,
    riskPerTrade: config.riskPerTrade,
    entryBuffer: config.entryBuffer,
    strikeStep: config.strikeStep,
    lotSize: config.lotSize,
    finalRR: config.finalRR,
    enableTrailing: config.enableTrailing,
    maxPositions: config.maxPositions,
    debugMode: true
  };
  
  const manager = new LiveStrategyManager(tradingConfig);
  manager.startTrading();
  
  // Example: Enter a long position manually
  const spotPrice = await manager.getNiftySpot();
  console.log('Current Nifty Spot:', spotPrice);
  
  // Create a manual signal
  const signal = {
    index: 0,
    date: new Date(),
    side: 'long' as const,
    type: 'BB_reversal' as const
  };
  
  // Enter position
  const position = await manager.enterPosition(signal, spotPrice);
  if (position) {
    console.log('Position entered:', position);
  }
  
  // Monitor for 5 minutes
  const monitorInterval = setInterval(async () => {
    await manager.monitorPositions();
    const summary = await manager.getAccountSummary();
    console.log('Account Summary:', summary);
  }, 30000); // Every 30 seconds
  
  // Auto-exit after 5 minutes
  setTimeout(async () => {
    clearInterval(monitorInterval);
    await manager.closeAllPositions();
    manager.stopTrading();
    console.log('Manual trading session ended.');
    process.exit(0);
  }, 300000); // 5 minutes
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'auth':
      // Generate access token
      await generateAccessToken();
      break;
      
    case 'live':
      // Run live trading strategy
      await runLiveStrategy();
      break;
      
    case 'manual':
      // Run manual trading mode
      await manualTrading();
      break;
      
    default:
      console.log('Usage:');
      console.log('  npm run strategy:auth    - Generate access token');
      console.log('  npm run strategy:live    - Run live trading');
      console.log('  npm run strategy:manual  - Manual trading mode');
      console.log('');
      console.log('Or:');
      console.log('  ts-node strategy/live_trading_example.ts auth');
      console.log('  ts-node strategy/live_trading_example.ts live');
      console.log('  ts-node strategy/live_trading_example.ts manual');
      break;
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export default { generateAccessToken, runLiveStrategy, manualTrading };
