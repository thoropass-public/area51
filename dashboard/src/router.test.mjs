// The one test file in this repository, and it is worth explaining why it
// exists at all.
//
// AREA 51 has no test suite. `./a51 doctor` is how a deployment is verified: it
// checks every binding, domain and policy, and probes the live hosts. That works
// because almost everything here fails loudly — a missing binding 500s, an
// unbound hostname answers 530, a broken worker does not deploy.
//
// Route precedence is the exception. When Pages derived routes from the
// filesystem it also resolved, invisibly and for free, which route won when two
// matched. router.js has to do that itself now, and getting it wrong does not
// throw, does not fail a deploy, and does not show up in `doctor`: it quietly
// sends a request to the wrong handler. `GET /api/endpoints/upload` matching the
// `:uri` route would run a D1 lookup for an endpoint named "upload" and answer
// a plausible-looking 404. The first draft of router.js did exactly that.
//
// So this file exists to pin the behaviour that cannot announce its own
// breakage, and nothing else. It is plain node with no dependencies and no
// framework:
//
//   node dashboard/src/router.test.mjs
//
// The route table is PARSED OUT of index.js rather than restated here, so a
// route added there is covered here automatically and the two cannot drift.
// Being inside src/ is deliberate — it sits next to what it tests, and wrangler
// only bundles what index.js imports, so it never ships. It must never move to
// public/, which is served.

import { readFileSync } from 'node:fs';
import { buildRouter } from './router.js';

const indexPath = new URL('./index.js', import.meta.url);
const src = readFileSync(indexPath, 'utf8');

const block = src.match(/const ROUTES = \[([\s\S]*?)\n\];/);
if (!block) {
  console.error('could not find `const ROUTES = [...]` in src/index.js — has the table been renamed?');
  process.exit(1);
}

// [method, path, handlerName]. The handler NAME stands in for the function, so
// an assertion can say which handler it expected without importing any of them
// (importing index.js would need a Worker environment).
const ROUTES = [...block[1].matchAll(/\[\s*'([A-Z]+)',\s*'([^']+)',\s*(\w+)\s*\]/g)]
  .map(([, method, path, name]) => [method, path, name]);

const match = buildRouter(ROUTES);

let pass = 0;
const failures = [];

function check(method, path, expect) {
  const r = match(method, path);
  const got = !r ? '404'
    : r.handler ? r.handler
    : `405 Allow:${r.allow.sort().join(',')}`;
  if (got === expect) {
    pass++;
  } else {
    failures.push(`${method} ${path}\n      expected ${expect}\n      got      ${got}`);
  }
}

function checkParams(method, path, handler, params) {
  const r = match(method, path);
  const gotParams = JSON.stringify((r && r.params) || null);
  const want = JSON.stringify(params);
  if (r && r.handler === handler && gotParams === want) {
    pass++;
  } else {
    failures.push(`${method} ${path}\n      expected ${handler} ${want}\n      got      ${r && (r.handler || '405/' + r.allow)} ${gotParams}`);
  }
}

// ── every declared route reaches its own handler ─────────────────────────────
// Guards against a table edit that shadows an existing route.
for (const [method, path, name] of ROUTES) {
  check(method, path.replace(/:(\w+)/g, (_, p) => (p === 'uri' ? '%2Ftest' : 'sample-id')), name);
}

// ── literal paths beat param routes, whatever the method ────────────────────
// /api/endpoints/upload matches both the literal route and /api/endpoints/:uri.
// Pages preferred the literal one. The GET and DELETE cases are the ones that
// bite: a router that only consults its literal table when the METHOD also
// matches falls through to :uri and treats "upload" as an endpoint URI.
check('POST', '/api/endpoints/upload', 'uploadEndpointFile');
check('GET', '/api/endpoints/upload', '405 Allow:POST');
check('DELETE', '/api/endpoints/upload', '405 Allow:POST');

// ── a percent-encoded endpoint URI stays ONE segment ────────────────────────
// The dashboard sends encodeURIComponent(uri), so every real endpoint URI
// arrives with its leading "/" as "%2F" and any nested ones too. url.pathname
// preserves that, and the handler decodes it. This is why matching splits the
// raw pathname instead of using URLPattern, which canonicalizes it.
checkParams('GET', '/api/endpoints/%2F-%2Fcallback', 'getEndpoint', { uri: '%2F-%2Fcallback' });
checkParams('GET', '/api/endpoints/%2Ffoo%2Fbar%2Fbaz', 'getEndpoint', { uri: '%2Ffoo%2Fbar%2Fbaz' });
checkParams('DELETE', '/api/endpoints/%2F', 'deleteEndpoint', { uri: '%2F' });
checkParams('GET', '/api/endpoints/%2Fa%3Fb%23c', 'getEndpoint', { uri: '%2Fa%3Fb%23c' });

// ── two methods on one path resolve separately ──────────────────────────────
check('GET', '/api/emails', 'listEmails');
check('PATCH', '/api/emails', 'markGroup');
checkParams('GET', '/api/emails/abc', 'getEmail', { id: 'abc' });
checkParams('PATCH', '/api/emails/abc', 'patchEmail', { id: 'abc' });

// ── 404 vs 405 ──────────────────────────────────────────────────────────────
check('GET', '/api/nope', '404');
check('GET', '/api/emails/abc/nope', '404');
check('GET', '/api/requests/a/b/c', '404');
check('DELETE', '/api/requests', '405 Allow:GET');
check('POST', '/api/emails/abc', '405 Allow:GET,PATCH');
check('DELETE', '/api/emails/abc/raw', '405 Allow:GET');

// An empty segment must not satisfy a parameter: without that guard,
// /api/emails/ matches :id with id = '' and queries for the row whose id is ''.
check('GET', '/api/emails/', '404');

// ── trailing-slash normalization, as src/index.js applies it ────────────────
// index.js strips one trailing slash BEFORE calling the router, so the 404
// above is never what a client actually sees for these.
const normalize = (p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
check('GET', normalize('/api/emails/'), 'listEmails');
check('GET', normalize('/api/requests/'), 'listRequests');
checkParams('GET', normalize('/api/emails/abc/'), 'getEmail', { id: 'abc' });

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n${failures.length} FAILED (${pass} passed), over ${ROUTES.length} declared routes:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`router: ${pass} assertions passed, over ${ROUTES.length} declared routes`);
