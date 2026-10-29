import {
  describe, it, expect, afterAll,
} from 'vitest';
import * as TradingView from '../../src/index.js';
import { credentials, LIVE } from './env.js';

const auth = credentials as NonNullable<typeof credentials>;

// Deep backtests are only served to Premium accounts
describe.skipIf(!LIVE || !credentials || process.env.TV_DEEP_BACKTEST !== '1')('DeepBacktest', () => {
  let client: TradingView.TradingViewClient;
  let history: TradingView.HistorySession;
  let indicator: TradingView.PineIndicator;

  afterAll(async () => {
    if (history) history.delete();
    if (client) await client.close();
  });

  it('gets MACD strategy', async () => {
    indicator = await TradingView.getIndicator('STD;MACD%1Strategy');
    expect(indicator).toBeDefined();
    expect(indicator.description).toBe('MACD Strategy');
  });

  it('creates a history client', async () => {
    client = new TradingView.TradingViewClient({
      credentials: auth,
      server: 'history-data',
    });
    expect(client).toBeDefined();

    history = client.createHistorySession();
    expect(history).toBeDefined();
  });

  it('runs a deep backtest', async () => {
    const from = Math.floor(Date.UTC(2010, 0, 1) / 1000);
    const to = Math.floor(Date.now() / 1000);

    const loaded = new Promise((resolve, reject) => {
      history.on('error', reject);
      history.on('historyLoaded', () => {
        if (history.strategyReport.settings) resolve(true);
      });
    });

    console.log('Running deep backtest...');
    history.requestHistoryData('AMEX:SPY', indicator, {
      timeframe: '5',
      from,
      to,
    });

    expect(await loaded).toBe(true);

    const dateRange = history.strategyReport.settings?.dateRange;
    console.log('Deep backtest traded from', new Date((dateRange?.trade?.from ?? 0) * 1000));

    expect(history.strategyReport.trades.length).toBeGreaterThan(0);
    expect(history.strategyReport.performance.all).toBeDefined();
  }, 30000);
});
