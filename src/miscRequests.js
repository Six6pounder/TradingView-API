const os = require('os');
const axios = require('axios');

const PineIndicator = require('./classes/PineIndicator');
const { genAuthCookies } = require('./utils');

const validateStatus = (status) => status < 500;

// Endpoint non documentati dell'editor Pine: possono cambiare senza preavviso
const PINE_FACADE_URL = 'https://pine-facade.tradingview.com/pine-facade';
const PINE_TRANSLATE_URL = `${PINE_FACADE_URL}/translate_light`;
const PINE_GET_URL = `${PINE_FACADE_URL}/get`;
const PINE_SAVE_NEW_URL = `${PINE_FACADE_URL}/save/new/`;
const PINE_SAVE_NEXT_URL = `${PINE_FACADE_URL}/save/next`;
const PINE_RENAME_URL = `${PINE_FACADE_URL}/rename`;
const PINE_DELETE_URL = `${PINE_FACADE_URL}/delete`;

const indicators = ['Recommend.Other', 'Recommend.All', 'Recommend.MA'];
const builtInIndicList = [];

async function fetchScanData(tickers = [], columns = []) {
  const { data } = await axios.post(
    'https://scanner.tradingview.com/global/scan',
    {
      symbols: { tickers },
      columns,
    },
    { validateStatus },
  );

  return data;
}

/** @typedef {number} advice */

/**
 * @typedef {{
 *   Other: advice,
 *   All: advice,
 *   MA: advice
 * }} Period
 */

/**
 * @typedef {{
 *  '1': Period,
 *  '5': Period,
 *  '15': Period,
 *  '60': Period,
 *  '240': Period,
 *  '1D': Period,
 *  '1W': Period,
 *  '1M': Period
 * }} Periods
 */

function pineHeaders(session, signature) {
  return {
    cookie: genAuthCookies(session, signature),
    origin: 'https://www.tradingview.com',
    referer: 'https://www.tradingview.com/',
    'content-type': 'application/x-www-form-urlencoded',
  };
}

/** Accetta sia 'USER;abc' sia 'USER%3Babc' e restituisce la forma decodificata */
function normalizePineId(id) {
  if (!id || typeof id !== 'string') throw new Error('Missing pine script ID');
  return id.includes('%') ? decodeURIComponent(id) : id;
}

/** Messaggio d'errore di pine-facade, senza mai includere le intestazioni */
function pineFacadeError(action, status, data) {
  if (data && typeof data === 'object') {
    const msg = data.message || data.reason || JSON.stringify(data).slice(0, 300);
    return new Error(`Pine script ${action} failed (HTTP ${status}): ${msg}`);
  }
  return new Error(`Pine script ${action} failed (HTTP ${status})`);
}

function formatPineErrors(errors) {
  return errors.map((e) => (
    e.start ? `line ${e.start.line}:${e.start.column}: ${e.message}` : (e.message || String(e))
  )).join('; ');
}

async function resolveUsername(session, signature, options) {
  if (options.username) return options.username;
  const { username } = await module.exports.getUser(session, signature);
  if (!username) throw new Error('Unable to get the username from the session');
  return username;
}

async function findPrivateScript(id, session, signature) {
  const list = await module.exports.getPrivateIndicators(session, signature);
  return list.find((s) => s.id === id);
}

