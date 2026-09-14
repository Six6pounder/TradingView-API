import {
  describe, it, expect, afterAll,
} from 'vitest';
import TradingView from '../main';

const token = process.env.SESSION as string;
const signature = process.env.SIGNATURE as string;

// Deep backtests are only served to Premium accounts
describe.skipIf(!token || !signature)('DeepBacktest', () => {
  let client: TradingView.Client;
  let history: InstanceType<typeof client.Session.History>;
  let indicator: TradingView.PineIndicator;

  afterAll(async () => {
    if (history) history.delete();
    if (client) await client.end();
  });

  it('gets MACD strategy', async () => {
    indicator = await TradingView.getIndicator('STD;MACD%1Strategy');
    expect(indicator).toBeDefined();
    expect(indicator.description).toBe('MACD Strategy');
  });

  it('creates a history client', async () => {
    client = new TradingView.Client({
      token,
      signature,
      server: 'history-data',
    });
    expect(client).toBeDefined();

    history = new client.Session.History();
    expect(history).toBeDefined();
  });

  it('runs a deep backtest', async () => {
    const from = Math.floor(new Date(2010, 1, 1).getTime() / 1000);
    const to = Math.floor(Date.now() / 1000);

    const loaded = new Promise((resolve, reject) => {
      history.onError((...error: string[]) => reject(new Error(error.join(' '))));
      history.onHistoryLoaded(() => {
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

    const { dateRange } = history.strategyReport.settings;
    console.log('Deep backtest traded from', new Date(dateRange.trade.from));

    expect(history.strategyReport.trades.length).toBeGreaterThan(0);
    expect(history.strategyReport.performance.all).toBeDefined();
  }, 30000);
});
