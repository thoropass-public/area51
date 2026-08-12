// Minimal Cloudflare REST API v4 client plus the resource helpers AREA 51
// needs. Deliberately dependency-free: `fetch` is built into Node 20+.
//
// Two conventions everywhere in this file:
//
//   * GET-then-act. Every provisioning helper checks current state first and
//     returns { created: false } when the resource already matches, so `./a51
//     setup` is safe to re-run against a live deployment.
//   * Errors carry the Cloudflare error array. `CloudflareError.codes` and
//     `.message` are what the commands match on to tell "already exists" apart
//     from "your token is missing a permission".

// Overridable so the CLI can be pointed at a mock server in tests. Nothing in
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

/** True if the failure is the token lacking a permission (or the wrong token). */
export function isAuthError(err) {
  if (!(err instanceof CloudflareError)) return false;
  if (err.status === 401 || err.status === 403) return true;
  // 9109 unauthorized to access requested resource, 10000 authentication error.
  return err.codes.some((c) => [9109, 10000, 6003, 6111].includes(c));
}

export class Cloudflare {
  constructor(token) {
    if (!token) throw new Error('Cloudflare API token is required');
    this.token = token;
  }

  async request(method, path, body, { raw = false, contentType = 'application/json' } = {}) {
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

    return json ? json.result : null;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
  put(path, body) { return this.request('PUT', path, body); }
  patch(path, body) { return this.request('PATCH', path, body); }
  delete(path, body) { return this.request('DELETE', path, body); }

  // ── identity ───────────────────────────────────────────────────────────────

  /** Verify the token is active. Returns { id, status }. */
  verifyToken() {
    return this.get('/user/tokens/verify');
  }

  listAccounts() {
    return this.get('/accounts?per_page=50');
  }

  /** Zones the token can see, optionally scoped to one account. */
  listZones(accountId) {
    const scope = accountId ? `&account.id=${encodeURIComponent(accountId)}` : '';
    return this.get(`/zones?per_page=50&status=active${scope}`);
  }

  async findZone(accountId, name) {
    const zones = await this.get(`/zones?name=${encodeURIComponent(name)}${accountId ? `&account.id=${encodeURIComponent(accountId)}` : ''}`);
    return (zones || [])[0] || null;
  }

  // ── D1 ─────────────────────────────────────────────────────────────────────

  async findD1Database(accountId, name) {
    const list = await this.get(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=50`);
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
    return this.get(`/accounts/${accountId}/workers/domains${scope}`);
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
    return this.get(`/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}/domains`);
  }

  addPagesDomain(accountId, name, domain) {
    return this.post(`/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}/domains`, { name: domain });
  }

  // ── DNS ────────────────────────────────────────────────────────────────────

  async findDnsRecord(zoneId, name) {
    const list = await this.get(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=50`);
    return (list || [])[0] || null;
  }

  createDnsRecord(zoneId, record) {
    return this.post(`/zones/${zoneId}/dns_records`, record);
  }

  updateDnsRecord(zoneId, recordId, record) {
    return this.put(`/zones/${zoneId}/dns_records/${recordId}`, record);
  }

  // ── Email Routing ──────────────────────────────────────────────────────────

  getEmailRouting(zoneId) {
    return this.get(`/zones/${zoneId}/email/routing`);
  }

  /** Enable Email Routing, adding and locking the required MX + SPF records. */
  enableEmailRouting(zoneId) {
    return this.post(`/zones/${zoneId}/email/routing/enable`, {});
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
    return this.get(`/accounts/${accountId}/email/routing/addresses?per_page=50`);
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
    return this.post(`/accounts/${accountId}/access/organizations`, { name, auth_domain: authDomain });
  }

  listAccessIdentityProviders(accountId) {
    return this.get(`/accounts/${accountId}/access/identity_providers`);
  }

  createOneTimePinProvider(accountId) {
    return this.post(`/accounts/${accountId}/access/identity_providers`, {
      name: 'One-time PIN',
      type: 'onetimepin',
      config: {},
    });
  }

  listAccessApps(accountId) {
    return this.get(`/accounts/${accountId}/access/apps?per_page=50`);
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

  // ── Workers scripts ────────────────────────────────────────────────────────

  /**
   * A deployed Worker's settings — bindings, observability, compatibility. Used
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
