'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {loadBackend} = require('../headless');
const {createApiServer} = require('../server/api-server');
const spec = require('../api/openapi.json');
test('published contract covers every runtime method and has no undocumented application routes', async () => {
  const runtime = loadBackend({scripts: 'inline'});
  const implementation = runtime.Backend.openapi();
  const platform = new Set(['/api/meta', '/api/events', '/api/diagnostics', '/api/auth/session', '/api/auth/logout', '/api/auth/plugin-session']);
  for (const [route, methods] of Object.entries(implementation.paths)) {
    assert.ok(spec.paths[route], route);
    assert.deepEqual(Object.keys(spec.paths[route]).sort(), Object.keys(methods).sort(), route);
    for (const operation of Object.values(spec.paths[route])) {
      assert.ok(operation.operationId);
      assert.ok(operation.responses['401'].content['application/json']);
    }
  }
  for (const route of Object.keys(spec.paths)) assert.ok(implementation.paths[route] || platform.has(route), route);
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.version, '2.0');
});
test('the HTTP contract artifact and discovery expose independent API and application versions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-published-'));
  const app = createApiServer({dataDir: dir, token: 'published-contract'});
  try {
    const base = await app.listen(0);
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.version, '0.4.0');
    assert.equal(meta.api_version, '2.0');
    const response = await fetch(base + '/api/openapi.json', {headers: {Authorization: 'Bearer published-contract'}});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), spec);
    assert.equal((await fetch(base + '/index.html')).status, 404);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
