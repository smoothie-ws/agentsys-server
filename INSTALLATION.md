# Installation

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
