module.exports = {
  test: {
    testTimeout: 10000,
    retry: 3,
    setupFiles: 'dotenv/config',
    // The authenticated websocket tests all share the same TradingView
    // account: running test files in parallel makes them time out.
    threads: false,
  },
};
