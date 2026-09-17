const TradingView = require('../main');

/**
 * This example creates a private pine script, updates it,
 * renames it, lists it and finally deletes it
 */

if (!process.env.SESSION || !process.env.SIGNATURE) {
  throw Error('Please set your sessionid and signature cookies');
}

const { SESSION, SIGNATURE } = process.env;

const source = (title) => `//@version=5
indicator("${title}")
plot(close, title="${title}")
`;

(async () => {
  const { username } = await TradingView.getUser(SESSION, SIGNATURE);
  const options = { username };

  const compiled = await TradingView.translatePineScript(source('Close'), SESSION, SIGNATURE, options);
  console.log('Compiled:', compiled.success);

  const script = await TradingView.createPineScript(
    source('Close'),
    `TVAPI example ${Date.now()}`,
    SESSION,
    SIGNATURE,
    options,
  );
  console.log('Created:', script);

  try {
    console.log('Updated:', await TradingView.updatePineScript(script.id, source('Last close'), SESSION, SIGNATURE, options));

    const { source: saved } = await TradingView.getPineScriptSource(script.id, 'last', SESSION, SIGNATURE);
    console.log('Saved source:', JSON.stringify(saved));

    console.log('Renamed:', await TradingView.renamePineScript(script.id, `${script.name} renamed`, SESSION, SIGNATURE));

    const indicator = await TradingView.getIndicator(script.id, 'last', SESSION, SIGNATURE);
    console.log('Indicator plots:', indicator.plots);
  } finally {
    console.log('Deleted:', await TradingView.deletePineScript(script.id, SESSION, SIGNATURE));
  }
})().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
