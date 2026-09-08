// Minimal AWS SigV4 signer + R2 (S3-compatible) object listing.
//
// Used ONLY by `./a51 destroy` to enumerate the objects in an R2 bucket so the
// bucket can be emptied and deleted with no manual dashboard step. Cloudflare's
// v4 REST API exposes single-object GET/PUT/DELETE but no reliable object LIST,
// so listing goes through R2's S3-compatible API. Deletion still uses the v4
// object API (cloudflare.mjs `deleteR2Object`); only the list is S3 here.
//
// The S3 API needs S3-style credentials, but Cloudflare derives those directly
// from any account API token, and there is NO separate R2 token to create by hand:
//   Access Key ID     = the API token's id      (GET /user/tokens/verify → id)
//   Secret Access Key = SHA-256 hex of the token value
// (https://developers.cloudflare.com/r2/api/tokens/). So the same
// CLOUDFLARE_API_TOKEN that provisions everything can also empty a bucket.

import { createHash, createHmac } from 'node:crypto';

// sha256(""), the payload hash for every request here (list is a GET, no body).
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256hex = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (key, d) => createHmac('sha256', key).update(d).digest();

// RFC 3986 encoding. encodeURIComponent leaves ! * ' ( ) alone; SigV4 requires
// them percent-encoded, and the URL we send must match the signed form byte for
// byte, so both the canonical request and the request URL use this.
function enc(s) {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Canonical query string: keys sorted, key and value RFC-3986 encoded. Shared by
// the signer and the URL builder so they can never drift.
function canonicalQueryString(query) {
  return Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
}

// Compute the SigV4 `Authorization` header value. `headers` keys must be
// lowercase and must include host, x-amz-date and x-amz-content-sha256; every
// header passed is signed. Exported so it can be unit-checked against the AWS
// SigV4 test-suite vectors.
export function sigV4Authorization({
  method, canonicalUri, query, headers, payloadHash,
  service, region, accessKeyId, secretAccessKey,
}) {
  const amzDate = headers['x-amz-date'];
  const dateStamp = amzDate.slice(0, 8);

  const headerKeys = Object.keys(headers).sort();
  const canonicalHeaders = headerKeys.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
  const signedHeaders = headerKeys.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** Derive R2 S3 credentials from the account API token the CLI already holds. */
export async function deriveR2Credentials(cf) {
  const info = await cf.verifyToken();
  if (!info || !info.id) {
    throw new Error('could not read the API token id (needed to derive R2 S3 credentials)');
  }
  return { accessKeyId: info.id, secretAccessKey: sha256hex(cf.token) };
}

function xmlDecode(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// A UTC timestamp in SigV4's basic format: YYYYMMDDTHHMMSSZ.
function amzNow() {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Return every object key in an R2 bucket, following ListObjectsV2 pagination.
 * Throws on a non-2xx S3 response (the caller degrades to a manual-empty hint).
 * `fetchImpl` is injectable for tests; defaults to global fetch.
 */
export async function listR2ObjectKeys(accountId, bucket, creds, { fetchImpl = fetch } = {}) {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${enc(bucket)}`;
  const keys = [];
  let continuation;

  for (;;) {
    const query = { 'list-type': '2', 'max-keys': '1000' };
    if (continuation) query['continuation-token'] = continuation;

    const amzDate = amzNow();
    const headers = { host, 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': amzDate };
    const authorization = sigV4Authorization({
      method: 'GET', canonicalUri, query, headers, payloadHash: EMPTY_SHA256,
      service: 's3', region: 'auto', ...creds,
    });

    const url = `https://${host}${canonicalUri}?${canonicalQueryString(query)}`;
    const res = await fetchImpl(url, { method: 'GET', headers: { ...headers, Authorization: authorization } });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`R2 S3 list failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
    }

    for (const m of body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(xmlDecode(m[1]));

    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(body);
    const tok = body.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
    if (truncated && tok) { continuation = xmlDecode(tok[1]); continue; }
    break;
  }
  return keys;
}
