import { json, withErrorHandler } from '../_shared.js';

// Returns the configured black hole domain list to the frontend (Home orbit
// chips). Source of truth is the D1 `domains` table, shared with the
// Autopilot worker so the agent sees the same set. Each row is
// {domain, roles} where roles is a JSON array, subset of ["http", "mail"].
//
// Edit the list with `wrangler d1 execute` against the `domains` table.
//
// Defensive: never throws; returns an empty list on any error or malformed
// row, which the frontend renders as "alien with no chips."
async function getDomains({ env }) {
  let rows;
  try {
    const res = await env.DB.prepare('SELECT domain, roles FROM domains ORDER BY domain ASC').all();
    rows = res.results || [];
  } catch {
    return json({ domains: [] });
  }

  const ALLOWED_ROLES = new Set(['http', 'mail']);
  const domains = rows
    .map((r) => {
      let roles = [];
      try { roles = JSON.parse(r.roles); } catch { roles = []; }
      if (!Array.isArray(roles)) roles = [];
      return {
        domain: typeof r.domain === 'string' ? r.domain.trim() : '',
        roles: roles
          .filter((x) => typeof x === 'string' && ALLOWED_ROLES.has(x.toLowerCase()))
          .map((x) => x.toLowerCase()),
      };
    })
    .filter((d) => d.domain.length > 0);

  return json({ domains });
}

export const onRequestGet = withErrorHandler(getDomains);
