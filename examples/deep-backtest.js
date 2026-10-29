// Run: npm run build && node --env-file=.env examples/deep-backtest.js
import { getIndicator, TradingViewClient } from '@mathieuc/tradingview';

if (!process.env.SESSION || !process.env.SIGNATURE) {
  throw new Error('Set SESSION and SIGNATURE for an account with deep backtest access');
}
const credentials = { session: process.env.SESSION, signature: process.env.SIGNATURE };
const client = new TradingViewClient({ credentials, server: 'history-data' });
let history;
let timeout;
try {
  await client.ready;
  const indicator = await getIndicator('STD;MACD%1Strategy', { credentials });
  history = client.createHistorySession();
  const loaded = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Deep backtest timed out')), 60_000);
    history.on('error', reject);
    history.on('historyLoaded', () => {
      if (history.strategyReport.performance.all) resolve(history.strategyReport);
    });
    history.requestHistoryData('AMEX:SPY', indicator, {
      timeframe: '5', from: Date.UTC(2010, 0, 1) / 1000, to: Math.floor(Date.now() / 1000),
    });
  });
  const report = await loaded;
  console.log('Performance:', report.performance);
  console.log('Trade records:', report.trades.length);
} catch (error) {
  console.error(error.code ?? 'DEEP_BACKTEST_ERROR', error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  history?.delete();
  await client.close();
}
