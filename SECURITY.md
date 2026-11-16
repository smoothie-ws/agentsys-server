# Server security

Enforcement belongs to the server. Explicit bearer credentials or authenticated
sessions are required outside the supported loopback trust mode. Origin and Host
validation are separate from authentication. Configure exact client origins;
wildcard origins with credentials are not supported. Cookie writes require CSRF
headers. Cross-site clients use bearer headers and need not accept third-party
cookies. Scoped plugin sessions are bound to identity and declared capabilities.
The server never installs or executes client plugin packages.

Keep AGENTSYS_TOKEN in a service environment file readable only by the service
owner. Public client config must not contain it. Use HTTPS for remote access;
either configure --tls-cert/--tls-key or terminate TLS at a trusted reverse proxy.
Only enable --trust-proxy for a local trusted proxy. Preserve Authorization and
Origin, disable SSE proxy buffering and allow streaming connections.

Use --deny-private-net and --allow-net to constrain Script network access when
appropriate. DNS-pinned requests prevent policy bypass through rebinding. Keep
data and backup paths private. Never expose server source or secrets as static
assets. See tests/security.test.js, script.test.js and plugin-tokens.test.js.
