import { errResp } from '../shared.js';

// Streams the verbatim raw .eml for an email from R2. Same-origin only. It is
// fetched when the email modal opens (there is no "More" step; the modal has one
// body source) and again by its "Download Raw" button.
// 404 if there's no object (fallback rows, purged, or never stored).
export async function getRawEml({ params, env }) {
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
