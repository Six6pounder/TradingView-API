import { describe, it, expect, afterAll } from 'vitest';
import * as TradingView from '../../src/index.js';
import { credentials, LIVE } from './env.js';

const auth = credentials as NonNullable<typeof credentials>;

const source = (title: string) => `//@version=5
indicator("${title}")
plot(close, title="${title}")
`;

describe.skipIf(!LIVE || !credentials || process.env.TV_PINE_WRITE !== '1')('Pine scripts management', () => {
  // I test toccano solo gli script creati qui
  const createdIds = new Set<string>();
  const name = `TVAPI test ${Date.now()}`;
  let username = '';
  let scriptId = '';

  afterAll(async () => {
    for (const id of createdIds) {
      try {
        await TradingView.deletePineScript(id, auth);
      } catch (err) {
        console.error(`Cleanup of ${id} failed:`, (err as Error).message);
      }
    }
  });

  it('compiles valid code', async () => {
    ({ username } = await TradingView.getUser(auth));

    const result = await TradingView.translatePineScript(source('Valid'), auth, { username });

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports errors on invalid code', async () => {
    const result = await TradingView.translatePineScript(
      '//@version=5\nindicator("Invalid")\nplot(closee)\n',
      auth,
      { username },
    );

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('closee');
  });

  it('refuses to save invalid code', async () => {
    const invalidName = `${name} invalid`;

    await expect(TradingView.createPineScript(
      '//@version=5\nindicator("Invalid")\nplot(closee)\n',
      invalidName,
      auth,
      { username },
    )).rejects.toThrow('compilation failed');

    const list = await TradingView.getPrivateIndicators(auth);
    expect(list.some((s) => s.name === invalidName)).toBe(false);
  });

  it('creates a script', async () => {
    const script = await TradingView.createPineScript(source('Created'), name, auth, { username });
    createdIds.add(script.id);
    scriptId = script.id;

    expect(script.id).toMatch(/^USER;[0-9a-f]{32}$/);
    expect(script.name).toBe(name);

    const list = await TradingView.getPrivateIndicators(auth);
    expect(list.some((s) => s.id === script.id)).toBe(true);
  });

  it('refuses a duplicate name', async () => {
    expect(scriptId).not.toBe('');

    await expect(TradingView.createPineScript(source('Duplicate'), name, auth, { username }))
      .rejects.toThrow('HTTP 409');
  });

  it('updates a script', async () => {
    expect(scriptId).not.toBe('');

    const script = await TradingView.updatePineScript(
      scriptId.replace(';', '%3B'),
      source('Updated'),
      auth,
      { username },
    );
    expect(script.id).toBe(scriptId);

    const indicator = await TradingView.getIndicator(scriptId, { credentials: auth, version: 'last' });
    expect(Object.values(indicator.plots)).toContain('Updated');

    const saved = await TradingView.getPineScriptSource(scriptId, auth, { version: 'last' });
    expect(saved.source).toBe(source('Updated'));
  });

  it('renames a script', async () => {
    expect(scriptId).not.toBe('');

    const script = await TradingView.renamePineScript(scriptId, `${name} renamed`, auth);
    expect(script.name).toBe(`${name} renamed`);
  });

  it('deletes a script', async () => {
    expect(scriptId).not.toBe('');

    expect(await TradingView.deletePineScript(scriptId, auth)).toBe(true);
    createdIds.delete(scriptId);

    const list = await TradingView.getPrivateIndicators(auth);
    expect(list.some((s) => s.id === scriptId)).toBe(false);
  });
});
