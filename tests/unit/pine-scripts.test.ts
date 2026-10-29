import { describe, expect, it, vi } from 'vitest';
import {
  createPineScript, deletePineScript, getPineScriptSource, renamePineScript,
  translatePineScript, updatePineScript,
} from '../../src/index.js';

const credentials = { session: 'session', signature: 'signature' };
const id = 'USER;abc';
const item = { scriptIdPart: id, scriptName: 'Test', version: 2 };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

function setup(route: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return route(url, init);
  }) as typeof globalThis.fetch;
  return { options: { fetch, username: 'me' }, calls };
}

function savedRoute(url: URL) {
  if (url.pathname.endsWith('/list')) return json([item]);
  if (url.pathname.endsWith('/translate_light')) return json({ success: true });
  return json({ success: true, result: { scriptIdPart: id } });
}

describe('private Pine scripts', () => {
  it('compiles with cookies, editor headers and form encoding; reports errors despite success', async () => {
    const { options, calls } = setup(() => json({
      success: true, result: { errors2: [{ message: 'Unknown closee', start: { line: 3, column: 1 } }], warnings2: [{ message: 'Warning' }] },
    }));
    const compiled = await translatePineScript('plot(closee) + 1', credentials, options);
    expect(compiled).toMatchObject({ success: false, errors: [{ message: 'Unknown closee' }], warnings: [{ message: 'Warning' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('user_name')).toBe('me');
    expect(calls[0].url.searchParams.get('v')).toBe('3');
    expect(calls[0].init).toMatchObject({ method: 'POST', headers: {
      cookie: 'sessionid=session;sessionid_sign=signature', origin: 'https://www.tradingview.com',
      referer: 'https://www.tradingview.com/', 'content-type': 'application/x-www-form-urlencoded',
    } });
    expect(new URLSearchParams(String(calls[0].init.body)).get('source')).toBe('plot(closee) + 1');
  });

  it('looks up the username once and passes cancellation through every request', async () => {
    const signal = new AbortController().signal;
    const { options, calls } = setup((url) => url.hostname === 'www.tradingview.com'
      ? new Response('{"username":"account","auth_token":"auth"}') : savedRoute(url));
    await createPineScript('plot(close)', 'Test', credentials, { fetch: options.fetch, signal });
    expect(calls.filter(({ url }) => url.hostname === 'www.tradingview.com')).toHaveLength(1);
    expect(calls.every(({ init }) => init.signal === signal)).toBe(true);
    expect(calls.find(({ url }) => url.pathname.endsWith('/save/new/'))?.url.searchParams.get('user_name')).toBe('account');
  });

  it('handles legacy compiler errors and top-level failure reasons', async () => {
    for (const data of [
      { success: true, result: { errors: [{ message: 'Invalid' }] } },
      { success: false, reason2: { errors: [{ message: 'Invalid' }] } },
      { success: false, reason: 'Invalid' },
    ]) {
      const { options } = setup(() => json(data));
      expect(await translatePineScript('invalid', credentials, options)).toMatchObject({ success: false, errors: [{ message: 'Invalid' }] });
    }
  });

  it('never saves invalid source, on creation or update', async () => {
    const { options, calls } = setup((url) => url.pathname.endsWith('/list') ? json([item])
      : json({ success: true, result: { errors2: [{ message: 'Invalid', start: { line: 1, column: 2 } }] } }));
    await expect(createPineScript('invalid', 'Test', credentials, options)).rejects.toThrow('line 1:2: Invalid');
    await expect(updatePineScript(id, 'invalid', credentials, options)).rejects.toThrow('compilation failed');
    expect(calls.some(({ url }) => url.pathname.includes('/save/'))).toBe(false);
  });

  it('creates, updates encoded IDs and verifies the saved result', async () => {
    const { options, calls } = setup(savedRoute);
    expect(await createPineScript('plot(close)', 'Test', credentials, options)).toEqual({ id, name: 'Test', version: '2' });
    const create = calls.find(({ url }) => url.pathname.endsWith('/save/new/'))!;
    expect(create.url.searchParams.get('allow_use_existing_draft')).toBe('false');
    expect(await updatePineScript('USER%3Babc', 'plot(open)', credentials, options)).toEqual({ id, name: 'Test', version: '2' });
    const update = calls.find(({ url }) => url.pathname.includes('/save/next/'))!;
    expect(update.url.pathname).toContain('USER%3Babc');
    expect(update.url.searchParams.get('allow_create_new')).toBe('false');
    expect(update.url.searchParams.get('name')).toBe('Test');
  });

  it('honors skipCompile and rejects a missing script before an update', async () => {
    const { options, calls } = setup(savedRoute);
    await createPineScript('draft', 'Test', credentials, { ...options, skipCompile: true });
    expect(calls.some(({ url }) => url.pathname.endsWith('/translate_light'))).toBe(false);
    const missing = setup(() => json([]));
    await expect(updatePineScript(id, 'draft', credentials, missing.options)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(missing.calls).toHaveLength(1);
  });

  it('reads source and dates, with encoded ID and version', async () => {
    const { options, calls } = setup(() => json({ source: 'plot(close)', scriptName: 'Test', scriptTitle: 'Close', version: 2,
      extra: { kind: 'strategy' }, created: '2026-01-01', updated: '2026-02-01' }));
    const result = await getPineScriptSource('USER%3Babc', credentials, { ...options, version: '2' });
    expect(result).toMatchObject({ id, source: 'plot(close)', name: 'Test', title: 'Close', version: '2', type: 'strategy' });
    expect(result.created).toEqual(new Date('2026-01-01'));
    expect(calls[0].url.pathname).toBe('/pine-facade/get/USER%3Babc/2');
  });

  it('renames and deletes with plain-text or JSON acknowledgements', async () => {
    for (const encoded of [false, true]) {
      const { options, calls } = setup((url) => url.pathname.endsWith('/list') ? json([item]) : encoded ? json('ok') : new Response('ok'));
      expect(await renamePineScript(id, 'Test', credentials, options)).toEqual({ id, name: 'Test', version: '2' });
      expect(calls[0].url.searchParams.get('name')).toBe('Test');
      const deleted = setup((url) => url.pathname.endsWith('/list') ? json([]) : encoded ? json('ok') : new Response('ok'));
      expect(await deletePineScript(id, credentials, deleted.options)).toBe(true);
    }
  });

  it('rejects rejected saves and mismatched confirmation lists', async () => {
    const conflict = setup((url) => url.pathname.endsWith('/translate_light') ? json({ success: true }) : json({ message: 'Duplicate' }, 409));
    await expect(createPineScript('source', 'Test', credentials, conflict.options)).rejects.toThrow('HTTP 409');
    const missing = setup((url) => url.pathname.endsWith('/list') ? json([]) : savedRoute(url));
    await expect(createPineScript('source', 'Test', credentials, missing.options)).rejects.toThrow('private list does not match');
    const wrongId = setup((url) => url.pathname.includes('/save/next/') ? json({ success: true, result: { scriptIdPart: 'OTHER' } }) : savedRoute(url));
    await expect(updatePineScript(id, 'source', credentials, wrongId.options)).rejects.toThrow('update failed');
    const unchanged = setup((url) => url.pathname.endsWith('/list') ? json([item]) : new Response('ok'));
    await expect(renamePineScript(id, 'New', credentials, unchanged.options)).rejects.toThrow('private list does not match');
    await expect(deletePineScript(id, credentials, unchanged.options)).rejects.toThrow('still in the private list');
  });

  it('rejects malformed responses, missing credentials and invalid arguments', async () => {
    const { options, calls } = setup(() => new Response('Forbidden', { status: 403 }));
    await expect(translatePineScript('source', credentials, options)).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    await expect(getPineScriptSource(id, credentials, options)).rejects.toThrow('read failed');
    await expect(renamePineScript(id, 'Name', credentials, options)).rejects.toThrow('rename failed');
    await expect(deletePineScript(id, credentials, options)).rejects.toThrow('deletion failed');
    const before = calls.length;
    await expect(createPineScript('source', '', credentials, options)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(getPineScriptSource('%invalid', credentials, options)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(deletePineScript('', credentials, options)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(translatePineScript('source', { session: '' }, options)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toHaveLength(before);
  });
});
