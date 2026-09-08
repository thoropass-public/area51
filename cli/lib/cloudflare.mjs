// Minimal Cloudflare REST API v4 client plus the resource helpers AREA 51
// needs. Deliberately dependency-free: `fetch` is built into Node 20+.
//
// Three conventions everywhere in this file:
//
//   * GET-then-act. Every provisioning helper checks current state first and
//     returns { created: false } when the resource already matches, so `./a51
//     setup` is safe to re-run against a live deployment.
//   * Errors carry the Cloudflare error array. `CloudflareError.codes` and
//     `.message` are what the commands match on to tell "already exists" apart
//     from "your token is missing a permission".
//   * List endpoints go through `getAll`, never a single capped page. Callers
//     search these results, so a row missing because it fell off page one reads
//     as "does not exist", which is how a capped lookup once made `doctor`
//     report the dashboard unprotected and `ensureAccess` create a second
//     Access app on a hostname that already had one.

// Overridable so the CLI can be pointed at a local mock instead of Cloudflare.
// There is no test suite today; this is the hook one would hang off. Nothing in
// normal operation sets it.
const API_BASE = process.env.A51_API_BASE || 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  constructor(message, { status, errors = [], method, path } = {}) {
    super(message);
    this.name = 'CloudflareError';
    this.status = status;
    this.errors = errors;
    this.codes = errors.map((e) => e.code).filter((c) => c !== undefined);
    this.method = method;
    this.path = path;
  }
}

/** True if the failure is really "this already exists / already done". */
export function isAlreadyExists(err) {
  if (!(err instanceof CloudflareError)) return false;
  return /already (exists|been|enabled|created|in use)|duplicate|is already/i.test(err.message);
}

/**
 * True if Cloudflare refused to create a Custom Domain because the hostname
 * already holds a DNS record it does not manage:
 *
 *   [100117] Hostname 'x.example' already has externally managed DNS records
 *            (A, CNAME, etc). Delete them first or try a different hostname.
 *
 * This is not a permission error and not a transient one, so it must not be
 * treated as either. The name has to be freed before the bind can work. Any
 * address record Cloudflare did not create for this Worker counts, including
 * one that belongs to a Pages project or to another Worker.
 */
export function isHostnameOccupied(err) {
  if (!(err instanceof CloudflareError)) return false;
  if (err.codes.includes(100117)) return true;
  return /externally managed DNS records/i.test(err.message || '');
}

/** True if the failure is the token lacking a permission (or the wrong token). */
export function isAuthError(err) {
  if (!(err instanceof CloudflareError)) return false;
  if (err.status === 401 || err.status === 403) return true;
  // 9109 unauthorized to access requested resource, 10000 authentication error.
  return err.codes.some((c) => [9109, 10000, 6003, 6111].includes(c));
}

/**
 * True if the endpoint rejected the pagination parameters themselves, rather
 * than failing for a real reason. Not every Cloudflare list endpoint is paged.
 * Pages custom domains answers `[8000024] Invalid list options provided` to a
 * `page`/`per_page` query, and those lists are single-page by nature. `getAll`
 * uses this to retry unpaged instead of failing.
 */
