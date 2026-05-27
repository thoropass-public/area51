import { errResp, withErrorHandler } from '../../_shared.js';

// Streams the verbatim raw .eml for an email from R2. Same-origin only —
// consumed by the email modal's "More" action and "Download Raw" button.
// 404 if there's no object (fallback rows, purged, or never stored).
async function getRawEml({ params, env }) {
  const obj = await env.EML.get(`emails/${params.id}.eml`);
  if (!obj) return errResp('Not found', 404);
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'message/rfc822',
      'Content-Disposition': `attachment; filename="${params.id}.eml"`,
      'Cache-Control': 'no-store',
    },
  });
}

export const onRequestGet = withErrorHandler(getRawEml);
