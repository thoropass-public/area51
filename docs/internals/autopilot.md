# Autopilot, the agent interface

`workers/autopilot/src/index.js`, service name from `AGENT_WORKER_NAME`, bound to
`AUTOPILOT_HOSTNAME`. It is a REST API with an MCP server bolted on the side, and
it exists so an AI agent can drive the platform during an engagement without a
human relaying data: read what has been falling into the black holes in the last
hour, and stage response stubs under a reserved path space.

Think of it as **programmatic, bounded access to the black holes**.

## Auth

Every route, REST and MCP alike, requires one operator's API key:

```
Authorization: Bearer <key_id>_<secret>
```

Keys are **per person**, minted and revoked with `./a51 users`, and checked
against the D1 `users` table. There is no shared secret and no Worker Secret:
Autopilot's credentials travel with the database, which is why `./a51 users add`
takes effect immediately and needs no deploy.

The key's two halves are handled deliberately differently:

| Half | Length | Public? | Role |
|---|---|---|---|
| `key_id` | 8 hex | **Yes** | The row lookup, and what the worker logs |
| secret | 64 hex | No | The credential, 256 bits |

- The **lookup uses only `key_id`**, so nothing derived from the credential ever
  reaches the query planner or an index.
- The **comparison uses `sha256` of the whole key string**, in **constant time**
  (`constantTimeEqual`), so response timing leaks nothing — and a tampered
  `key_id` cannot be paired with a valid secret.
- Only the hash is stored. A key is shown once, when minted, and is not
  recoverable; `./a51 users rotate-secret <email>` issues a replacement.

Failure modes are kept distinct on purpose:

| Situation | Status |
|---|---|
| No `Authorization`, malformed key, unknown `key_id`, wrong secret | `401` |
| D1 unreachable, so no key can be checked | `503` |

Reporting the second as `401` would send an operator hunting for a bad key that
isn't bad. On success the worker logs `key_id` and `email` — never the key — so
every call is attributable to a person.

Rotating breaks every agent registered with the old key at once. There is no
grace period and no second accepted value.

## REST routes

| Method | Path | Returns |
|---|---|---|
| `GET` | `/requests` | `{served_at, window_minutes: 60, rows: [{id, ts, method, url, ip}]}`, every request from the last 60 minutes, newest first |
| `GET` | `/emails` | `{served_at, window_minutes: 60, rows: [{id, ts, from_addr, to_addr, subject}]}`, **envelope metadata only, no body** |
| `GET` | `/emails/<id>/raw` | The raw `.eml` (`message/rfc822`) for one message. **Hard 60-minute gate:** served only if `SELECT id FROM emails WHERE id = ? AND ts >= now-60min` matches, so an older or unknown id is a `404` even if the caller knows it. |
| `GET` | `/domains` | `{served_at, endpoint_prefix: "/-/", domains: [{domain, roles}]}`, the same `domains` table the dashboard reads, so an agent can build `https://<domain>/-/<path>` |
| `GET` | `/autopilot/endpoints` | `{rows: [{uri, status, headers, body}]}` for every URI under `/-/`, ascending. A file-backed row also carries `file: {filename, content_type}` and an empty `body`. |
| `POST` | `/autopilot/endpoints` | Upsert. Body `{uri, status, headers, body}`. `uri` **must** start with `/-/`. `400` if it does not, and `400` if the URI is currently file-backed. |
| `GET` | `/autopilot/endpoints/<uri>` | Read one; URI percent-encoded in the path. Same prefix rule. |
| `DELETE` | `/autopilot/endpoints/<uri>` | Delete one. Same prefix rule, same refusal on file-backed URIs. |
| `POST` | `/mcp` | MCP server, JSON-RPC 2.0 over a single HTTP request |

**The read routes take no parameters.** The window (60 minutes) and the row shape
are hardcoded server-side: an agent cannot widen the window, change the shape, or
ask for more rows. The CRUD routes have no time restriction; their guardrail is
the prefix.

