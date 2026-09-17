import { describe, it, expect, afterAll } from 'vitest';
import TradingView from '../main';

const token = process.env.SESSION as string;
const signature = process.env.SIGNATURE as string;

const source = (title: string) => `//@version=5
indicator("${title}")
plot(close, title="${title}")
`;

describe.skipIf(!token || !signature)('Pine scripts management', () => {
  // I test toccano solo gli script creati qui
  const createdIds = new Set<string>();
  const name = `TVAPI test ${Date.now()}`;
  let username = '';
  let scriptId = '';

  afterAll(async () => {
    for (const id of createdIds) {
      try {
        await TradingView.deletePineScript(id, token, signature);
      } catch (err) {
        console.error(`Cleanup of ${id} failed:`, (err as Error).message);
      }
    }
  });

  it('compiles valid code', async () => {
    ({ username } = await TradingView.getUser(token, signature));

    const result = await TradingView.translatePineScript(source('Valid'), token, signature, { username });

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports errors on invalid code', async () => {
    const result = await TradingView.translatePineScript(
      '//@version=5\nindicator("Invalid")\nplot(closee)\n',
      token,
      signature,
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
      token,
      signature,
      { username },
    )).rejects.toThrow('compilation failed');

    const list = await TradingView.getPrivateIndicators(token, signature);
    expect(list.some((s) => s.name === invalidName)).toBe(false);
  });

  it('creates a script', async () => {
    const script = await TradingView.createPineScript(source('Created'), name, token, signature, { username });
    createdIds.add(script.id);
    scriptId = script.id;

    expect(script.id).toMatch(/^USER;[0-9a-f]{32}$/);
    expect(script.name).toBe(name);

    const list = await TradingView.getPrivateIndicators(token, signature);
    expect(list.some((s) => s.id === script.id)).toBe(true);
  });

  it('refuses a duplicate name', async () => {
    expect(scriptId).not.toBe('');

    await expect(TradingView.createPineScript(source('Duplicate'), name, token, signature, { username }))
      .rejects.toThrow('HTTP 409');
  });

  it('updates a script', async () => {
    expect(scriptId).not.toBe('');

    const script = await TradingView.updatePineScript(
      scriptId.replace(';', '%3B'),
      source('Updated'),
      token,
      signature,
      { username },
    );
    expect(script.id).toBe(scriptId);

    const indicator = await TradingView.getIndicator(scriptId, 'last', token, signature);
    expect(Object.values(indicator.plots)).toContain('Updated');

    const saved = await TradingView.getPineScriptSource(scriptId, 'last', token, signature);
    expect(saved.source).toBe(source('Updated'));
  });

  it('renames a script', async () => {
    expect(scriptId).not.toBe('');

    const script = await TradingView.renamePineScript(scriptId, `${name} renamed`, token, signature);
    expect(script.name).toBe(`${name} renamed`);
  });

  it('deletes a script', async () => {
    expect(scriptId).not.toBe('');

    expect(await TradingView.deletePineScript(scriptId, token, signature)).toBe(true);
    createdIds.delete(scriptId);

    const list = await TradingView.getPrivateIndicators(token, signature);
    expect(list.some((s) => s.id === scriptId)).toBe(false);
  });
});
