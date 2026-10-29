import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistorySession, PineIndicator, TradingViewClient } from '../../src/index.js';
import { FakeServer } from '../helpers/fake-server.js';

const indicator = () => new PineIndicator({
  id: 'STD;Strategy', version: '1', description: 'Strategy', shortDescription: 'Strategy',
  inputs: {}, plots: {}, script: 'compiled', type: 'StrategyScript@tv-scripting-101!',
});
const clients: TradingViewClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

async function setup() {
  const server = new FakeServer();
  const client = new TradingViewClient({ server: 'history-data', transport: server.transport });
  clients.push(client);
  const history = client.createHistorySession();
  await client.ready;
  return { server, client, history };
}

function push(server: FakeServer, history: HistorySession, data: unknown) {
  server.last.push({ m: 'request_data', p: [history.id, 0, { ns: { d: JSON.stringify(data) } }] });
}

describe('deep backtest history sessions', () => {
  it('creates a history session and preserves the protocol payload with custom inputs', async () => {
    const { server, history } = await setup();
    expect(server.last.request.url).toContain('history-data.tradingview.com');
    expect(server.last.sent[1]).toEqual({ m: 'history_create_session', p: [history.id] });
    const script = indicator();
    history.requestHistoryData('AMEX:SPY', script, { from: 0, to: 100, timeframe: '60', session: 'extended', currency: 'EUR', adjustment: 'dividends' });
    expect(server.last.sent.at(-1)).toEqual({ m: 'request_history_data', p: [
      history.id, 0, '={"symbol":"AMEX:SPY","adjustment":"dividends","session":"extended","currency-id":"EUR"}',
      '60', 0, { from_to: { from: 0, to: 100 } }, script.type, script.toStudyInputs(), [],
    ] });
  });

  it('uses UTC defaults and resets the report for a new request', async () => {
    const { server, history } = await setup();
    push(server, history, { data: { report: { currency: 'EUR' } } });
    expect(history.strategyReport.currency).toBe('EUR');
    history.requestHistoryData('AMEX:SPY', indicator());
    expect(server.last.sent.at(-1)?.p[5]).toEqual({ from_to: { from: Date.UTC(2010, 0, 1) / 1000, to: expect.any(Number) } });
    expect(server.last.sent.at(-1)?.p[3]).toBe('5');
    expect(history.strategyReport).toEqual({ trades: [], history: {}, performance: {} });
  });

  it('merges plain and compressed reports and emits typed changes', async () => {
    const { server, history } = await setup();
    const loaded = vi.fn();
    history.on('historyLoaded', loaded);
    const report = { currency: 'USD', settings: { dateRange: { trade: { from: 1, to: 2 } } },
      performance: { all: { totalTrades: 1 } }, equity: [1, 2], trades: [{ e: { c: 'Buy', tp: 'long', p: 10, tm: 1 }, x: { c: 'Sell', p: 11, tm: 2 }, q: 1 }] };
    const compressed = deflateSync(JSON.stringify({ report })).toString('base64');
    push(server, history, { dataCompressed: compressed, data: { report: { buyHold: [3, 4] } } });
    expect(history.strategyReport).toMatchObject({ currency: 'USD', settings: report.settings, performance: report.performance,
      history: { equity: [1, 2], buyHold: [3, 4] }, trades: [{ entry: { name: 'Buy', type: 'long' }, exit: { name: 'Sell' } }] });
    expect(loaded).toHaveBeenCalledWith(expect.arrayContaining(['report.currency', 'report.settings', 'report.perf', 'report.trades', 'report.history']));
    push(server, history, { data: { report: { trades: [] } } });
    expect(history.strategyReport.trades).toEqual([]);
  });

  it('reports parse failures without throwing out of the websocket callback', async () => {
    const { server, history } = await setup();
    const errors = vi.fn();
    history.on('error', errors);
    server.last.push({ m: 'request_data', p: [history.id, 0, { ns: { d: '{bad' } }] });
    push(server, history, { dataCompressed: 'garbage' });
    push(server, history, { data: { report: { trades: [null] } } });
    expect(errors).toHaveBeenCalledTimes(3);
    for (const [error] of errors.mock.calls) expect(error.code).toBe('PARSE_ERROR');
  });

  it('routes remote errors and ignores unrelated or incomplete packets', async () => {
    const { server, history } = await setup();
    const errors = vi.fn();
    const loaded = vi.fn();
    history.on('error', errors);
    history.on('historyLoaded', loaded);
    server.last.push({ m: 'request_error', p: [history.id, 'denied', 'Premium required'] });
    server.last.push({ m: 'critical_error', p: [history.id, 'failed'] });
    server.last.push({ m: 'other', p: [history.id] }, { m: 'request_data', p: [history.id, 0, {}] });
    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls[0][0]).toMatchObject({ code: 'CRITICAL_ERROR', message: expect.stringContaining('Premium required') });
    expect(loaded).not.toHaveBeenCalled();
  });

  it('validates requests and deletes once, unregistering packet routing', async () => {
    const { server, history } = await setup();
    for (const options of [{ from: 10, to: 1 }, { from: NaN }, { from: -1 }, { to: Infinity }, { from: 0.5 }]) {
      expect(() => history.requestHistoryData('AMEX:SPY', indicator(), options)).toThrow('History dates');
    }
    expect(() => history.requestHistoryData('', indicator())).toThrow('symbol');
    const loaded = vi.fn();
    history.on('historyLoaded', loaded);
    history.delete();
    history.delete();
    push(server, history, { data: { report: { currency: 'USD' } } });
    expect(loaded).not.toHaveBeenCalled();
    expect(history.isDeleted).toBe(true);
    expect(server.last.sent.filter(({ m }) => m === 'history_delete_session')).toHaveLength(1);
    expect(() => history.requestHistoryData('AMEX:SPY', indicator())).toThrow('deleted');
  });

  it('disposes on disconnection, emitting errors only for unexpected closes', async () => {
    const first = await setup();
    const errors = vi.fn();
    first.history.on('error', errors);
    first.server.last.drop();
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: 'DISCONNECTED' }));
    expect(first.history.isDeleted).toBe(true);
    first.history.delete();
    expect(() => first.client.createHistorySession()).toThrow('closed');
    const second = await setup();
    const expected = vi.fn();
    second.history.on('error', expected);
    await second.client.close();
    expect(second.history.isDeleted).toBe(true);
    expect(expected).not.toHaveBeenCalled();
  });
});
