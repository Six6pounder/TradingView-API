# Fork features on v4.1

This fork includes upstream v4.1.0 and keeps its private Pine script management
and TradingView deep backtest support. The [upstream migration guide](migration-v4.md)
covers the other breaking API changes. Node 20 or newer is required; build with
`npm ci && npm run build` before importing the package. Bun is also supported.

## Private Pine scripts

Import named functions from `@mathieuc/tradingview`. Credentials are now an object:

```js
import {
  getUser, translatePineScript, createPineScript, getPineScriptSource,
  updatePineScript, renamePineScript, deletePineScript,
} from '@mathieuc/tradingview';

const credentials = { session: process.env.SESSION, signature: process.env.SIGNATURE };
const { username } = await getUser(credentials);
const options = { username, signal: AbortSignal.timeout(30_000) };
const source = '//@version=5\nindicator("Close")\nplot(close)\n';
const compiled = await translatePineScript(source, credentials, options);
if (!compiled.success) throw new Error(JSON.stringify(compiled.errors));
const script = await createPineScript(source, `My script ${Date.now()}`, credentials, options);
try {
  await updatePineScript(script.id, source, credentials, options);
  const saved = await getPineScriptSource(script.id, credentials, { version: 'last' });
  console.log(saved.source);
  await renamePineScript(script.id, `${script.name} renamed`, credentials);
} finally {
  await deletePineScript(script.id, credentials);
}
```

| v3 fork | v4 fork |
| --- | --- |
| `translatePineScript(source, session, signature, options)` | `translatePineScript(source, credentials, options)` |
| `getPineScriptSource(id, version, session, signature)` | `getPineScriptSource(id, credentials, { version })` |
| `createPineScript(source, name, session, signature, options)` | `createPineScript(source, name, credentials, options)` |
| `updatePineScript(id, source, session, signature, options)` | `updatePineScript(id, source, credentials, options)` |
| `renamePineScript(id, name, session, signature)` | `renamePineScript(id, name, credentials, options)` |
| `deletePineScript(id, session, signature)` | `deletePineScript(id, credentials, options)` |

Compilation before saving, duplicate-name protection, verification against the
private list, encoded IDs, `username`, `skipCompile` and update `name` remain
available. All functions accept `fetch`, `signal` and `headers` through their
options. Errors are `TradingViewError` instances. These editor endpoints are
undocumented and may change. The complete executable example is
[examples/pine-scripts.js](../examples/pine-scripts.js); it creates and deletes a
private script in your account.

## TradingView deep backtest

This uses TradingView's remote `history-data` server and requires an account plan
with deep backtest access. It is separate from upstream's local
[`/backtest` module](backtest.md).

| v3 fork | v4 fork |
| --- | --- |
| `new Client({ token, signature, server: 'history-data' })` | `new TradingViewClient({ credentials, server: 'history-data' })` |
| `new client.Session.History()` | `client.createHistorySession()` |
| `history.requestHistoryData(symbol, indicator, options)` | Same method; `options` can be omitted |
| `history.onHistoryLoaded(callback)` | `history.on('historyLoaded', callback)` |
| `history.onError(callback)` | `history.on('error', callback)`; receives a `TradingViewError` |
| `history.strategyReport` / `history.delete()` | Same properties/methods |
| `client.end()` | `await client.close()` |

`from` and `to` use Unix seconds, including `from: 0`. Defaults are 2010-01-01 UTC
and the current time. `timeframe` defaults to `5`; `adjustment`, `session` and
`currency` are preserved. Reports use v4's shared strategy parser, including
compressed payloads. Use a separate session for concurrent requests and delete
it when finished. See [examples/deep-backtest.js](../examples/deep-backtest.js)
for an example with a timeout and connection cleanup.

## Verification

`npm run check` runs type checking, lint, deterministic tests, build and package
smoke checks. `npm run test:bun` runs the deterministic tests on Bun.
`bun.lock` and `package-lock.json` both track the v4 dependencies; v3's Axios
and JSZip dependencies are no longer required.

The original authenticated tests have been migrated to `tests/live`:

```bash
# Needs SESSION and SIGNATURE in the environment, plus plan access:
TV_DEEP_BACKTEST=1 npm run test:live -- tests/live/deep-backtest.test.ts

# Creates, updates, renames and deletes test scripts in the account:
TV_PINE_WRITE=1 npm run test:live -- tests/live/pine-scripts.test.ts
```

These tests are opt-in. The deterministic suite uses fake HTTP responses and a
fake websocket server and does not access or modify a TradingView account.