function isUnpagedListEndpoint(err) {
  if (!(err instanceof CloudflareError)) return false;
  if (err.codes.includes(8000024)) return true;
  return /invalid list options|per_page|\bpage\b parameter/i.test(err.message || '');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Whether an error is worth retrying rather than surfacing immediately. The
// non-obvious case is auth-shaped failures (403 / 9109 / 10000): a freshly
// created or freshly edited Cloudflare API token takes tens of seconds to
// propagate across the edge, during which calls that will ultimately succeed
// fail as "authentication error". Retrying absorbs the SHORT end of that window
// only. See RETRY_BACKOFFS_MS, which spends about five seconds by default, not
// tens. That is deliberate: a token still propagating after five seconds is
// better served by re-running `./a51 setup` (every step is idempotent) than by
// hanging each of a dozen calls. A genuinely missing permission simply fails
// again after the backoff and surfaces with its real message. Network blips and
// 429/5xx are retried for the usual reasons.
function isRetryableError(err) {
  if (!(err instanceof CloudflareError)) return false;
  if (err.status === undefined) return true;                 // network error (no HTTP response)
  if (err.status === 429 || (err.status >= 500 && err.status <= 599)) return true;
  return isAuthError(err);
}

// Backoff schedule for retried calls, in ms, indexed by attempt number, with
// the last value reused if a caller ever asks for more retries than there are
// entries. At the default of 2 retries only the first two apply, so a call
// spends ~5.5s before giving up; `8000` is reached only if someone passes
// `{ retries: 3 }` or more, which nothing does today. Kept short and shallow on
// purpose: long enough for a brief propagation blip, short enough that a
// genuinely misconfigured token does not turn into a multi-minute hang across a
// dozen provisioning calls.
const RETRY_BACKOFFS_MS = [1500, 4000, 8000];
// Methods safe to retry automatically (idempotent). POSTs opt in per-call via
// `{ retries }` where the operation is effectively idempotent for us (e.g.
// enabling Email Routing, creating the single Zero-Trust org).
const IDEMPOTENT_METHODS = new Set(['GET', 'PUT', 'DELETE', 'HEAD']);
const DEFAULT_RETRIES = 2;

export class Cloudflare {
  constructor(token) {
    if (!token) throw new Error('Cloudflare API token is required');
    this.token = token;
  }

  // Thin retry wrapper around _doRequest. `retries` defaults to a couple of
  // attempts for idempotent methods and zero for others; a caller can override
  // it (e.g. an effectively-idempotent POST passes `{ retries: 2 }`). The retry
  // only fires on transient failures (see isRetryableError). A real permission
  // error still surfaces, just a few seconds later.
  async request(method, path, body, opts = {}) {
    const attempts = Number.isInteger(opts.retries)
      ? opts.retries
      : (IDEMPOTENT_METHODS.has(method) ? DEFAULT_RETRIES : 0);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._doRequest(method, path, body, opts);
      } catch (err) {
        if (attempt < attempts && isRetryableError(err)) {
          await sleep(RETRY_BACKOFFS_MS[Math.min(attempt, RETRY_BACKOFFS_MS.length - 1)]);
          continue;
        }
        throw err;
      }
    }
  }

  async _doRequest(method, path, body, { raw = false, contentType = 'application/json', withInfo = false } = {}) {
    const headers = { Authorization: `Bearer ${this.token}` };
    let payload;
    if (body !== undefined && body !== null) {
      if (contentType === 'application/json') {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      } else {
        headers['Content-Type'] = contentType;
        payload = body;
      }
    }

    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload });
    } catch (err) {
      throw new CloudflareError(`network error talking to the Cloudflare API: ${err.message}`, {
        method,
        path,
      });
    }

    if (raw) {
      if (!res.ok) throw new CloudflareError(`HTTP ${res.status} on ${method} ${path}`, { status: res.status, method, path });
      return res;
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new CloudflareError(
        `unexpected non-JSON response (HTTP ${res.status}) from ${method} ${path}: ${text.slice(0, 200)}`,
        { status: res.status, method, path },
      );
    }

    if (!res.ok || (json && json.success === false)) {
      const errors = (json && json.errors) || [];
      const detail = errors.length
        ? errors.map((e) => `${e.code ? `[${e.code}] ` : ''}${e.message}`).join('; ')
        : `HTTP ${res.status}`;
      throw new CloudflareError(detail, { status: res.status, errors, method, path });
    }

    if (withInfo) return { result: json ? json.result : null, resultInfo: (json && json.result_info) || null };
    return json ? json.result : null;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
  put(path, body) { return this.request('PUT', path, body); }
  patch(path, body) { return this.request('PATCH', path, body); }
  delete(path, body) { return this.request('DELETE', path, body); }

  /**
   * GET every page of a paginated list endpoint and return the concatenated
   * rows. Use this for anything the caller then searches: a single capped page
   * silently drops what it did not fetch, and a *missing* row reads as "this
   * does not exist", which is the dangerous direction. `listAccessApps` is the
   * case that forced this: on an account with more apps than one page, the
   * AREA 51 app fell off the end, `doctor` reported the dashboard unprotected,
   * and `ensureAccess` created a duplicate app because its lookup missed too.
   *
   * Paging stops when Cloudflare says there are no more pages. Endpoints that
   * return no `result_info` (some Zero Trust routes) are treated as
   * single-page, which is exactly the old behavior, so this is never worse
   * than not paging, only sometimes better. `maxPages` is a runaway guard.
   */
  async getAll(path, { perPage = 100, maxPages = 20 } = {}) {
    const sep = path.includes('?') ? '&' : '?';
    const rows = [];
    for (let page = 1; page <= maxPages; page++) {
      let result, resultInfo;
      try {
        ({ result, resultInfo } = await this.request(
          'GET', `${path}${sep}per_page=${perPage}&page=${page}`, undefined, { withInfo: true },
        ));
      } catch (err) {
        // The endpoint does not take paging parameters at all. Fetch it unpaged
        // rather than failing. The whole point of getAll is that it is never
        // worse than a plain GET.
        if (page === 1 && isUnpagedListEndpoint(err)) return (await this.get(path)) || [];
        throw err;
      }
      const batch = result || [];
      rows.push(...batch);
      const totalPages = resultInfo && resultInfo.total_pages;
      if (!totalPages || page >= totalPages || !batch.length) break;
    }
    return rows;
  }

  // ── identity ───────────────────────────────────────────────────────────────

  /** Verify the token is active. Returns { id, status }. */
  verifyToken() {
    return this.get('/user/tokens/verify');
  }

  listAccounts() {
    return this.getAll('/accounts');
  }

  /** Zones the token can see, optionally scoped to one account. */
  listZones(accountId) {
    const scope = accountId ? `&account.id=${encodeURIComponent(accountId)}` : '';
    return this.getAll(`/zones?status=active${scope}`);
  }

  async findZone(accountId, name) {
    const zones = await this.get(`/zones?name=${encodeURIComponent(name)}${accountId ? `&account.id=${encodeURIComponent(accountId)}` : ''}`);
    return (zones || [])[0] || null;
  }

  // ── D1 ─────────────────────────────────────────────────────────────────────

  async findD1Database(accountId, name) {
    const list = await this.getAll(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`);
    return (list || []).find((db) => db.name === name) || null;
  }

  async ensureD1Database(accountId, name) {
    const existing = await this.findD1Database(accountId, name);
    if (existing) return { created: false, database: existing };
    const created = await this.post(`/accounts/${accountId}/d1/database`, { name });
    return { created: true, database: created };
  }

  /** Run one SQL statement (optionally parameterised) against D1. */
  async d1Query(accountId, databaseId, sql, params = []) {
    const result = await this.post(`/accounts/${accountId}/d1/database/${databaseId}/query`, { sql, params });
    return Array.isArray(result) ? result : [result];
  }

  /** Rows from a single-statement SELECT. */
  async d1Rows(accountId, databaseId, sql, params = []) {
    const [first] = await this.d1Query(accountId, databaseId, sql, params);
    return (first && first.results) || [];
  }

  // ── R2 ─────────────────────────────────────────────────────────────────────

  async ensureR2Bucket(accountId, name) {
    try {
      await this.get(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(name)}`);
      return { created: false };
    } catch (err) {
      if (isAuthError(err)) throw err;
    }
    try {
      await this.post(`/accounts/${accountId}/r2/buckets`, { name });
      return { created: true };
    } catch (err) {
      if (isAlreadyExists(err)) return { created: false };
      throw err;
    }
  }

  deleteR2Object(accountId, bucket, key) {
    // Object keys can contain slashes; they must be percent-encoded whole.
    const encoded = encodeURIComponent(key);
    return this.delete(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encoded}`);
  }

  // ── Workers custom domains ─────────────────────────────────────────────────

  listWorkerDomains(accountId, service) {
    const scope = service ? `?service=${encodeURIComponent(service)}&environment=production` : '';
    return this.getAll(`/accounts/${accountId}/workers/domains${scope}`);
  }

  /**
   * Attach a hostname to a Worker as a Custom Domain. Cloudflare provisions the
   * DNS record and the certificate; the call is an upsert, so re-running is
   * harmless. Requires Zone·Workers Routes:Edit on the zone.
   */
  attachWorkerDomain(accountId, { hostname, service, zoneId }) {
    return this.put(`/accounts/${accountId}/workers/domains`, { hostname, service, zone_id: zoneId });
  }

  detachWorkerDomain(accountId, domainId) {
    return this.delete(`/accounts/${accountId}/workers/domains/${domainId}`);
  }

  // ── Pages ──────────────────────────────────────────────────────────────────

  /**
   * Every Pages project on the account. Each one carries its own `domains`
   * array, so working out which project holds a hostname takes this one call
   * instead of a domains lookup per project.
   */
  listPagesProjects(accountId) {
    return this.getAll(`/accounts/${accountId}/pages/projects`);
  }

  async getPagesProject(accountId, name) {
    try {
      return await this.get(`/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  createPagesProject(accountId, body) {
    return this.post(`/accounts/${accountId}/pages/projects`, body);
  }

  patchPagesProject(accountId, name, body) {
    return this.patch(`/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}`, body);
  }

  deletePagesProject(accountId, name) {
    return this.delete(`/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}`);
  }

  listPagesDomains(accountId, name) {
    return this.getAll(`/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}/domains`);
  }

  addPagesDomain(accountId, name, domain) {
    return this.post(`/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}/domains`, { name: domain });
  }

  /**
   * Detach a custom domain from a Pages project. Cloudflare refuses to delete a
   * project while any custom domain is still attached ([8000028]), so `destroy`
   * calls this for every domain before deleting the project.
   */
  deletePagesDomain(accountId, name, domain) {
    return this.delete(`/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}/domains/${encodeURIComponent(domain)}`);
  }

  // ── DNS ────────────────────────────────────────────────────────────────────

  async findDnsRecord(zoneId, name) {
    const list = await this.getAll(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
    return (list || [])[0] || null;
  }

  /** All DNS records of one type on a zone (e.g. 'MX'). Empty array on none. */
  async listDnsRecordsByType(zoneId, type) {
    const list = await this.getAll(`/zones/${zoneId}/dns_records?type=${encodeURIComponent(type)}`);
    return list || [];
  }

  /**
   * Every DNS record at one exact name, of any type. `findDnsRecord` returns
   * only the first match, which is not enough to answer "is anything already
   * sitting here?". At the apex that first match is often the MX record while
   * the address record the black hole would replace sits behind it.
   */
  async listDnsRecordsByName(zoneId, name) {
    const list = await this.getAll(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
    return list || [];
  }

  createDnsRecord(zoneId, record) {
    return this.post(`/zones/${zoneId}/dns_records`, record);
  }

  updateDnsRecord(zoneId, recordId, record) {
    return this.put(`/zones/${zoneId}/dns_records/${recordId}`, record);
  }

  deleteDnsRecord(zoneId, recordId) {
    return this.delete(`/zones/${zoneId}/dns_records/${recordId}`);
  }

  // ── Email Routing ──────────────────────────────────────────────────────────

  getEmailRouting(zoneId) {
    return this.get(`/zones/${zoneId}/email/routing`);
  }

  /**
   * Enable Email Routing, adding and locking the required MX + SPF records.
   * Retried on transient auth failures (token propagation): the call is
   * effectively idempotent, since enabling an already-enabled zone is a no-op
   * that reads as "already enabled".
   */
  enableEmailRouting(zoneId) {
    return this.request('POST', `/zones/${zoneId}/email/routing/enable`, {}, { retries: 2 });
  }

  /**
   * Enable Email Routing for one NAME on the zone, a subdomain such as
   * `listen.example.com`, adding and locking the MX + SPF records for that name.
   *
   * This is a different endpoint from `enableEmailRouting` above: `.../enable`
   * takes no name and only ever addresses the apex, while `.../dns` accepts the
   * name and is what the Cloudflare dashboard calls when you add a subdomain
   * under Email → Email Routing → Settings → Subdomains. Both are authorized by
   * Zone · Zone Settings:Edit.
   *
   * The apex path deliberately still uses `.../enable`: it is the call this tool
   * has always made and it works, so there is no reason to move a working
   * install onto a second endpoint. Retried on transient auth failures for the
   * same token-propagation reason; enabling an already-enabled name reads as
   * "already exists", which callers treat as success.
   */
  enableEmailRoutingForName(zoneId, name) {
    return this.request('POST', `/zones/${zoneId}/email/routing/dns`, { name }, { retries: 2 });
  }

  /**
   * Disable Email Routing on the zone AND delete every routing DNS record it
   * added and locked: MX, SPF and DKIM. One call does both.
   *
   * There is no per-subdomain form, so this clears the apex and every subdomain
   * enabled under it at once. Authorized by Zone · Zone Settings:Edit, the same
   * permission that enables it.
   */
  disableEmailRouting(zoneId) {
    return this.delete(`/zones/${zoneId}/email/routing/dns`);
  }

  getCatchAll(zoneId) {
    return this.get(`/zones/${zoneId}/email/routing/rules/catch_all`);
  }

  /** Point the zone's catch-all rule at a Worker's email() handler. */
  setCatchAllToWorker(zoneId, workerName) {
    return this.put(`/zones/${zoneId}/email/routing/rules/catch_all`, {
      name: 'AREA 51 black hole catch-all',
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [workerName] }],
    });
  }

  listDestinationAddresses(accountId) {
    return this.getAll(`/accounts/${accountId}/email/routing/addresses`);
  }

  createDestinationAddress(accountId, email) {
    return this.post(`/accounts/${accountId}/email/routing/addresses`, { email });
  }

  // ── Cloudflare Access (Zero Trust) ─────────────────────────────────────────

  async getAccessOrganization(accountId) {
    try {
      return await this.get(`/accounts/${accountId}/access/organizations`);
    } catch (err) {
      // No organization yet reads as a 404, or as "access.api.error.not_found".
      if (err.status === 404 || /not.?found/i.test(err.message)) return null;
      throw err;
    }
  }

  createAccessOrganization(accountId, { name, authDomain }) {
    // Retried on transient auth failures (token propagation). There is one
    // organization per account; a second create returns "already exists",
    // which the caller treats as success.
    return this.request(
      'POST',
      `/accounts/${accountId}/access/organizations`,
      { name, auth_domain: authDomain },
      { retries: 2 },
    );
  }

  listAccessIdentityProviders(accountId) {
    return this.getAll(`/accounts/${accountId}/access/identity_providers`);
  }

  createOneTimePinProvider(accountId) {
    return this.post(`/accounts/${accountId}/access/identity_providers`, {
      name: 'One-time PIN',
      type: 'onetimepin',
      config: {},
    });
  }

  listAccessApps(accountId) {
    return this.getAll(`/accounts/${accountId}/access/apps`);
  }

  createAccessApp(accountId, body) {
    return this.post(`/accounts/${accountId}/access/apps`, body);
  }

  updateAccessApp(accountId, appId, body) {
    return this.put(`/accounts/${accountId}/access/apps/${appId}`, body);
  }

  deleteAccessApp(accountId, appId) {
    return this.delete(`/accounts/${accountId}/access/apps/${appId}`);
  }

  // ── Zero Trust lists (the operator allow-list) ─────────────────────────────
  //
  // The Access policy that guards the dashboard points at a list of email
  // addresses rather than inlining them, and this is that list. Note the path:
  // lists live under `/gateway/`, NOT under `/access/`, which is why they need
  // `Account · Zero Trust:Edit` and are not covered by `Access: Apps and
  // Policies:Edit`. That split is the single most confusing thing about this
  // resource: a token that can rewrite the whole application still cannot add
  // one address to the list its policy depends on.
  //
  // D1's `users` table is the source of truth; this list is a projection of it,
  // rewritten wholesale by `./a51 users`. Nothing here is ever edited in place.

  listZeroTrustLists(accountId) {
    return this.getAll(`/accounts/${accountId}/gateway/lists`);
  }

  getZeroTrustList(accountId, listId) {
    return this.get(`/accounts/${accountId}/gateway/lists/${listId}`);
  }

  /** The list's entries, which the list object itself does not include. */
  getZeroTrustListItems(accountId, listId) {
    return this.getAll(`/accounts/${accountId}/gateway/lists/${listId}/items`, { perPage: 1000 });
  }

  createZeroTrustList(accountId, { name, description = '', items = [] }) {
    return this.post(`/accounts/${accountId}/gateway/lists`, {
      name,
      description,
      type: 'EMAIL',
      items: items.map((value) => ({ value })),
    });
  }

  /**
   * Replace a list's contents wholesale.
   *
   * PUT is deliberate: it is a full replace, so whatever the list held before,
   * including anything edited by hand in the Cloudflare dashboard, is gone
   * afterwards. That is what makes D1 authoritative in practice rather than
   * only on paper. (PATCH on this resource appends and removes deltas; using it
   * would let manual edits survive, so it is not used anywhere.)
   */
  updateZeroTrustList(accountId, listId, { name, description = '', items = [] }) {
    return this.put(`/accounts/${accountId}/gateway/lists/${listId}`, {
      name,
      description,
      items: items.map((value) => ({ value })),
    });
  }

  deleteZeroTrustList(accountId, listId) {
    return this.delete(`/accounts/${accountId}/gateway/lists/${listId}`);
  }

  // ── Workers scripts ────────────────────────────────────────────────────────

  /**
   * A deployed Worker's settings: bindings, observability, compatibility. Used
   * as an existence check (404 when the script was never deployed) and to verify
   * that the bindings a Worker needs actually reached it.
   */
  async getWorkerSettings(accountId, name) {
    try {
      return await this.get(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/settings`);
    } catch (err) {
      if (err.status === 404 || /not.?found|could not find/i.test(err.message)) return null;
      throw err;
    }
  }

  deleteWorkerScript(accountId, name) {
    return this.delete(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}?force=true`);
  }
}
