# AgentSys Server

Headless graph platform with workflows, Custom Nodes, collections, secrets, permissions, Script workers, durable storage, public HTTP API and SSE. Initial release `0.1.0`; Web API `1.0` (protocol `1`).

```sh
npm test
node bin/agentsys-server.js start --port 8080 --data ./data
```

Requires Node.js 22+. The server runs independently of the browser Client. Use a new empty writable data directory. Startup marks it with `.agentsys-store.json` (`agentsys.store/1`) and refuses nonempty unmarked or unsupported directories before writes.

See [installation](INSTALLATION.md), [architecture](ARCHITECTURE.md), [deployment](DEPLOYMENT.md), [API](API.md) and [security](SECURITY.md).
