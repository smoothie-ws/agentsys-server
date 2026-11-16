# Public API

API version 2.0 is independent of server version 0.4.1 and client releases.
Discovery: GET /api/meta. Canonical specification: api/openapi.json, also served
by authenticated GET /api/openapi.json. Authentication, errors, concurrency,
idempotency and SSE semantics are defined in [api/README.md](api/README.md).

Use an explicit Authorization: Bearer header for remote REST and fetch-based SSE.
Never infer compatibility from the application version. Compare the API major;
use feature discovery for optional capabilities. Unknown optional response fields
must not break clients. Conditional writes use If-Match where documented.

```sh
curl http://127.0.0.1:8080/api/meta
curl -H "Authorization: Bearer $AGENTSYS_TOKEN" http://127.0.0.1:8080/api/projects
```
