import { json, withErrorHandler } from '../_shared.js';

// Returns the configured AREA 51 domain list to the frontend. The source of
// truth is a Cloudflare Pages environment variable named `DOMAINS_CONFIG`,
// whose value is a JSON-stringified array of `{domain, roles}` entries
// (roles is a subset of ["http", "mail"]).
//
// Edits go through the Cloudflare dashboard (Pages → area51 → Settings →
// Variables and Secrets → DOMAINS_CONFIG) so no redeploy is needed to add or
// remove a domain — the next page load picks up the new value.
//
// The handler is defensive against missing / malformed env vars: it never
// throws, just returns an empty list. The frontend renders that as "alien
// with no chips" without breaking the rest of the page.

async function getDomains({ env }) {
  const raw = (env && env.DOMAINS_CONFIG) || '';
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }

  if (!Array.isArray(parsed)) return json({ domains: [] });

  const ALLOWED_ROLES = new Set(['http', 'mail']);
  const domains = parsed
    .filter((d) => d && typeof d.domain === 'string' && d.domain.length > 0 && Array.isArray(d.roles))
    .map((d) => ({
      domain: d.domain.trim(),
      roles: d.roles.filter((r) => typeof r === 'string' && ALLOWED_ROLES.has(r.toLowerCase()))
                    .map((r) => r.toLowerCase()),
    }))
    .filter((d) => d.domain.length > 0);

  return json({ domains });
}

export const onRequestGet = withErrorHandler(getDomains);
