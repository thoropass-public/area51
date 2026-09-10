// The dashboard Worker.
//
// The dashboard used to be a Cloudflare Pages project: static files uploaded
// alongside a `functions/` directory that Pages turned into routes. It is now a
// Worker with static assets, which is what Cloudflare recommends for new
// projects and, more to the point here, what removes an entire class of problem
// this deployment used to have to defend against. See
// docs/decisions.md#the-dashboard-is-a-worker-not-a-pages-project.
//
// The division of labour is set in wrangler.toml and matters for both cost and
// correctness:
//
//   [assets] run_worker_first = ["/api/*"]
//
// Only `/api/*` invokes this code. Every static file — index.html, styles.css,
// the three .jsx files, the favicon — is served by Cloudflare's asset layer
// without ever entering this Worker, and requests to static assets are free and
// unlimited on both the Free and Paid plans. `run_worker_first = true` would
// make every one of them a billable Worker invocation for no benefit; the
// narrow form is the whole point.
//
// There is deliberately no `binding` under [assets]. The Worker never needs to
// serve an asset itself (the asset layer answers those requests before this code
// runs), so it is given no handle to read them with. Same reasoning as
// Autopilot's missing FILES binding: a capability that is never used should not
// be granted.
//
// `not_found_handling = "none"` means an unknown path outside /api/* 404s from
// the asset layer, again without invoking this Worker. The dashboard is a single
// index.html with tab state, not a client-side-routed SPA, so a
// single-page-application fallback would be wrong as well as pointless.
//
// No CORS headers anywhere. The API is same-origin, called only by the page it
// is served next to, and sits behind Cloudflare Access. Adding permissive CORS
// would widen that for nothing.

import { errResp } from './api/shared.js';
import { buildRouter } from './router.js';

import { listEndpoints, upsertEndpoint } from './api/endpoints/index.js';
import { getEndpoint, deleteEndpoint } from './api/endpoints/by-uri.js';
import { uploadEndpointFile } from './api/endpoints/upload.js';
import { getDomains } from './api/config/domains.js';
import { listEmails, markGroup } from './api/emails/index.js';
import { getEmail, patchEmail } from './api/emails/by-id.js';
import { getRawEml } from './api/emails/raw.js';
import { listRequests } from './api/requests/index.js';
import { getRequest } from './api/requests/by-id.js';
import { listIps, addIp } from './api/blacklist/ips/index.js';
import { deleteIp } from './api/blacklist/ips/by-ip.js';
import { listEmails as listBlacklistEmails, addEmail as addBlacklistEmail } from './api/blacklist/emails/index.js';
import { deleteEmail as deleteBlacklistEmail } from './api/blacklist/emails/by-email.js';

// [method, path, handler]. `:name` is a dynamic segment, delivered to the
// handler in `params.name` still percent-encoded — the handlers decode it
// themselves, exactly as they did under Pages. Grouping is for reading only;
// static-versus-dynamic precedence is handled by the router's structure, not by
// the order of this list.
const ROUTES = [
  ['GET',    '/api/requests',                   listRequests],
  ['GET',    '/api/requests/:id',               getRequest],

  ['GET',    '/api/emails',                     listEmails],
  ['PATCH',  '/api/emails',                     markGroup],
  ['GET',    '/api/emails/:id',                 getEmail],
  ['PATCH',  '/api/emails/:id',                 patchEmail],
  ['GET',    '/api/emails/:id/raw',             getRawEml],

  ['GET',    '/api/endpoints',                  listEndpoints],
  ['POST',   '/api/endpoints',                  upsertEndpoint],
  // Static sibling of /api/endpoints/:uri. It is reached first because static
  // routes live in their own lookup table — see router.js.
  ['POST',   '/api/endpoints/upload',           uploadEndpointFile],
  ['GET',    '/api/endpoints/:uri',             getEndpoint],
  ['DELETE', '/api/endpoints/:uri',             deleteEndpoint],

  ['GET',    '/api/blacklist/ips',              listIps],
  ['POST',   '/api/blacklist/ips',              addIp],
  ['DELETE', '/api/blacklist/ips/:ip',          deleteIp],

  ['GET',    '/api/blacklist/emails',           listBlacklistEmails],
  ['POST',   '/api/blacklist/emails',           addBlacklistEmail],
  ['DELETE', '/api/blacklist/emails/:email',    deleteBlacklistEmail],

  ['GET',    '/api/config/domains',             getDomains],
];

const match = buildRouter(ROUTES);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Only /api/* should ever arrive here (run_worker_first). Anything else
    // means the asset routing was misconfigured, and answering 404 is both
    // honest and cheap — there is no ASSETS binding to fall back to.
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      return errResp('Not found', 404);
    }

    // A single trailing slash is tolerated rather than 404'd. The dashboard
    // never sends one, but `/api/requests/` failing while `/api/requests`
    // works is a confusing thing to debug for no gain.
    const pathname = url.pathname.length > 1 && url.pathname.endsWith('/')
      ? url.pathname.slice(0, -1)
      : url.pathname;

    // HEAD is answered by the GET handler with the body dropped. Nothing in the
    // dashboard sends it; it costs three lines to not be wrong about it.
    const head = request.method === 'HEAD';
    const found = match(head ? 'GET' : request.method, pathname);

    if (!found) return errResp('Not found', 404);
    if (!found.handler) {
      return errResp('Method not allowed', 405, { Allow: found.allow.sort().join(', ') });
    }

    // One try/catch for every handler, replacing the per-handler
    // withErrorHandler() wrapper that each route used to apply for itself. A
    // handler cannot now forget it. Errors are logged and answered as a flat
    // 500: with Workers Logs and source maps enabled in wrangler.toml, the
    // stack is retrievable from the deployment rather than needing to be
    // shipped to the browser.
    let response;
    try {
      response = await found.handler({ request, env, ctx, params: found.params });
    } catch (err) {
      console.error('api_error', request.method, pathname, err && err.message, err && err.stack);
      return errResp('Internal error', 500);
    }

    if (head) return new Response(null, { status: response.status, headers: response.headers });
    return response;
  },
};
