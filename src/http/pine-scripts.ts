import { TradingViewError } from '../errors.js';
import { getUser } from './account.js';
import { getPrivateIndicators } from './indicators.js';
import { request, type Credentials, type HttpOptions } from './request.js';

const BASE = 'https://pine-facade.tradingview.com/pine-facade';
const headers = { origin: 'https://www.tradingview.com', referer: 'https://www.tradingview.com/' };

export interface PineMessage {
  message: string;
  start?: { line: number; column: number };
  end?: { line: number; column: number };
}

export interface PineCompileResult {
  success: boolean;
  errors: PineMessage[];
  warnings: PineMessage[];
  raw: unknown;
}

export interface PineScriptSource {
  id: string;
  name: string;
  title: string;
  version: string;
  type: 'study' | 'strategy' | (string & {});
  source: string;
  created: Date;
  updated: Date;
}

export interface SavedPineScript {
  id: string;
  name: string;
  version: string;
}

export interface PineCompileOptions extends HttpOptions {
  /** Avoids the account lookup when the username is already known. */
  username?: string;
}

export interface SavePineScriptOptions extends PineCompileOptions {
  /** Skip compilation before saving. Invalid source may then be saved. Default: false. */
  skipCompile?: boolean;
}

export interface UpdatePineScriptOptions extends SavePineScriptOptions {
  /** Defaults to the current name. */
  name?: string;
}

export interface GetPineScriptSourceOptions extends HttpOptions {
  /** Default: `last`. */
  version?: string;
}

function normaliseId(id: string): string {
  if (!id || typeof id !== 'string') throw new TradingViewError('INVALID_ARGUMENT', 'Missing pine script ID');
  try {
    return id.includes('%') ? decodeURIComponent(id) : id;
  } catch {
    throw new TradingViewError('INVALID_ARGUMENT', 'Invalid encoded pine script ID');
  }
}

function assertName(name: string): void {
  if (!name || typeof name !== 'string') throw new TradingViewError('INVALID_ARGUMENT', 'Missing pine script name');
}

function assertCredentials(credentials: Credentials): void {
  if (!credentials?.session) throw new TradingViewError('INVALID_ARGUMENT', 'A session cookie is required');
}

function facadeError(action: string, status: number, data: any): TradingViewError {
  const reason = data && typeof data === 'object' ? data.message || data.reason : undefined;
  return new TradingViewError('HTTP_ERROR', `Pine script ${action} failed (HTTP ${status})${reason ? `: ${String(reason)}` : ''}`);
}

async function usernameFor(credentials: Credentials, options: PineCompileOptions): Promise<string> {
  assertCredentials(credentials);
  const username = options.username || (await getUser(credentials, options)).username;
  if (!username) throw new TradingViewError('AUTH_ERROR', 'Unable to get the username from the session');
  return username;
}

async function findScript(id: string, credentials: Credentials, options: HttpOptions) {
  return (await getPrivateIndicators(credentials, options)).find((script) => script.id === id);
}

/** Compile private Pine source without saving it. Uses an undocumented editor endpoint. */
export async function translatePineScript(
  source: string, credentials: Credentials, options: PineCompileOptions = {},
): Promise<PineCompileResult> {
  const username = await usernameFor(credentials, options);
  const { data, status } = await request(`${BASE}/translate_light`, {
    method: 'POST', credentials, headers, form: { source }, query: { user_name: username, v: 3 },
  }, options);
  if (status !== 200 || !data || typeof data !== 'object') throw facadeError('compilation', status, data);
  const result = data.result ?? {};
  // TradingView can report success: true alongside compilation errors.
  const errors: PineMessage[] = [
    ...(result.errors2 ?? result.errors ?? []),
    ...(data.reason2?.errors ?? []),
  ];
  if (!data.success && !errors.length) errors.push({ message: String(data.reason || data.message || `HTTP ${status}`) });
  return {
    success: !!data.success && !errors.length,
    errors,
    warnings: result.warnings2 ?? result.warnings ?? [],
    raw: data,
  };
}

/** Read the source of a saved private script. Accepts raw or percent-encoded IDs. */
export async function getPineScriptSource(
  id: string, credentials: Credentials, options: GetPineScriptSourceOptions = {},
): Promise<PineScriptSource> {
  assertCredentials(credentials);
  const pineId = normaliseId(id);
  const { data, status } = await request(`${BASE}/get/${encodeURIComponent(pineId)}/${encodeURIComponent(options.version ?? 'last')}`, {
    credentials, headers,
  }, options);
  if (status !== 200 || !data || typeof data.source !== 'string') throw facadeError('read', status, data);
  return {
    id: pineId, name: data.scriptName, title: data.scriptTitle, version: String(data.version),
    type: data.extra?.kind ?? 'study', source: data.source,
    created: new Date(data.created), updated: new Date(data.updated),
  };
}

