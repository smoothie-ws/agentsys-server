# Public API

The first Web API contract is `1.0` (protocol `1`), independent of application version `0.1.0`. Discovery is `GET /api/meta`. The canonical specification is [api/openapi.json](api/openapi.json), also available at authenticated `GET /api/openapi.json`.

Use explicit bearer headers for remote REST and fetch-based SSE. Discovery reports the exact contract and optional features. Workflow cursors and collection revisions support conditional writes. See [API semantics](api/README.md) for authentication, errors, concurrency and events.

```sh
curl http://127.0.0.1:8080/api/meta
curl -H "Authorization: Bearer $AGENTSYS_TOKEN" http://127.0.0.1:8080/api/projects
```
