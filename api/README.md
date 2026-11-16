# Public Web API 2.0

Canonical specification: openapi.json. JSON schemas use draft 2020-12.
The /api prefix is stable; /api/meta advertises api_version. Major denotes breaking
changes; minor denotes compatible additions. Application versions are independent.
The integer protocol field and x-agentsys-protocol header carry the API major.
Clients negotiate the major and discover optional features from meta.features.

Authentication: use Authorization: Bearer for cross-origin REST and fetch-based
SSE. POST /api/auth/session exchanges the initial token for an HttpOnly cookie;
repeat the exchange to renew. Logout revokes the cookie session. Plugin sessions
are short-lived bearer tokens bound to plugin identity and capabilities. Their
expiration is returned on issuance. 401 means expired/invalid credentials, 403
means origin or capability refusal. Cookies require X-AgentSys on writes; bearer
authentication does not depend on third-party cookies. Exact origin allowlists
apply to browsers. Never put server credentials in static config or a build.

SSE GET /api/events sends data JSON with type ready, change (keys and by), or hook
(entry). Comment heartbeats occur every 20 seconds. Events are live and ordered
within a connection, have no durable IDs and no replay guarantee. On disconnect,
reconnect with bounded backoff and reload resources; do not replay mutations.
Event authentication uses the same bearer header as REST. Expired sessions require
renewal before reconnecting. A client disconnect does not cancel execution.

Workflow cursors and collection record versions support conditional writes.
If-Match supplies a cursor/version; if_cursor and if_version are the corresponding
query parameters. A stale condition returns 409 without applying the mutation.
No global idempotency-key facility is provided: never automatically retry a
mutation after an ambiguous network failure. Execution stop/cancellation uses
the documented execution endpoints. Aborting HTTP is not execution cancellation.

Errors have {error:{code,message}}; clients must not inspect server exceptions.
The specification is a versioned release artifact owned by the server. Route
parity tests compare it against the running implementation to detect drift.