async function compileBeforeSave(source: string, credentials: Credentials, options: SavePineScriptOptions): Promise<void> {
  if (options.skipCompile) return;
  const compiled = await translatePineScript(source, credentials, options);
  if (!compiled.success) {
    const message = compiled.errors.map((error) => error.start
      ? `line ${error.start.line}:${error.start.column}: ${error.message}` : error.message).join('; ');
    throw new TradingViewError('INVALID_ARGUMENT', `Pine script compilation failed: ${message}`);
  }
}

/** Create a private script, compiling first and verifying it appears in the saved list. */
export async function createPineScript(
  source: string, name: string, credentials: Credentials, options: SavePineScriptOptions = {},
): Promise<SavedPineScript> {
  assertName(name);
  const username = await usernameFor(credentials, options);
  await compileBeforeSave(source, credentials, { ...options, username });
  const { data, status } = await request(`${BASE}/save/new/`, {
    method: 'POST', credentials, headers, form: { source },
    query: { name, user_name: username, allow_use_existing_draft: false },
  }, options);
  const id = data?.result?.scriptIdPart || data?.result?.metaInfo?.scriptIdPart;
  if (status !== 200 || data?.success === false || typeof id !== 'string' || !id) throw facadeError('creation', status, data);
  const saved = await findScript(id, credentials, options);
  if (!saved || saved.name !== name) throw new TradingViewError('HTTP_ERROR', `Pine script ${id} was saved but the private list does not match`);
  return { id, name: saved.name, version: saved.version };
}

/** Update an existing private script. Invalid source is rejected before any save. */
export async function updatePineScript(
  id: string, source: string, credentials: Credentials, options: UpdatePineScriptOptions = {},
): Promise<SavedPineScript> {
  const pineId = normaliseId(id);
  const username = await usernameFor(credentials, options);
  const current = await findScript(pineId, credentials, options);
  if (!current) throw new TradingViewError('NOT_FOUND', `Pine script ${pineId} is not in the private list`);
  const name = options.name ?? current.name;
  assertName(name);
  await compileBeforeSave(source, credentials, { ...options, username });
  const { data, status } = await request(`${BASE}/save/next/${encodeURIComponent(pineId)}`, {
    method: 'POST', credentials, headers, form: { source },
    query: { allow_create_new: false, name, user_name: username },
  }, options);
  const savedId = data?.result?.scriptIdPart || data?.result?.metaInfo?.scriptIdPart;
  if (status !== 200 || !data?.success || savedId !== pineId) throw facadeError('update', status, data);
  const saved = await findScript(pineId, credentials, options);
  if (!saved || saved.name !== name) throw new TradingViewError('HTTP_ERROR', `Pine script ${pineId} was updated but the private list does not match`);
  return { id: pineId, name: saved.name, version: saved.version };
}

/** Rename a private script without changing its source. */
export async function renamePineScript(
  id: string, name: string, credentials: Credentials, options: HttpOptions = {},
): Promise<SavedPineScript> {
  assertCredentials(credentials);
  assertName(name);
  const pineId = normaliseId(id);
  const { data, text, status } = await request(`${BASE}/rename/${encodeURIComponent(pineId)}`, {
    method: 'POST', credentials, headers, query: { name },
  }, options);
  if (status !== 200 || (data !== 'ok' && text !== 'ok')) throw facadeError('rename', status, data);
  const saved = await findScript(pineId, credentials, options);
  if (!saved || saved.name !== name) throw new TradingViewError('HTTP_ERROR', `Pine script ${pineId} was renamed but the private list does not match`);
  return { id: pineId, name: saved.name, version: saved.version };
}

/** Delete a private script and verify that it disappears from the saved list. */
export async function deletePineScript(id: string, credentials: Credentials, options: HttpOptions = {}): Promise<true> {
  assertCredentials(credentials);
  const pineId = normaliseId(id);
  const { data, text, status } = await request(`${BASE}/delete/${encodeURIComponent(pineId)}`, {
    method: 'POST', credentials, headers,
  }, options);
  if (status !== 200 || (data !== 'ok' && text !== 'ok')) throw facadeError('deletion', status, data);
  if (await findScript(pineId, credentials, options)) {
    throw new TradingViewError('HTTP_ERROR', `Pine script ${pineId} is still in the private list after deletion`);
  }
  return true;
}
