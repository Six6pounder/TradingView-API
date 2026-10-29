// Run: npm run build && node --env-file=.env examples/pine-scripts.js
import * as TradingView from '@mathieuc/tradingview';

/**
 * This example creates a private pine script, updates it,
 * renames it, lists it and finally deletes it
 */

if (!process.env.SESSION || !process.env.SIGNATURE) {
  throw Error('Please set your sessionid and signature cookies');
}

const credentials = { session: process.env.SESSION, signature: process.env.SIGNATURE };

const source = (title) => `//@version=5
indicator("${title}")
plot(close, title="${title}")
`;

(async () => {
  const { username } = await TradingView.getUser(credentials);
  const options = { username };

  const compiled = await TradingView.translatePineScript(source('Close'), credentials, options);
  console.log('Compiled:', compiled.success);

  const script = await TradingView.createPineScript(
    source('Close'),
    `TVAPI example ${Date.now()}`,
    credentials,
    options,
  );
  console.log('Created:', script);

  try {
    console.log('Updated:', await TradingView.updatePineScript(script.id, source('Last close'), credentials, options));

    const { source: saved } = await TradingView.getPineScriptSource(script.id, credentials);
    console.log('Saved source:', JSON.stringify(saved));

    console.log('Renamed:', await TradingView.renamePineScript(script.id, `${script.name} renamed`, credentials));

    const indicator = await TradingView.getIndicator(script.id, { credentials });
    console.log('Indicator plots:', indicator.plots);
  } finally {
    console.log('Deleted:', await TradingView.deletePineScript(script.id, credentials));
  }
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
