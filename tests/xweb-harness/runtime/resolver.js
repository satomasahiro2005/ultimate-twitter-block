// x-web harness runtime: answer x-web's own GraphQL requests in the page.
//
// x-web (X's new frontend) is a Relay app. Every query it sends carries a
// persisted id and an operation name; the full normalization AST of that
// operation (every field, argument, fragment and type condition) is in the
// bundle and reaches the Relay environment with each request. We capture the
// AST from the environment and answer the request by walking it over a plain
// data graph (XWH_RT.root, built by data/xweb-graph.js). Fields the graph does
// not have resolve to null, so new screens work without hand-written
// responses, and missing data shows up in XWH_RT.misses.
//
// Loaded as a classic script before x-web's entry module, in fixture mode
// (offline runner) and live mode (logged-in x.com tab) alike.
(function (g) {
  'use strict';
  const RT = g.XWH_RT = g.XWH_RT || {};
  RT.ops = RT.ops || {};          // operation name / persisted id -> ConcreteRequest
  RT.misses = RT.misses || {};    // "Type.field" -> count, for filling in the graph
  RT.served = RT.served || [];    // [{ name, variables, ms }]
  RT.log = RT.log || [];
  RT.pending = RT.pending || 0;   // GraphQL requests being answered (live reads can take a while)

  // ------------------------------------------------------------ AST capture
  function register(node) {
    if (!node || !node.params) return;
    const p = node.params;
    if (p.name && !RT.ops[p.name]) RT.ops[p.name] = node;
    const id = p.id || p.cacheID;
    if (id && !RT.ops[id]) RT.ops[id] = node;
  }
  function nodeOf(arg) {
    const op = arg && (arg.operation || arg);
    return op && op.request && op.request.node;
  }
  RT.hookEnvironment = function hookEnvironment(env) {
    if (!env || env.__xwhHooked) return env;
    env.__xwhHooked = true;
    ['execute', 'executeWithSource', 'executeSubscription', 'executeMutation'].forEach((m) => {
      const orig = env[m];
      if (typeof orig !== 'function') return;
      env[m] = function (arg) {
        try { register(nodeOf(arg)); } catch (err) { /* never break Relay */ }
        return orig.apply(this, arguments);
      };
    });
    RT.environment = env;
    return env;
  };

  function waitForOp(name, id, timeoutMs) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      (function poll() {
        const n = RT.ops[name] || RT.ops[id];
        if (n || Date.now() - t0 > timeoutMs) return resolve(n || null);
        setTimeout(poll, 5);
      })();
    });
  }

  // ------------------------------------------------------------ AST walk
  function argValue(a, vars) {
    switch (a.kind) {
      case 'Literal': return a.value;
      case 'Variable': return vars[a.variableName];
      case 'ObjectValue': { const o = {}; (a.fields || []).forEach((f) => { o[f.name] = argValue(f, vars); }); return o; }
      case 'ListValue': return (a.items || []).map((i) => (i == null ? null : argValue(i, vars)));
      default: return undefined;
    }
  }
  function argsOf(sel, vars) {
    const o = {};
    (sel.args || []).forEach((a) => { o[a.name] = argValue(a, vars); });
    return o;
  }

  function typeOf(src, fallback) {
    return (src && src.__typename) || fallback || null;
  }
  // abstract type membership: graph objects may list interfaces in __implements
  function matches(src, type, abstractKey, typename) {
    const t = typeOf(src, typename);
    if (!abstractKey) return t === type;
    if (t === type) return true;
    return Boolean(src && Array.isArray(src.__implements) && src.__implements.indexOf(type) !== -1);
  }

  function hashPath(path) {
    let h = 2166136261;
    for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 16777619) >>> 0;
    return h.toString(36);
  }

  function readField(src, sel, vars, ctx) {
    if (src == null) return undefined;
    let v = src[sel.name];
    if (typeof v === 'function') v = v.call(src, argsOf(sel, vars), ctx);
    return v;
  }

  // Graph values may be Promises (live mode fetches on demand): everything awaits.
  async function walk(selections, src, vars, out, typename, path, ctx) {
    for (const sel of selections || []) {
      switch (sel.kind) {
        case 'ScalarField': {
          const key = sel.alias || sel.name;
          if (key in out && out[key] != null) break;
          if (sel.name === '__typename') { out[key] = typeOf(src, typename); break; }
          let v = await readField(src, sel, vars, ctx);
          if (v === undefined && sel.name === 'id') v = (typename || 'Node') + ':xwh:' + hashPath(path);
          if (v === undefined) { miss(typename, sel.name); v = null; }
          out[key] = v;
          break;
        }
        case 'LinkedField': {
          const key = sel.alias || sel.name;
          const v = await readField(src, sel, vars, ctx);
          const sub = path + '.' + key + (sel.args ? JSON.stringify(argsOf(sel, vars)) : '');
          if (v == null) {
            if (v === undefined) miss(typename, sel.name);
            if (!(key in out)) out[key] = null;
            break;
          }
          const one = async (item, i) => {
            item = await item;
            if (item == null) return null;
            const prev = sel.plural ? null : out[key];
            const o = prev && typeof prev === 'object' ? prev : {};
            await walk(sel.selections, item, vars, o, typeOf(item, sel.concreteType), sub + (i == null ? '' : '[' + i + ']'), ctx);
            return o;
          };
          if (sel.plural) {
            const list = Array.isArray(v) ? v : [];
            const items = [];
            for (let i = 0; i < list.length; i++) items.push(await one(list[i], i));
            out[key] = items;
          } else {
            out[key] = await one(v);
          }
          break;
        }
        case 'InlineFragment':
          if (matches(src, sel.type, sel.abstractKey, typename)) await walk(sel.selections, src, vars, out, typename, path, ctx);
          break;
        case 'FragmentSpread': {
          const frag = sel.fragment;
          if (!frag) break;
          // Split operations declare their local arguments (prefixed, e.g.
          // "timeline$withDefaultTweet") with defaults; the spread may override them.
          let v2 = vars;
          if ((frag.argumentDefinitions && frag.argumentDefinitions.length) || (sel.args && sel.args.length)) {
            v2 = Object.assign({}, vars);
            (frag.argumentDefinitions || []).forEach((d) => { if (d.kind === 'LocalArgument' && !(d.name in v2)) v2[d.name] = d.defaultValue; });
            Object.assign(v2, argsOf(sel, vars));
          }
          await walk(frag.selections, src, v2, out, typename, path, ctx);
          break;
        }
        case 'Condition':
          if (Boolean(vars[sel.condition]) === sel.passingValue) await walk(sel.selections, src, vars, out, typename, path, ctx);
          break;
        case 'Defer':
        case 'Stream':
          await walk(sel.selections, src, vars, out, typename, path, ctx);
          break;
        case 'TypeDiscriminator':
          if (sel.abstractKey) out[sel.abstractKey] = typeOf(src, typename);
          break;
        case 'ClientComponent':
        case 'RelayResolver':
        case 'RelayLiveResolver':
          // Client-side resolvers compute a field from server data: the data
          // they read (their root fragment) still has to come in the response.
          if (sel.fragment && sel.fragment.selections) await walk(sel.fragment.selections, src, vars, out, typename, path, ctx);
          break;
        case 'ClientEdgeToClientObject':
          if (sel.backingField) await walk([sel.backingField], src, vars, out, typename, path, ctx);
          break;
        default:
          // LinkedHandle / ScalarHandle / ClientExtension / ModuleImport /
          // RelayResolver / ActorChange: client side, nothing to send
          break;
      }
    }
    return out;
  }

  function miss(type, field) {
    const k = (type || '?') + '.' + field;
    RT.misses[k] = (RT.misses[k] || 0) + 1;
  }

  RT.resolve = async function resolve(node, variables) {
    const vars = Object.assign({}, variables);
    const pv = node.params && node.params.providedVariables;
    if (pv) Object.keys(pv).forEach((k) => { try { vars[k] = pv[k].get(); } catch (err) { vars[k] = null; } });
    const ctx = { node, vars, name: node.params && node.params.name };
    const root = typeof RT.root === 'function' ? RT.root(ctx) : (RT.root || {});
    const data = await walk(node.operation.selections, root, vars, {}, node.operation.kind === 'Operation' ? (node.params.operationKind === 'mutation' ? 'Mutation' : 'Query') : null, ctx.name, ctx);
    return { data };
  };

  // ------------------------------------------------------------ fetch layer
  const GQL_RE = /^\/(?:i\/api\/)?graphql\/([^/]+)\/(\w+)$/;
  function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), { status: status || 200, headers: { 'content-type': 'application/json' } });
  }

  // Non-GraphQL endpoints x-web calls while booting. Answered locally with
  // empty-but-valid bodies so nothing leaves the page.
  const CANNED = [
    [/^\/1\.1\/guest\/activate\.json$/, () => ({ guest_token: '1' })],
    [/^\/1\.1\/hashflags\.json$/, () => []],
    [/^\/2\/guide\.json$/, () => ({ timeline: { id: 'guide', instructions: [] } })],
    [/^\/1\.1\/jot\//, () => ({})],
    [/^\/1\.1\/graphql\/viewer_context\.json$/, () => ({})],
    [/^\/1\.1\/flow\//, () => ({})],
    [/^\/1\.1\/account\/settings\.json$/, () => ({ screen_name: '', language: 'en' })],
    [/^\/1\.1\/attribution\/event\.json$/, () => ({})],
    [/^\/1\.1\/live_pipeline\//, () => ({})],
  ];

  // Hosts x-web talks to besides api.x.com that must never be reached.
  const SINK_HOSTS = /(^|\.)(sentry\.io|ingest\.sentry\.io|castle\.io|google-analytics\.com|doubleclick\.net)$/;

  RT.isXwebRequest = function (u) {
    return u.hostname === 'api.x.com' || u.hostname === 'api.twitter.com' || SINK_HOSTS.test(u.hostname);
  };

  RT.handle = async function handle(url, init) {
    const u = new URL(url, g.location.href);
    if (SINK_HOSTS.test(u.hostname)) return jsonResponse({});
    const m = u.pathname.match(GQL_RE);
    if (m) {
      RT.pending++;
      try {
        return await answer(m, u, init);
      } finally {
        RT.pending--;
      }
    }
    for (const [re, fn] of CANNED) if (re.test(u.pathname)) return jsonResponse(fn(u));
    RT.log.push('unhandled ' + ((init && init.method) || 'GET') + ' ' + u.href);
    return jsonResponse({}, 404);
  };

  async function answer(m, u, init) {
    const [, id, name] = m;
    const t0 = Date.now();
    const node = await waitForOp(name, id, 3000);
    let variables = {};
    try {
      if (init && init.body && typeof init.body === 'string') variables = JSON.parse(init.body).variables || {};
      else variables = JSON.parse(u.searchParams.get('variables') || '{}');
    } catch (err) { /* keep {} */ }
    if (!node) {
      RT.log.push('no AST for ' + name);
      return jsonResponse({ errors: [{ message: 'xweb-harness: no AST for ' + name }] });
    }
    if (node.params.operationKind === 'mutation') {
      // Never mutate anything. The UI gets an error like a failed request.
      RT.log.push('refused mutation ' + name);
      return jsonResponse({ errors: [{ message: 'xweb-harness: mutations are disabled' }] }, 200);
    }
    let body;
    try { body = await RT.resolve(node, variables); } catch (err) {
      RT.log.push('resolve ' + name + ' failed: ' + (err && err.stack || err));
      body = { errors: [{ message: String(err) }] };
    }
    RT.served.push({ name, variables, ms: Date.now() - t0 });
    return jsonResponse(body);
  }

  RT.installFetch = function installFetch() {
    if (RT.fetchInstalled) return;
    RT.fetchInstalled = true;
    const orig = g.fetch;
    g.fetch = function (input, init) {
      let href;
      try { href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; } catch (err) { href = null; }
      if (href) {
        let u;
        try { u = new URL(href, g.location.href); } catch (err) { u = null; }
        if (u && RT.isXwebRequest(u)) {
          if (input && typeof input === 'object' && !(input instanceof URL) && !init) {
            return input.text().then((body) => RT.handle(u.href, { method: input.method, body }));
          }
          return RT.handle(u.href, init);
        }
      }
      return orig.apply(this, arguments);
    };
    // sendBeacon is used for telemetry: swallow it for x-web hosts
    if (g.navigator && g.navigator.sendBeacon) {
      const ob = g.navigator.sendBeacon.bind(g.navigator);
      g.navigator.sendBeacon = function (url, data) {
        try { if (RT.isXwebRequest(new URL(url, g.location.href))) return true; } catch (err) { /* fall through */ }
        return ob(url, data);
      };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