Every response sets `Cache-Control: no-store`, and there is no edge cache: an
agent polling during an engagement wants freshness over saved reads
([decisions.md](../decisions.md#no-edge-cache-on-autopilot)).

## The `/-/` guardrail

`AUTOPILOT_PREFIX = '/-/'` is hardcoded. Autopilot cannot read, create, update or
delete an endpoint outside that namespace. A URI that does not start with `/-/`
is rejected with `400` before any query runs. The dashboard, by contrast, has CRUD
over the whole table.

This means a confused or runaway agent can, at worst, scribble over stubs it or
another agent created under `/-/`. It cannot touch a hand-crafted endpoint, the
blacklists, the request log, email state, or the `domains` table.

Second guardrail: **file-backed URIs are refused outright** by upsert and delete.
Autopilot has no `FILES` binding, so replacing such a row would strand the object
and destroy a payload a human staged. The `400` body spells out the dashboard path
to use instead, because that error string is the agent's only feedback at that
moment.

## MCP tools

`POST /mcp` speaks MCP's JSON-RPC 2.0 transport over a single HTTP request (no
SSE, since every tool completes fast). `serverInfo.version` is `1.3.0`.

| Tool | Wraps | Arguments |
|---|---|---|
| `requests_recent_1hr` | `GET /requests` | — |
| `emails_recent_1hr` | `GET /emails` | — |
| `email_raw` | `GET /emails/<id>/raw` | `{id}`, on demand only, not for polling; same 60-minute gate |
| `list_black_holes` | `GET /domains` | returns the domains plus `endpoint_prefix` |
| `autopilot_endpoints_list` | `GET /autopilot/endpoints` | — |
| `autopilot_endpoints_get` | `GET /autopilot/endpoints/<uri>` | `{uri}` |
| `autopilot_endpoints_upsert` | `POST /autopilot/endpoints` | `{uri, status, headers?, body?}` |
| `autopilot_endpoints_delete` | `DELETE /autopilot/endpoints/<uri>` | `{uri}` |

Each tool's description explains *when* to reach for it, and `initialize` returns
an `instructions` preamble: what the black holes are, the `/-/` rule, and how
file-backed endpoints behave. MCP clients read both at connect time, so an agent
whose session was already open needs to reconnect to see changes.

### Why the preamble talks about file hosting

Agents cannot upload files; that stays a human action in the dashboard. But an
agent that only learns *"uploads are refused"* quietly routes around the feature
or stalls. So the preamble leads with the **capability** (the platform can serve
an arbitrary uploaded file from a black hole URL) and then gives the request
protocol: ask the operator for a specific `/-/` path, name the file, point them at
**Endpoints → New endpoint → attach under FILE**, have them confirm the path,
then hand out `https://<domain><path>`.

Three facts are repeated across the preamble and the tool descriptions because
each has its own silent failure mode:

- **An empty `body` next to a `file` object does not mean "returns nothing":**
  the bytes are in object storage. An agent missing this tries to "fix" a working
  endpoint and clobbers a staged payload.
- **Do not base64 a binary into `body`.** The worker serves that column
  verbatim, so the target would receive base64 text. This is the workaround an
  agent reaches for first.
- **Do not ask the operator for anything expressible as text.** HTML, JSON, XML,
  JS, a DTD, an SVG are all `autopilot_endpoints_upsert` with the right
  `Content-Type`. Without this the guidance over-corrects into pestering the
  operator for text stubs.

## Registering with Claude Code

```bash
claude mcp add autopilot https://<autopilot-host>/mcp \
  --transport http \
  --header "Authorization: Bearer <the key ./a51 users printed>"
```

Every session on that machine then has the eight `mcp__autopilot__*` tools as
native tool calls. No curl, no header juggling, no parsing instructions in a
system prompt. The secret lives in the client's own config, not in the
conversation.

`./a51 users add <email>` prints this exact line, filled in, at the moment the
key is minted — the only moment it is readable.

Other MCP clients work the same way: HTTP transport, one custom header.

## Why a separate worker

- **Different domain semantics.** The catcher treats every path on every bound
  domain as a target-facing endpoint. Reserved paths there would pollute that
  namespace and let probes reach them.
- **Different read pattern.** The catcher is write-heavy on the request path;
  Autopilot is read-oriented with narrow writes.
- **Different auth.** Black holes must be wide open. Autopilot is behind a
  per-operator key. Different exposure, different rules.
- **Different blast radius.** A runaway agent is bounded to `/-/*` and to recent
  reads.

Both share the same database binding; no schema change was needed to add it.

## Smoke tests

```bash
# No key is stored anywhere, so paste your own — the one printed when it was
# minted. If it is lost: ./a51 users rotate-secret <your email>
KEY=<key_id>_<secret>
BASE=https://<autopilot-host>

curl -sS -H "Authorization: Bearer $KEY" $BASE/requests | jq .served_at
curl -sS -H "Authorization: Bearer $KEY" $BASE/emails   | jq '.rows | length'
curl -sS -o /dev/null -w '%{http_code}\n' $BASE/requests        # → 401
# An unknown key must also be 401. A 503 here means the worker cannot reach D1
# to check anyone's key — an infrastructure fault, not a bad credential.
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer 00000000_$(printf '0%.0s' {1..64})" $BASE/requests   # → 401

curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' $BASE/mcp | jq .

curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' $BASE/mcp | jq '.result.tools[].name'

curl -sS -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"requests_recent_1hr","arguments":{}}}' \
  $BASE/mcp | jq '.result.content[0].text | fromjson | .rows | length'
```

`./a51 doctor` runs the first three of those automatically.

## Cost

Every call hits D1 directly. Even with an agent polling every 30 seconds against
a busy black hole, expect a few hundred to a few thousand row reads a day,
comfortably inside the free tier, with room for many concurrent engagements.
