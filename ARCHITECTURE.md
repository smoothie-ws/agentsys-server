# Server architecture

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
