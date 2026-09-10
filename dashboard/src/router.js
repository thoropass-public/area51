// The dashboard's API router.
//
// On Cloudflare Pages this file did not exist: Pages Functions derived the whole
// route table from the shape of the `functions/` directory, with `[id]` naming a
// dynamic segment and the export name (`onRequestGet`) naming the method.
// Workers has no such convention — a Worker is one `fetch` handler — so the
// table that used to be implicit in the filesystem is written down here.
//
// Two things about the way it is written down are deliberate.
//
// **A literal path shadows a parameter route, whatever the method.**
// `/api/endpoints/upload` matches both the literal `upload` route and the
// `:uri` route, and Pages resolved that by preferring the more specific match.
// A single ordered list of patterns would re-create that hazard as a sorting
// convention nobody can see: append a route in the wrong place and
// `GET /api/endpoints/upload` starts doing a D1 lookup for an endpoint literally
// named "upload". So the literal paths are held in their own table and settled
// FIRST — including the case where the path is declared but the method is not,
// which answers 405 rather than falling through to `:uri`. Position within
// ROUTES cannot affect any of this.
//
// **Matching is done on the raw pathname, by segment.** No URLPattern, no regex.
// Endpoint URIs reach this API percent-encoded in a path segment — the dashboard
// sends `encodeURIComponent('/-/callback')`, so the request path is
// `/api/endpoints/%2F-%2Fcallback`. `url.pathname` preserves that encoding
// verbatim, and splitting on `/` therefore yields exactly one segment for the
// parameter, which the handler decodes itself. URLPattern canonicalizes the
// pathname it matches against, which would risk turning that `%2F` back into a
// separator and splitting one parameter across two segments. Splitting the raw
// string cannot do that, and is less code besides.

/** @typedef {{ request: Request, env: any, ctx: any, params: Record<string,string> }} Ctx */

/**
 * Compile a `[method, path, handler]` list into a matcher.
 *
 * `:name` marks a dynamic segment, captured into `params.name` still
 * percent-encoded, exactly as Pages delivered it. Order within `routes` is
 * irrelevant to correctness; it is grouped by resource for readability only.
 */
export function buildRouter(routes) {
  /** Literal path → method → handler. Consulted before any parameter route. */
  const literal = new Map();
  /** Parameter routes, pre-split so a match is one equality check per segment. */
  const dynamic = [];

  for (const [method, path, handler] of routes) {
    if (!path.includes(':')) {
      if (!literal.has(path)) literal.set(path, new Map());
      literal.get(path).set(method, handler);
      continue;
    }
    const segments = path.split('/').slice(1);
    dynamic.push({
      method,
      segments,
      // Positions of the dynamic segments, resolved once here so the hot path
      // does no string inspection beyond a per-segment equality check.
      params: segments.flatMap((s, i) => (s.startsWith(':') ? [[i, s.slice(1)]] : [])),
      handler,
    });
  }

  /** Does this request path have the same shape as this parameter route? */
  function shapeMatches(route, segments) {
    if (route.segments.length !== segments.length) return false;
    for (let i = 0; i < route.segments.length; i++) {
      const pattern = route.segments[i];
      if (pattern.startsWith(':')) {
        // A parameter must actually capture something. Without this,
        // `/api/emails/` would match `/api/emails/:id` with an empty id and hand
        // the handler a query for the row whose id is ''.
        if (segments[i] === '') return false;
        continue;
      }
      if (pattern !== segments[i]) return false;
    }
    return true;
  }

  /**
   * Resolve a request to a handler.
   *
   * Returns `{ handler, params }` on a hit; `{ allow }` when the path exists but
   * does not serve this method, so the caller can answer 405 with a correct
   * `Allow` header (which Pages used to derive for us); or null when nothing
   * matches at all.
   */
  return function match(method, pathname) {
    // 1. Literal paths, first and last word on the paths they cover. A declared
    //    literal path that does not serve this method is a 405 — it must not
    //    fall through to a parameter route that happens to have the same shape.
    const byMethod = literal.get(pathname);
    if (byMethod) {
      const handler = byMethod.get(method);
      return handler ? { handler, params: {} } : { allow: [...byMethod.keys()] };
    }

    // 2. Parameter routes.
    const segments = pathname.split('/').slice(1);
    const shaped = dynamic.filter((r) => shapeMatches(r, segments));
    if (!shaped.length) return null;

    const hit = shaped.find((r) => r.method === method);
    if (!hit) return { allow: [...new Set(shaped.map((r) => r.method))] };

    const params = {};
    for (const [i, name] of hit.params) params[name] = segments[i];
    return { handler: hit.handler, params };
  };
}
