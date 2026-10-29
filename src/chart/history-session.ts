import type { TradingViewClient } from '../client/client.js';
import { TradingViewError } from '../errors.js';
import { Emitter } from '../events.js';
import { PineIndicator } from '../indicators/pine-indicator.js';
import { decodeCompressed } from '../protocol/compression.js';
import type { ServerPacket } from '../protocol/framing.js';
import { createSessionId } from '../protocol/ids.js';
import { mergeStrategyReport, type StrategyReport, type StrategyReportChange } from './strategy.js';
import type { Adjustment, Timeframe, TradingSession } from './types.js';

export interface HistoryOptions {
  /** Default: `5`. */
  timeframe?: Timeframe;
  /** Unix seconds. Default: 2010-01-01 UTC. */
  from?: number;
  /** Unix seconds. Default: now. */
  to?: number;
  adjustment?: Adjustment;
  session?: TradingSession;
  currency?: string;
}

export interface HistoryEvents {
  [event: string]: unknown[];
  historyLoaded: [changes: StrategyReportChange[]];
  error: [error: TradingViewError];
}

/**
 * TradingView's server-side deep backtest (requires a plan with access).
 * Create with `client.createHistorySession()` on the `history-data` server.
 */
export class HistorySession extends Emitter<HistoryEvents> {
  readonly id = createSessionId('hs');

  readonly client: TradingViewClient;

  #deleted = false;

  #strategyReport: StrategyReport = { trades: [], history: {}, performance: {} };

  constructor(client: TradingViewClient) {
    super();
    if (client.isClosed) throw new TradingViewError('INVALID_STATE', 'The client is closed');
    this.client = client;
    client.registerSession(this.id, {
      onPacket: (packet) => this.#onPacket(packet),
      onClose: (error, expected) => {
        if (this.#deleted) return;
        this.#deleted = true;
        client.unregisterSession(this.id);
        if (!expected) this.emit('error', error);
      },
    });
    client.send('history_create_session', [this.id]);
  }

  get strategyReport(): StrategyReport {
    return this.#strategyReport;
  }

  get isDeleted(): boolean {
    return this.#deleted;
  }

  /** Request a deep backtest report. Use a separate session for concurrent requests. */
  requestHistoryData(symbol: string, indicator: PineIndicator, options: HistoryOptions = {}): void {
    if (this.#deleted) throw new TradingViewError('INVALID_STATE', 'The history session is deleted');
    if (!symbol || typeof symbol !== 'string' || !(indicator instanceof PineIndicator)) {
      throw new TradingViewError('INVALID_ARGUMENT', 'A symbol and a PineIndicator are required');
    }
    const from = options.from ?? Date.UTC(2010, 0, 1) / 1000;
    const to = options.to ?? Math.floor(Date.now() / 1000);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) {
      throw new TradingViewError('INVALID_ARGUMENT', 'History dates must be Unix seconds with 0 <= from < to');
    }
    const symbolInit = {
      symbol, adjustment: options.adjustment ?? 'splits',
      ...(options.session ? { session: options.session } : {}),
      ...(options.currency ? { 'currency-id': options.currency } : {}),
    };
    this.#strategyReport = { trades: [], history: {}, performance: {} };
    this.client.send('request_history_data', [
      this.id, 0, `=${JSON.stringify(symbolInit)}`, options.timeframe ?? '5', 0,
      { from_to: { from, to } }, indicator.type, indicator.toStudyInputs(), [],
    ]);
  }

  /** Delete the remote session and stop receiving its packets. Idempotent. */
  delete(): void {
    if (this.#deleted) return;
    if (!this.client.isClosed) this.client.send('history_delete_session', [this.id]);
    this.#deleted = true;
    this.client.unregisterSession(this.id);
  }

  #onPacket(packet: ServerPacket): void {
    if (this.#deleted) return;
    this.client.log('history', this.id, packet);
    if (packet.m === 'request_error' || packet.m === 'critical_error') {
      this.emit('error', new TradingViewError('CRITICAL_ERROR', `History request failed: ${packet.p.slice(1).map(String).join(' ')}`, {
        details: packet.p.slice(1),
      }));
      return;
    }
    if (packet.m !== 'request_data') return;
    try {
      const raw = (packet.p[2] as { ns?: { d?: string } } | undefined)?.ns?.d;
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const changes: StrategyReportChange[] = [];
      if (parsed.dataCompressed) {
        const decoded = decodeCompressed(parsed.dataCompressed) as { report?: unknown };
        changes.push(...mergeStrategyReport(this.#strategyReport, decoded?.report));
      }
      if (parsed.data?.report) changes.push(...mergeStrategyReport(this.#strategyReport, parsed.data.report));
      this.emit('historyLoaded', changes);
    } catch (cause) {
      this.emit('error', new TradingViewError('PARSE_ERROR', 'Unable to parse deep backtest report', { cause }));
    }
  }
}