module.exports = {
  /**
   * Get technical analysis
   * @function getTA
   * @param {string} id Full market id (Example: COINBASE:BTCEUR)
   * @returns {Promise<Periods>} results
   */
  async getTA(id) {
    const advice = {};

    const cols = ['1', '5', '15', '60', '240', '1D', '1W', '1M']
      .map((t) => indicators.map((i) => (t !== '1D' ? `${i}|${t}` : i)))
      .flat();

    const rs = await fetchScanData([id], cols);
    if (!rs.data || !rs.data[0]) return false;

    rs.data[0].d.forEach((val, i) => {
      const [name, period] = cols[i].split('|');
      const pName = period || '1D';
      if (!advice[pName]) advice[pName] = {};
      advice[pName][name.split('.').pop()] = Math.round(val * 1000) / 500;
    });

    return advice;
  },

  /**
   * @typedef {Object} SearchMarketResult
   * @prop {string} id Market full symbol
   * @prop {string} exchange Market exchange name
   * @prop {string} fullExchange Market exchange full name
   * @prop {string} symbol Market symbol
   * @prop {string} description Market name
   * @prop {string} type Market type
   * @prop {() => Promise<Periods>} getTA Get market technical analysis
   */

  /**
   * Find a symbol (deprecated)
   * @function searchMarket
   * @param {string} search Keywords
   * @param {'stock'
   *  | 'futures' | 'forex' | 'cfd'
   *  | 'crypto' | 'index' | 'economic'
   * } [filter] Caterogy filter
   * @returns {Promise<SearchMarketResult[]>} Search results
   * @deprecated Use searchMarketV3 instead
   */
  async searchMarket(search, filter = '') {
    const { data } = await axios.get(
      'https://symbol-search.tradingview.com/symbol_search',
      {
        params: {
          text: search.replace(/ /g, '%20'),
          type: filter,
        },
        headers: {
          origin: 'https://www.tradingview.com',
        },
        validateStatus,
      },
    );

    return data.map((s) => {
      const exchange = s.exchange.split(' ')[0];
      const id = `${exchange}:${s.symbol}`;

      return {
        id,
        exchange,
        fullExchange: s.exchange,
        symbol: s.symbol,
        description: s.description,
        type: s.type,
        getTA: () => this.getTA(id),
      };
    });
  },

  /**
   * Find a symbol
   * @function searchMarketV3
   * @param {string} search Keywords
   * @param {'stock'
   *  | 'futures' | 'forex' | 'cfd'
   *  | 'crypto' | 'index' | 'economic'
   * } [filter] Caterogy filter
   * @param {number} offset Pagination offset
   * @returns {Promise<SearchMarketResult[]>} Search results
   */
  async searchMarketV3(search, filter = '', offset = 0) {
    const splittedSearch = search.toUpperCase().replace(/ /g, '+').split(':');

    const request = await axios.get(
      'https://symbol-search.tradingview.com/symbol_search/v3',
      {
        params: {
          exchange: (splittedSearch.length === 2
            ? splittedSearch[0]
            : undefined
          ),
          text: splittedSearch.pop(),
          search_type: filter,
          start: offset,
        },
        headers: {
          origin: 'https://www.tradingview.com',
        },
        validateStatus,
      },
    );

    const { data } = request;

    return data.symbols.map((s) => {
      const exchange = s.exchange.split(' ')[0];
      const id = s.prefix ? `${s.prefix}:${s.symbol}` : `${exchange.toUpperCase()}:${s.symbol}`;

      return {
        id,
        exchange,
        fullExchange: s.exchange,
        symbol: s.symbol,
        description: s.description,
        type: s.type,
        getTA: () => this.getTA(id),
      };
    });
  },

  /**
   * @typedef {Object} SearchIndicatorResult
   * @prop {string} id Script ID
   * @prop {string} version Script version
   * @prop {string} name Script complete name
   * @prop {{ id: number, username: string }} author Author user ID
   * @prop {string} image Image ID https://tradingview.com/i/${image}
   * @prop {string | ''} source Script source (if available)
   * @prop {'study' | 'strategy'} type Script type (study / strategy)
   * @prop {'open_source' | 'closed_source' | 'invite_only'
   *  | 'private' | 'other'} access Script access type
   * @prop {() => Promise<PineIndicator>} get Get the full indicator informations
   */

  /**
   * Find an indicator
   * @function searchIndicator
   * @param {string} search Keywords
   * @returns {Promise<SearchIndicatorResult[]>} Search results
   */
  async searchIndicator(search = '') {
    if (!builtInIndicList.length) {
      await Promise.all(['standard', 'candlestick', 'fundamental'].map(async (type) => {
        const { data } = await axios.get(
          'https://pine-facade.tradingview.com/pine-facade/list',
          {
            params: {
              filter: type,
            },
            validateStatus,
          },
        );
        builtInIndicList.push(...data);
      }));
    }

    const { data } = await axios.get(
      'https://www.tradingview.com/pubscripts-suggest-json',
      {
        params: {
          search: search.replace(/ /g, '%20'),
        },
        validateStatus,
      },
    );

    function norm(str = '') {
      return str.toUpperCase().replace(/[^A-Z]/g, '');
    }

    return [
      ...builtInIndicList.filter((i) => (
        norm(i.scriptName).includes(norm(search))
        || norm(i.extra.shortDescription).includes(norm(search))
      )).map((ind) => ({
        id: ind.scriptIdPart,
        version: ind.version,
        name: ind.scriptName,
        author: {
          id: ind.userId,
          username: '@TRADINGVIEW@',
        },
        image: '',
        access: 'closed_source',
        source: '',
        type: (ind.extra && ind.extra.kind) ? ind.extra.kind : 'study',
        get() {
          return module.exports.getIndicator(ind.scriptIdPart, ind.version);
        },
      })),

      ...data.results.map((ind) => ({
        id: ind.scriptIdPart,
        version: ind.version,
        name: ind.scriptName,
        author: {
          id: ind.author.id,
          username: ind.author.username,
        },
        image: ind.imageUrl,
        access: ['open_source', 'closed_source', 'invite_only'][ind.access - 1] || 'other',
        source: ind.scriptSource,
        type: (ind.extra && ind.extra.kind) ? ind.extra.kind : 'study',
        get() {
          return module.exports.getIndicator(ind.scriptIdPart, ind.version);
        },
      })),
    ];
  },

  /**
   * Get an indicator
   * @function getIndicator
   * @param {string} id Indicator ID (Like: PUB;XXXXXXXXXXXXXXXXXXXXX)
   * @param {'last' | string} [version] Wanted version of the indicator
   * @param {string} [session] User 'sessionid' cookie
   * @param {string} [signature] User 'sessionid_sign' cookie
   * @returns {Promise<PineIndicator>} Indicator
   */
  async getIndicator(id, version = 'last', session = '', signature = '') {
    const indicID = id.replace(/ |%/g, '%25');

    const { data } = await axios.get(
      `https://pine-facade.tradingview.com/pine-facade/translate/${indicID}/${version}`,
      {
        headers: {
          cookie: genAuthCookies(session, signature),
        },
        validateStatus,
      },
    );

    if (!data.success || !data.result.metaInfo || !data.result.metaInfo.inputs) {
      throw new Error(`Inexistent or unsupported indicator: "${data.reason}"`);
    }

    const inputs = {};

    data.result.metaInfo.inputs.forEach((input) => {
      if (['text', 'pineId', 'pineVersion'].includes(input.id)) return;

      const inlineName = input.name.replace(/ /g, '_').replace(/[^a-zA-Z0-9_]/g, '');

      inputs[input.id] = {
        name: input.name,
        inline: input.inline || inlineName,
        internalID: input.internalID || inlineName,
        tooltip: input.tooltip,

        type: input.type,
        value: input.defval,
        isHidden: !!input.isHidden,
        isFake: !!input.isFake,
      };

      if (input.options) inputs[input.id].options = input.options;
    });

    const plots = {};

    Object.keys(data.result.metaInfo.styles).forEach((plotId) => {
      const plotTitle = data
        .result
        .metaInfo
        .styles[plotId]
        .title
        .replace(/ /g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '');

      const titles = Object.values(plots);

      if (titles.includes(plotTitle)) {
        let i = 2;
        while (titles.includes(`${plotTitle}_${i}`)) i += 1;
        plots[plotId] = `${plotTitle}_${i}`;
      } else plots[plotId] = plotTitle;
    });

    data.result.metaInfo.plots.forEach((plot) => {
      if (!plot.target) return;
      plots[plot.id] = `${plots[plot.target] ?? plot.target}_${plot.type}`;
    });

    return new PineIndicator({
      pineId: data.result.metaInfo.scriptIdPart || indicID,
      pineVersion: data.result.metaInfo.pine.version || version,
      description: data.result.metaInfo.description,
      shortDescription: data.result.metaInfo.shortDescription,
      inputs,
      plots,
      script: data.result.ilTemplate,
    });
  },

  /**
   * @typedef {Object} User Instance of User
   * @prop {number} id User ID
   * @prop {string} username User username
   * @prop {string} firstName User first name
   * @prop {string} lastName User last name
   * @prop {number} reputation User reputation
   * @prop {number} following Number of following accounts
   * @prop {number} followers Number of followers
   * @prop {Object} notifications User's notifications
   * @prop {number} notifications.user User notifications
   * @prop {number} notifications.following Notification from following accounts
   * @prop {string} session User session
   * @prop {string} sessionHash User session hash
   * @prop {string} signature User session signature
   * @prop {string} privateChannel User private channel
   * @prop {string} authToken User auth token
   * @prop {Date} joinDate Account creation date
   */

  /**
   * Get user and sessionid from username/email and password
   * @function loginUser
   * @param {string} username User username/email
   * @param {string} password User password
   * @param {boolean} [remember] Remember the session (default: false)
   * @param {string} [UA] Custom UserAgent
   * @returns {Promise<User>} Token
   */
  async loginUser(username, password, remember = true, UA = 'TWAPI/3.0') {
    const { data, headers } = await axios.post(
      'https://www.tradingview.com/accounts/signin/',
      `username=${username}&password=${password}${remember ? '&remember=on' : ''}`,
      {
        headers: {
          referer: 'https://www.tradingview.com',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-agent': `${UA} (${os.version()}; ${os.platform()}; ${os.arch()})`,
        },
        validateStatus,
      },
    );

    const cookies = headers['set-cookie'];

    if (data.error) throw new Error(data.error);

    const sessionCookie = cookies.find((c) => c.includes('sessionid='));
    const session = (sessionCookie.match(/sessionid=(.*?);/) ?? [])[1];

    const signCookie = cookies.find((c) => c.includes('sessionid_sign='));
    const signature = (signCookie.match(/sessionid_sign=(.*?);/) ?? [])[1];

    return {
      id: data.user.id,
      username: data.user.username,
      firstName: data.user.first_name,
      lastName: data.user.last_name,
      reputation: data.user.reputation,
      following: data.user.following,
      followers: data.user.followers,
      notifications: data.user.notification_count,
      session,
      signature,
      sessionHash: data.user.session_hash,
      privateChannel: data.user.private_channel,
      authToken: data.user.auth_token,
      joinDate: new Date(data.user.date_joined),
    };
  },

  /**
   * Get user from 'sessionid' cookie
   * @function getUser
   * @param {string} session User 'sessionid' cookie
   * @param {string} [signature] User 'sessionid_sign' cookie
   * @param {string} [location] Auth page location (For france: https://fr.tradingview.com/)
   * @returns {Promise<User>} Token
   */
  async getUser(session, signature = '', location = 'https://www.tradingview.com/', redirectCount = 0) {
    if (redirectCount > 5) {
      throw new Error('Too many redirects - possible WAF or geo-restriction');
    }

    const { data, headers } = await axios.get(location, {
      headers: {
        cookie: genAuthCookies(session, signature),
      },
      maxRedirects: 0,
      validateStatus,
    });

    if (data.includes('auth_token')) {
      return {
        id: /"id":([0-9]{1,10}),/.exec(data)?.[1],
        username: /"username":"(.*?)"/.exec(data)?.[1],
        firstName: /"first_name":"(.*?)"/.exec(data)?.[1],
        lastName: /"last_name":"(.*?)"/.exec(data)?.[1],
        reputation: parseFloat(/"reputation":(.*?),/.exec(data)?.[1] || 0),
        following: parseFloat(/,"following":([0-9]*?),/.exec(data)?.[1] || 0),
        followers: parseFloat(/,"followers":([0-9]*?),/.exec(data)?.[1] || 0),
        notifications: {
          following: parseFloat(/"notification_count":\{"following":([0-9]*),/.exec(data)?.[1] ?? 0),
          user: parseFloat(/"notification_count":\{"following":[0-9]*,"user":([0-9]*)/.exec(data)?.[1] ?? 0),
        },
        session,
        signature,
        sessionHash: /"session_hash":"(.*?)"/.exec(data)?.[1],
        privateChannel: /"private_channel":"(.*?)"/.exec(data)?.[1],
        authToken: /"auth_token":"(.*?)"/.exec(data)?.[1],
        joinDate: new Date(/"date_joined":"(.*?)"/.exec(data)?.[1] || 0),
      };
    }

    if (headers.location !== location) {
      return this.getUser(session, signature, headers.location, redirectCount + 1);
    }

    throw new Error('Wrong or expired sessionid/signature');
  },

  /**
   * Get user's private indicators from a 'sessionid' cookie
   * @function getPrivateIndicators
   * @param {string} session User 'sessionid' cookie
   * @param {string} [signature] User 'sessionid_sign' cookie
   * @returns {Promise<SearchIndicatorResult[]>} Search results
   */
  async getPrivateIndicators(session, signature = '') {
    const { data } = await axios.get(
      'https://pine-facade.tradingview.com/pine-facade/list',
      {
        headers: {
          cookie: genAuthCookies(session, signature),
        },
        params: {
          filter: 'saved',
        },
        validateStatus,
      },
    );

    return data.map((ind) => ({
      id: ind.scriptIdPart,
      version: ind.version,
      name: ind.scriptName,
      author: {
        id: -1,
        username: '@ME@',
      },
      image: ind.imageUrl,
      access: 'private',
      source: ind.scriptSource,
      type: (ind.extra && ind.extra.kind) ? ind.extra.kind : 'study',
      get() {
        return module.exports.getIndicator(
          ind.scriptIdPart,
          ind.version,
          session,
          signature,
        );
      },
    }));
  },

  /**
   * @typedef {Object} PineMessage
   * @prop {string} message Message text
   * @prop {{ line: number, column: number }} [start] Start position
   * @prop {{ line: number, column: number }} [end] End position
   */

  /**
   * @typedef {Object} PineCompileResult
   * @prop {boolean} success True if the script compiles without errors
   * @prop {PineMessage[]} errors Compilation errors
   * @prop {PineMessage[]} warnings Compilation warnings
   * @prop {Object} [raw] Full TradingView response, for debugging
   */

  /**
   * Compile a Pine script without saving it
   * @function translatePineScript
   * @param {string} source Full Pine script source
   * @param {string} session User 'sessionid' cookie
   * @param {string} [signature] User 'sessionid_sign' cookie
   * @param {Object} [options]
   * @param {string} [options.username] Username (avoids a getUser request)
   * @returns {Promise<PineCompileResult>} Compilation result
   */
  async translatePineScript(source, session, signature = '', options = {}) {
    const username = await resolveUsername(session, signature, options);

    const { data, status } = await axios.post(
      PINE_TRANSLATE_URL,
      new URLSearchParams({ source }).toString(),
      {
        params: { user_name: username, v: 3 },
        headers: pineHeaders(session, signature),
        validateStatus,
      },
    );

    if (!data || typeof data !== 'object') throw pineFacadeError('compilation', status, data);

    // TradingView risponde success: true anche con errori di compilazione
    const result = data.result || {};
    const errors = [
      ...(result.errors2 || result.errors || []),
      ...((data.reason2 && data.reason2.errors) || []),
    ];
    if (!data.success && !errors.length) {
      errors.push({ message: data.reason || data.message || `HTTP ${status}` });
    }

    return {
      success: !!data.success && !errors.length,
      errors,
      warnings: result.warnings2 || result.warnings || [],
      raw: data,
    };
  },

  /**
   * @typedef {Object} PineScriptSource
   * @prop {string} id Script ID (Like: USER;XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX)
   * @prop {string} name Script name in the account
   * @prop {string} title Title declared in the source
   * @prop {string} version Script version
   * @prop {'study' | 'strategy'} type Script type
   * @prop {string} source Full Pine source
   * @prop {Date} created Creation date
   * @prop {Date} updated Last update date
   */

  /**
   * Get the source of a private Pine script
   * @function getPineScriptSource
   * @param {string} id Script ID (Like: USER;XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX)
   * @param {'last' | string} [version] Wanted version
   * @param {string} session User 'sessionid' cookie
   * @param {string} [signature] User 'sessionid_sign' cookie
   * @returns {Promise<PineScriptSource>} Script source
   */
  async getPineScriptSource(id, version = 'last', session = '', signature = '') {
    const pineId = normalizePineId(id);

    const { data, status } = await axios.get(
      `${PINE_GET_URL}/${encodeURIComponent(pineId)}/${encodeURIComponent(version)}`,
      {
        headers: pineHeaders(session, signature),
        validateStatus,
      },
    );

    if (status !== 200 || !data || typeof data.source !== 'string') {
      throw pineFacadeError('read', status, data);
    }

    return {
      id: pineId,
      name: data.scriptName,
      title: data.scriptTitle,
      version: data.version,
      type: (data.extra && data.extra.kind) ? data.extra.kind : 'study',
      source: data.source,
      created: new Date(data.created),
      updated: new Date(data.updated),
    };
  },

  /**
   * @typedef {Object} SavedPineScript
   * @prop {string} id Script ID (Like: USER;XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX)
   * @prop {string} name Script name in the account
   * @prop {string} version Script version
   */

  /**
   * Create a new private Pine script in the user account.
   * The source is compiled first and nothing is saved if it has errors.
   * @function createPineScript
   * @param {string} source Full Pine script source
   * @param {string} name Script name (must not already exist)
   * @param {string} session User 'sessionid' cookie
   * @param {string} [signature] User 'sessionid_sign' cookie
   * @param {Object} [options]
   * @param {string} [options.username] Username (avoids a getUser request)
   * @param {boolean} [options.skipCompile] Skip the compilation check
   * @returns {Promise<SavedPineScript>} Created script
   */
  async createPineScript(source, name, session, signature = '', options = {}) {
    if (!name) throw new Error('Missing pine script name');
    const username = await resolveUsername(session, signature, options);

    // Con codice non compilabile TradingView salva comunque lo script
    if (!options.skipCompile) {
      const compiled = await module.exports.translatePineScript(
        source,
        session,
        signature,
        { username },
      );
      if (!compiled.success) {
        throw new Error(`Pine script compilation failed: ${formatPineErrors(compiled.errors)}`);
      }
    }

    const { data, status } = await axios.post(
      PINE_SAVE_NEW_URL,
      new URLSearchParams({ source }).toString(),
      {
        params: { name, user_name: username, allow_use_existing_draft: false },
        headers: pineHeaders(session, signature),
        validateStatus,
      },
    );

    const result = (data && data.result) || {};
    const id = result.scriptIdPart || (result.metaInfo && result.metaInfo.scriptIdPart);
    if (status !== 200 || !id) throw pineFacadeError('creation', status, data);

    const saved = await findPrivateScript(id, session, signature);
    if (!saved) throw new Error(`Pine script ${id} was saved but is not in the private list`);

    return { id, name: saved.name, version: saved.version };
  },

  /**
   * Update the source of an existing private Pine script.
   * The source is compiled first and nothing is saved if it has errors.
   * @function updatePineScript
   * @param {string} id Script ID (Like: USER;XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX)
   * @param {string} source New full Pine script source
   * @param {string} session User 'sessionid' cookie
   * @param {string} [signature] User 'sessionid_sign' cookie
   * @param {Object} [options]
   * @param {string} [options.name] New script name (default: current name)
   * @param {string} [options.username] Username (avoids a getUser request)
   * @param {boolean} [options.skipCompile] Skip the compilation check
   * @returns {Promise<SavedPineScript>} Updated script
   */
  async updatePineScript(id, source, session, signature = '', options = {}) {
    const pineId = normalizePineId(id);
    const username = await resolveUsername(session, signature, options);

    const current = await findPrivateScript(pineId, session, signature);
    if (!current) throw new Error(`Pine script ${pineId} is not in the private list`);
    const name = options.name || current.name;

    if (!options.skipCompile) {
      const compiled = await module.exports.translatePineScript(
        source,
        session,
        signature,
        { username },
      );
      if (!compiled.success) {
        throw new Error(`Pine script compilation failed: ${formatPineErrors(compiled.errors)}`);
      }
    }

    const { data, status } = await axios.post(
      `${PINE_SAVE_NEXT_URL}/${encodeURIComponent(pineId)}`,
      new URLSearchParams({ source }).toString(),
      {
        params: { allow_create_new: false, name, user_name: username },
        headers: pineHeaders(session, signature),
        validateStatus,
      },
    );

    const result = (data && data.result) || {};
    const savedId = result.scriptIdPart || (result.metaInfo && result.metaInfo.scriptIdPart);
    if (status !== 200 || !data.success || savedId !== pineId) {
      throw pineFacadeError('update', status, data);
    }

    const saved = await findPrivateScript(pineId, session, signature);
    if (!saved || saved.name !== name) {
      throw new Error(`Pine script ${pineId} was updated but the private list does not match`);
    }

    return { id: pineId, name: saved.name, version: saved.version };
  },

  /**
   * Rename a private Pine script without changing its source
   * @function renamePineScript
   * @param {string} id Script ID (Like: USER;XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX)
   * @param {string} name New script name
   * @param {string} session User 'sessionid' cookie
   * @param {string} [signature] User 'sessionid_sign' cookie
   * @returns {Promise<SavedPineScript>} Renamed script
   */
  async renamePineScript(id, name, session, signature = '') {
    if (!name) throw new Error('Missing pine script name');
    const pineId = normalizePineId(id);

    const { data, status } = await axios.post(
      `${PINE_RENAME_URL}/${encodeURIComponent(pineId)}`,
      '',
      {
        params: { name },
        headers: pineHeaders(session, signature),
        validateStatus,
      },
    );

    if (status !== 200 || data !== 'ok') throw pineFacadeError('rename', status, data);

    const saved = await findPrivateScript(pineId, session, signature);
    if (!saved || saved.name !== name) {
      throw new Error(`Pine script ${pineId} was renamed but the private list does not match`);
    }

    return { id: pineId, name: saved.name, version: saved.version };
  },

  /**
   * Delete a private Pine script from the user account
   * @function deletePineScript
   * @param {string} id Script ID (Like: USER;XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX)
   * @param {string} session User 'sessionid' cookie
   * @param {string} [signature] User 'sessionid_sign' cookie
   * @returns {Promise<true>} True once the script is no longer in the private list
   */
  async deletePineScript(id, session, signature = '') {
    const pineId = normalizePineId(id);

    const { data, status } = await axios.post(
      `${PINE_DELETE_URL}/${encodeURIComponent(pineId)}`,
      '',
      {
        headers: pineHeaders(session, signature),
        validateStatus,
      },
    );

    if (status !== 200 || data !== 'ok') throw pineFacadeError('deletion', status, data);

    if (await findPrivateScript(pineId, session, signature)) {
      throw new Error(`Pine script ${pineId} is still in the private list after deletion`);
    }

    return true;
  },

  /**
   * User credentials
   * @typedef {Object} UserCredentials
   * @prop {number} id User ID
   * @prop {string} session User session ('sessionid' cookie)
   * @prop {string} [signature] User session signature ('sessionid_sign' cookie)
   */

  /**
   * Get a chart token from a layout ID and the user credentials if the layout is not public
   * @function getChartToken
   * @param {string} layout The layout ID found in the layout URL (Like: 'XXXXXXXX')
   * @param {UserCredentials} [credentials] User credentials (id + session + [signature])
   * @returns {Promise<string>} Token
   */
  async getChartToken(layout, credentials = {}) {
    const { id, session, signature } = (
      credentials.id && credentials.session
        ? credentials
        : { id: -1, session: null, signature: null }
    );

    const { data } = await axios.get(
      'https://www.tradingview.com/chart-token',
      {
        headers: {
          cookie: genAuthCookies(session, signature),
        },
        params: {
          image_url: layout,
          user_id: id,
        },
        validateStatus,
      },
    );

    if (!data.token) throw new Error('Wrong layout or credentials');

    return data.token;
  },

  /**
   * @typedef {Object} DrawingPoint Drawing poitn
   * @prop {number} time_t Point X time position
   * @prop {number} price Point Y price position
   * @prop {number} offset Point offset
   */

  /**
   * @typedef {Object} Drawing
   * @prop {string} id Drawing ID (Like: 'XXXXXX')
   * @prop {string} symbol Layout market symbol (Like: 'BINANCE:BUCEUR')
   * @prop {string} ownerSource Owner user ID (Like: 'XXXXXX')
   * @prop {string} serverUpdateTime Drawing last update timestamp
   * @prop {string} currencyId Currency ID (Like: 'EUR')
   * @prop {any} unitId Unit ID
   * @prop {string} type Drawing type
   * @prop {DrawingPoint[]} points List of drawing points
   * @prop {number} zorder Drawing Z order
   * @prop {string} linkKey Drawing link key
   * @prop {Object} state Drawing state
   */

  /**
   * Get a chart token from a layout ID and the user credentials if the layout is not public
   * @function getDrawings
   * @param {string} layout The layout ID found in the layout URL (Like: 'XXXXXXXX')
   * @param {string | ''} [symbol] Market filter (Like: 'BINANCE:BTCEUR')
   * @param {UserCredentials} [credentials] User credentials (id + session + [signature])
   * @param {number} [chartID] Chart ID
   * @returns {Promise<Drawing[]>} Drawings
   */
  async getDrawings(layout, symbol = '', credentials = {}, chartID = '_shared') {
    const chartToken = await module.exports.getChartToken(layout, credentials);

    const { data } = await axios.get(
      `https://charts-storage.tradingview.com/charts-storage/get/layout/${
        layout
      }/sources`,
      {
        params: {
          chart_id: chartID,
          jwt: chartToken,
          symbol,
        },
        validateStatus,
      },
    );

    if (!data.payload) throw new Error('Wrong layout, user credentials, or chart id.');

    return Object.values(data.payload.sources || {}).map((drawing) => ({
      ...drawing, ...drawing.state,
    }));
  },
};
