import { json } from '../shared.js';

// Returns the configured black hole list to the frontend (Home orbit chips).
// Source of truth is the D1 `domains` table, shared with the Autopilot worker so
// the agent sees the same set. Each row is {domain} and nothing more: a black
// hole is a whole Cloudflare zone, serving HTTP on every path and capturing mail
// at every address, so there is nothing to report per host beyond its name. The
// `roles` column this used to project is gone; see
// docs/decisions.md#a-black-hole-is-a-whole-zone-and-has-no-roles.
//
// Manage the list with `./a51 black-holes add|remove|list`, which also does the
// Cloudflare side. Writing a row by hand only adds a label.
//
// Defensive: never throws; returns an empty list on any error or malformed row,
// which the frontend renders as "alien with no chips." That also covers the few
// seconds during an upgrade when this code is live against a schema it has not
// caught up with.
export async function getDomains({ env }) {
  let rows;
  try {
    const res = await env.DB.prepare('SELECT domain FROM domains ORDER BY domain ASC').all();
    rows = res.results || [];
  } catch {
    return json({ domains: [] });
  }

  const domains = rows
    .map((r) => ({ domain: typeof r.domain === 'string' ? r.domain.trim() : '' }))
    .filter((d) => d.domain.length > 0);

  return json({ domains });
}
