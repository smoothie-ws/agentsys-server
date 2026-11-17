# AgentSys Server

Headless graph platform with workflows, Custom Nodes, collections, secrets, permissions, Script workers, durable storage, HTTP API 1.0 and SSE. Requires Node.js 22+.

## Installation

Requirements: Node.js 22 or 24. No client installation is needed.

```sh
npm install -g ./agentsys-server-0.1.0.tgz
agentsys-server version
agentsys-server start --port 8080 --data ./data
agentsys-server status --url http://127.0.0.1:8080
```

Use `agentsys-server help` for complete flags. A loopback-only installation can
run without a token. For remote access set AGENTSYS_TOKEN and use --host 0.0.0.0.
Add every browser origin explicitly with --allowed-origin https://client.example.
Store data on a persistent writable filesystem. Never expose that directory with
a static web server. Back up while the server is stopped or use tools/backup.js
from the source distribution. Do not run two servers against one data directory.

Source installation needs no npm dependencies: `node bin/agentsys-server.js start`.
Build an npm artifact with `npm pack`. CLI status exits nonzero when unreachable.

Use a new empty directory for the initial store. Its marker is `.agentsys-store.json` with `{"format":"agentsys.store/1"}`. A nonempty unmarked or unsupported directory is refused without changing files. Backups include this marker.

## Architecture

The server is a headless Node.js 22+ service. bin/agentsys-server.js owns process
lifecycle; server/api-server.js owns HTTP, authentication, origin/host validation,
SSE and diagnostics. server/file-store.js owns durable files and locking.
headless.js loads a fixed server/manifest.js list into an isolated VM. runtime/
contains authoritative graph, storage, mutation, permissions and execution code.
Script workers are isolated from Node globals and are terminated on shutdown.

No browser application, plugin host, client package or client filesystem is used.
Only JSON over HTTP and SSE cross the product boundary. Runtime implementation
is owned by this repository. Public data formats and conformance fixtures, not
executable shared packages, coordinate independently released products.

## Deployment

### Docker

```sh
docker build -t agentsys-server:0.1.0 .
docker run --rm -p 8080:8080 -v agentsys-data:/data -e AGENTSYS_TOKEN agentsys-server:0.1.0 start --host 0.0.0.0 --port 8080 --data /data --allowed-origin https://client.example
```

The image contains no GUI. /data must persist across upgrades. Supply the token
through the container environment or deployment secret facility. Terminate TLS
at a reverse proxy or mount certificate files and pass CLI TLS flags.

### systemd

Install the npm package for a dedicated unprivileged service user. Create a mode
0600 /etc/agentsys-server.env containing AGENTSYS_TOKEN. A unit may use:

```ini
[Unit]
Description=AgentSys Server
After=network.target
[Service]
User=agentsys
WorkingDirectory=/var/lib/agentsys
EnvironmentFile=/etc/agentsys-server.env
ExecStart=/usr/local/bin/agentsys-server start --host 0.0.0.0 --port 8080 --data /var/lib/agentsys/data --allowed-origin https://client.example
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
```

Adjust executable paths for your installation. Health: GET /api/meta; operational
diagnostics: authenticated GET /api/diagnostics. Stop gracefully before restoring
data. Test backups before upgrading; versioned release artifacts include the API
contract. Server and client upgrades are independent within API major 2.

Use a new empty directory for the initial store. Its marker is `.agentsys-store.json` with `{"format":"agentsys.store/1"}`. A nonempty unmarked or unsupported directory is refused without changing files. Backups include this marker.

## API

The first Web API contract is `1.0` (protocol `1`), independent of application version `0.1.0`. Discovery is `GET /api/meta`. The canonical specification is [api/openapi.json](api/openapi.json), also available at authenticated `GET /api/openapi.json`.

Use explicit bearer headers for remote REST and fetch-based SSE. Discovery reports the exact contract and optional features. Workflow cursors and collection revisions support conditional writes. See [API semantics](api/README.md) for authentication, errors, concurrency and events.

```sh
curl http://127.0.0.1:8080/api/meta
curl -H "Authorization: Bearer $AGENTSYS_TOKEN" http://127.0.0.1:8080/api/projects
```

## Security

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
