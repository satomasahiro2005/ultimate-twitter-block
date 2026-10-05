// x-web harness, live mode: reads with the classic app's own GraphQL operations.
//
// makeReader(discovered, model) -> fetchKind(kind, args): performs one read
// with the tab's own session (same origin x.com, same headers the classic app
// sends: its bearer, the ct0 CSRF cookie) and folds the answer into `model`
// (shape: see data/fixtures.js, plus conversations / searches). Queries only:
// an operation that is not a query is refused. Requests run one at a time.
//
// `discovered` = { ops: { Name: { id, method, features, fieldToggles } }, headers, bearer }
// comes from the passive tap (the classic app's own requests) and main.js.
(function (g) {
  'use strict';
  const X = g.XWH = g.XWH || {};

  // kind -> classic operation(s), variables, and where the result goes
  const KINDS = {
    user: { ops: ['UserByScreenName'], vars: (a) => ({ screen_name: a.screenName, withSafetyModeUserFields: true }) },
    following: { ops: ['Following'], vars: (a) => ({ userId: a.userId, count: 20, includePromotedContent: false }), list: (m, a, out) => { userList(m, a.userId).following = out.userIds; } },
    followers: { ops: ['Followers'], vars: (a) => ({ userId: a.userId, count: 20, includePromotedContent: false }), list: (m, a, out) => { userList(m, a.userId).followers = out.userIds; } },
    verifiedFollowers: { ops: ['BlueVerifiedFollowers'], vars: (a) => ({ userId: a.userId, count: 20, includePromotedContent: false }), list: (m, a, out) => { userList(m, a.userId).verifiedFollowers = out.userIds; } },
    profilePosts: { ops: ['UserTweets'], vars: (a) => ({ userId: a.userId, count: 20, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: true, withVoice: true }), list: (m, a, out) => { userList(m, a.userId).profilePosts = out.tweetIds; } },
    home: { ops: ['HomeTimeline', 'HomeLatestTimeline'], vars: () => ({ count: 20, includePromotedContent: false, latestControlAvailable: true, requestContext: 'launch', withCommunity: true }), list: (m, a, out) => { m.lists.home = out.tweetIds; } },
    conversation: {
      ops: ['TweetDetail'],
      vars: (a) => ({ focalTweetId: a.tweetId, with_rux_injections: false, rankingMode: 'Relevance', includePromotedContent: false, withCommunity: true, withQuickPromoteEligibilityTweetFields: true, withBirdwatchNotes: true, withVoice: true }),
      list: (m, a, out) => { m.conversations[a.tweetId] = out.tweetIds.filter((k) => !m.tweets[k] || m.tweets[k].id !== a.tweetId); },
    },
    search: {
      ops: ['SearchTimeline'],
      vars: (a) => ({ rawQuery: a.query, count: 20, querySource: 'typed_query', product: a.product || 'Top' }),
      list: (m, a, out) => { m.searches[a.query + '|' + (a.product || 'Top')] = a.product === 'People' ? out.userIds : out.tweetIds; },
    },
    notifications: { ops: ['NotificationsTimeline'], vars: () => ({ timeline_type: 'All', count: 20 }), notifications: true, list: (m, a, out) => { m.notifications = out.notifications; } },
    blocked: { ops: ['BlockedAccountsAll'], vars: () => ({ count: 20, includePromotedContent: false }), list: (m, a, out) => { m.lists.blocked = out.userIds; } },
    muted: { ops: ['MutedAccounts'], vars: () => ({ count: 20, includePromotedContent: false }), list: (m, a, out) => { m.lists.muted = out.userIds; } },
    whoToFollow: { ops: ['ConnectTabTimeline'], vars: () => ({ count: 20, context: '{}' }), list: (m, a, out) => { m.lists.whoToFollow = out.userIds; } },
  };
  // What to open in the classic UI so the tap learns an operation it lacks
  const HINT = {
    home: 'Home', notifications: 'Notifications', blocked: 'Settings > Blocked accounts', muted: 'Settings > Muted accounts',
    whoToFollow: 'Connect (who to follow)', search: 'a search', conversation: 'any post', profilePosts: 'any profile',
    following: 'a Following list', followers: 'a Followers list', verifiedFollowers: 'a Verified followers list', user: 'any profile',
  };

  function userList(m, id) { return m.userLists[id] || (m.userLists[id] = {}); }

  function ensureShape(m) {
    m.users = m.users || {}; m.tweets = m.tweets || {};
    m.lists = m.lists || {}; m.userLists = m.userLists || {};
    m.conversations = m.conversations || {}; m.searches = m.searches || {};
    m.strictLists = true;
    return m;
  }

  function cookie(name) {
    const m = g.document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Fold one classic response into the model for (kind, args).
  function apply(model, kind, args, json) {
    const k = KINDS[kind];
    const out = X.classic.ingest(model, json, { notifications: Boolean(k.notifications) });
    if (k.list) k.list(model, args, out);
    return out;
  }

  // classic op name + its variables -> (kind, args), for seeding from the tap
  function kindOf(name, v) {
    v = v || {};
    switch (name) {
      case 'UserByScreenName': return ['user', { screenName: v.screen_name }];
      case 'Following': return ['following', { userId: v.userId }];
      case 'Followers': return ['followers', { userId: v.userId }];
      case 'BlueVerifiedFollowers': return ['verifiedFollowers', { userId: v.userId }];
      case 'UserTweets': return ['profilePosts', { userId: v.userId }];
      case 'HomeTimeline': case 'HomeLatestTimeline': return v.cursor ? null : ['home', {}];
      case 'TweetDetail': return v.cursor ? null : ['conversation', { tweetId: v.focalTweetId }];
      case 'SearchTimeline': return v.cursor ? null : ['search', { query: v.rawQuery, product: v.product || 'Top' }];
      case 'NotificationsTimeline': return v.cursor ? null : ['notifications', {}];
      case 'BlockedAccountsAll': return ['blocked', {}];
      case 'MutedAccounts': return ['muted', {}];
      case 'ConnectTabTimeline': return ['whoToFollow', {}];
      default: return null;
    }
  }

  function seed(model, responses) {
    ensureShape(model);
    let n = 0;
    for (const r of responses || []) {
      const ka = kindOf(r.name, r.variables);
      if (!ka) continue;
      if (ka[0] !== 'user' && ka[1] && Object.values(ka[1]).some((x) => x == null)) continue;
      try { apply(model, ka[0], ka[1], r.json); n++; } catch (err) { /* skip malformed */ }
    }
    return n;
  }

  function makeReader(discovered, model) {
    ensureShape(model);
    let chain = Promise.resolve();
    const inflight = {};
    const log = (model.readLog = model.readLog || []);

    async function request(name, variables) {
      const op = discovered.ops[name];
      if (!op) return null;
      if (op.type && op.type !== 'query') throw new Error('refusing to send ' + op.type + ' ' + name);
      const features = op.features && !Array.isArray(op.features) ? op.features : {};
      if (Array.isArray(op.features)) op.features.forEach((f) => { features[f] = Boolean(discovered.featureValues && discovered.featureValues[f]); });
      const headers = Object.assign({
        authorization: 'Bearer ' + discovered.bearer,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
      }, discovered.headers || {}, {
        'x-csrf-token': cookie('ct0') || '',
        'content-type': 'application/json',
      });
      const path = '/i/api/graphql/' + op.id + '/' + name;
      const method = op.method || (/^Home/.test(name) ? 'POST' : 'GET');
      let res;
      if (method === 'POST') {
        res = await fetch(path, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ variables, features, fieldToggles: op.fieldToggles || undefined, queryId: op.id }) });
      } else {
        const qs = 'variables=' + encodeURIComponent(JSON.stringify(variables)) +
          '&features=' + encodeURIComponent(JSON.stringify(features)) +
          (op.fieldToggles ? '&fieldToggles=' + encodeURIComponent(JSON.stringify(op.fieldToggles)) : '');
        res = await fetch(path + '?' + qs, { credentials: 'include', headers });
      }
      log.push(name + ' ' + res.status);
      if (!res.ok) throw new Error(name + ': HTTP ' + res.status);
      return res.json();
    }

    return function fetchKind(kind, args) {
      const k = KINDS[kind];
      if (!k) return Promise.reject(new Error('unknown kind ' + kind));
      const key = kind + JSON.stringify(args || {});
      if (inflight[key]) return inflight[key];
      const p = chain.then(async () => {
        for (const name of k.ops) {
          if (!discovered.ops[name]) continue;
          const json = await request(name, k.vars(args || {}));
          if (json) return apply(model, kind, args || {}, json);
        }
        throw new Error('no ' + k.ops.join('/') + ' operation known yet: open ' + (HINT[kind] || kind) + ' once in the classic UI, then switch again');
      });
      chain = p.catch(() => {});
      inflight[key] = p;
      p.catch(() => { delete inflight[key]; });
      return p;
    };
  }

  X.reader = { makeReader, seed, apply, kindOf, KINDS, ensureShape };
  if (typeof module !== 'undefined' && module.exports) module.exports = X.reader;
})(typeof window !== 'undefined' ? window : globalThis);
