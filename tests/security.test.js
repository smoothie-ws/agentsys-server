'use strict';
const {describe} = require('node:test');

describe("network-policy", () => {
// The network boundary, exercised against real local HTTP servers: host allowlists, redirects, response size,
// timeout and abort, secret placement and a project's own egress policy.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http');
const {createApiServer} = require('../server/api-server');
const {createApp, nodes} = require('./harness');
const {pinnedRequest} = require('../headless');

const TOKEN = 'net-policy-token';
const headers = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};

const listen = server =>
  new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

function localServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/ok') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: true}));
      return;
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, {Location: '/ok'});
      res.end();
      return;
    }
    if (url.pathname === '/big') {
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end('x'.repeat(2500000));
      return;
    }
    if (url.pathname === '/slow') return; // never answers
    if (url.pathname === '/echo') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({authorization: req.headers.authorization || '', body}));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return server;
}

async function withApi(options, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-net-policy-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  const base = await app.listen(0);
  try {
    await work({app, base, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const net = (base, body) =>
  fetch(base + '/api/net', {method: 'POST', headers, body: JSON.stringify(body)});

async function until(check, what, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('not reached: ' + what);
}

test('a local request succeeds, a redirect is refused, and the response is returned', async () => {
  const target = localServer();
  const url = await listen(target);
  try {
    await withApi({allowedNetHosts: [url.replace('http://', '')]}, async ({base}) => {
      const ok = await net(base, {url: url + '/ok'});
      assert.equal(ok.status, 200, await ok.clone().text());
      assert.deepEqual(await ok.json(), {status: 200, text: '{"ok":true}'});

      const redirect = await net(base, {url: url + '/redirect'});
      assert.equal(redirect.status, 403);
      assert.match((await redirect.json()).error.message, /Redirects require/);
    });
  } finally {
    await new Promise(resolve => target.close(resolve));
  }
});

test('a response over the limit is refused without buffering it all', async () => {
  const target = localServer();
  const url = await listen(target);
  try {
    await withApi({}, async ({base}) => {
      const response = await net(base, {url: url + '/big'});
      assert.equal(response.status, 400);
      assert.match((await response.json()).error.message, /too large/);
    });
  } finally {
    await new Promise(resolve => target.close(resolve));
  }
});

test('refusing headers also closes an unfinished redirect or oversized response body', async () => {
  let closed = 0;
  const target = http.createServer((req, res) => {
    res.on('close', () => closed++);
    res.writeHead(req.url === '/redirect' ? 302 : 200, req.url === '/redirect'
      ? {Location: '/elsewhere'} : {'Content-Length': '3000000'});
    res.write('unfinished'); // Deliberately keep the response open after fetch has received its headers.
  });
  const url = await listen(target);
  try {
    await withApi({}, async ({base}) => {
      assert.equal((await net(base, {url: url + '/redirect'})).status, 403);
      assert.equal((await net(base, {url: url + '/oversized'})).status, 400);
      const deadline = Date.now() + 2000;
      while (closed < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(closed, 2, 'both refused upstream responses were released before shutting down the API');
    });
  } finally {
    target.closeAllConnections();
    await new Promise(resolve => target.close(resolve));
  }
});

test('a timeout and an abort both end the request', async () => {
  const target = localServer();
  const url = await listen(target);
  try {
    await withApi({}, async ({base}) => {
      const timed = await net(base, {url: url + '/slow', timeout: 250});
      assert.equal(timed.status, 504);
      assert.match((await timed.json()).error.message, /timed out/);
      const invalid = await net(base, {url: url + '/ok', timeout: 0});
      assert.equal(invalid.status, 400);
    });
  } finally {
    await new Promise(resolve => target.close(resolve));
  }
});

test('a secret in a header is sent and its reflection is redacted; a secret in the URL is refused', async () => {
  const target = localServer();
  const url = await listen(target);
  try {
    await withApi({}, async ({base, app}) => {
      await app.api.request('PUT', 'secrets/net-key', {body: {value: 'super-secret-value'}, query: {}});
      const echoed = await net(base, {
        url: url + '/echo',
        method: 'POST',
        headers: {Authorization: 'Bearer {{secret:net-key}}'},
        body: 'hello',
      });
      assert.equal(echoed.status, 200);
      const text = await echoed.text();
      assert.doesNotMatch(text, /super-secret-value/);
      assert.match(text, /\[REDACTED\]/);
      assert.match(text, /hello/);

      const denied = await net(base, {url: url + '/ok?key={{secret:net-key}}'});
      assert.equal(denied.status, 400);
      assert.match((await denied.json()).error.message, /secret placeholder/);
    });
  } finally {
    await new Promise(resolve => target.close(resolve));
  }
});

test('a private-destination policy refuses loopback even when the host is allowlisted', async () => {
  const target = localServer();
  const url = await listen(target);
  const authority = url.replace('http://', '');
  try {
    await withApi({allowedNetHosts: [authority], blockPrivateNet: true}, async ({base}) => {
      const denied = await net(base, {url: url + '/ok'});
      assert.equal(denied.status, 403);
      assert.match((await denied.json()).error.message, /private, loopback or link-local/);
    });
    // The same server without the policy reaches the local endpoint.
    await withApi({allowedNetHosts: [authority]}, async ({base}) => {
      assert.equal((await net(base, {url: url + '/ok'})).status, 200);
    });
  } finally {
    await new Promise(resolve => target.close(resolve));
  }
});

test('a project policy narrows egress for its Scripts, independently of the server list', async () => {
  const allowedServer = localServer(),
    deniedServer = localServer();
  const allowed = await listen(allowedServer),
    denied = await listen(deniedServer);
  const app = createApp({scripts: 'inline'});
  try {
    const {id} = await app.api('POST', 'projects', {name: 'Egress project'});
    await app.api('PUT', `projects/${id}/policy`, {
      allow: ['graph.read', 'net.fetch:*'],
      net: {allow: [allowed.replace('http://', '')]},
    });
    const script = await app.api('POST', `projects/${id}/typed-nodes`, {
      workflow_id: id,
      node_type: 'custom',
      config: nodes.script(`
        const ok = await agentsys('POST', 'net', {url: '${allowed}/ok'});
        let refused = '';
        try { await agentsys('POST', 'net', {url: '${denied}/ok'}); }
        catch (error) { refused = error.message; }
        node.display('allowed:' + ok.status + ' ' + refused);`),
    });
    const run = await app.api('POST', `projects/${id}/execution`, {workflow_id: id, node_ids: [script.id], wait: true});
    const shown = Object.values(run.displays || {}).join(' ');
    assert.match(shown, /allowed:200/);
    assert.match(shown, /does not fetch/);
  } finally {
    await app.Backend.shutdownExecutions();
    await new Promise(resolve => allowedServer.close(resolve));
    await new Promise(resolve => deniedServer.close(resolve));
  }
});

test('a project deny_private policy refuses loopback and policy validation is strict', async () => {
  const target = localServer();
  const url = await listen(target);
  const app = createApp({scripts: 'inline'});
  try {
    const {id} = await app.api('POST', 'projects', {name: 'Private egress'});
    await app.api('PUT', `projects/${id}/policy`, {
      allow: ['graph.read', 'net.fetch:*'],
      net: {allow: [url.replace('http://', '')], deny_private: true},
    });
    const script = await app.api('POST', `projects/${id}/typed-nodes`, {
      workflow_id: id,
      node_type: 'custom',
      config: nodes.script(`
        try { await agentsys('POST', 'net', {url: '${url}/ok'}); node.display('reached'); }
        catch (error) { node.display(error.message); }`),
    });
    const run = await app.api('POST', `projects/${id}/execution`, {workflow_id: id, node_ids: [script.id], wait: true});
    assert.match(Object.values(run.displays || {}).join(' '), /private, loopback or link-local/);

    await assert.rejects(
      app.api('PUT', `projects/${id}/policy`, {allow: ['graph.read'], net: {allow: 'not-a-list'}}),
      /net\.allow/
    );
    await assert.rejects(
      app.api('PUT', `projects/${id}/policy`, {allow: ['graph.read'], net: {deny_private: 'yes'}}),
      /deny_private/
    );
    const kept = await app.api('GET', `projects/${id}/policy`);
    assert.deepEqual(kept.net, {allow: [url.replace('http://', '')], deny_private: true});
  } finally {
    await app.Backend.shutdownExecutions();
    await new Promise(resolve => target.close(resolve));
  }
});

test('IPv6 loopback is matched as an authority, including the brackets around it', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('ipv6');
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', resolve);
    });
  } catch (error) {
    // A host without IPv6 is a legitimate environment, not a test failure.
    server.close();
    return;
  }
  const port = server.address().port;
  try {
    await withApi({allowedNetHosts: [`[::1]:${port}`]}, async ({base}) => {
      const response = await net(base, {url: `http://[::1]:${port}/`});
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).text, 'ipv6');
      const other = await net(base, {url: `http://[::1]:${port + 1}/`});
      assert.equal(other.status, 403);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Stop aborts a Script waiting on a slow network request', async () => {
  const target = localServer();
  const url = await listen(target);
  const app = createApp({scripts: 'worker', allowedNetHosts: [url.replace('http://', '')]});
  try {
    const project = await app.api('POST', 'projects', {name: 'Abort egress'});
    const query = {workflow_id: project.id};
    const script = await app.api('POST', `projects/${project.id}/primitives`, {
      ...query,
      primitive: 'script',
      point: {x: 0, y: 0},
    });
    await app.api('PUT', `projects/${project.id}/input-values`, {
      ...query,
      node_id: script.id,
      values: {script: `await agentsys('POST', 'net', {url: '${url}/slow', timeout: 60000}); node.display('finished');`},
    });
    await app.api('PUT', `projects/${project.id}/node-permissions/${script.id}`, {
      ...query,
      grants: ['graph.read', 'net.fetch:*'],
    });
    const started = Date.now();
    await app.api('POST', `projects/${project.id}/execution`, {...query, node_ids: [script.id]});
    await until(async () => (await app.api('GET', `projects/${project.id}/execution`, {}, query)).nodes.some(node => node.status === 'running'), 'request started');
    const stopped = await app.api('DELETE', `projects/${project.id}/execution`, {}, query);
    assert.equal(stopped.status, 'idle');
    assert.ok(Date.now() - started < 5000, 'Stop did not wait for the network timeout');
    const detail = await app.api('GET', `projects/${project.id}/execution`, {}, query);
    assert.equal(detail.displays[script.id], undefined);
    assert.equal(detail.state.finished, undefined);
    await until(() => app.workerStats.started - app.workerStats.exited === 0, 'the worker exited');
  } finally {
    await app.Backend.shutdownExecutions();
    await new Promise(resolve => target.close(resolve));
  }
});

test('the pinned transport connects to the checked address instead of resolving the name again', async () => {
  const target = localServer();
  const url = await listen(target);
  const port = new URL(url).port;
  try {
    // `rebind.invalid` does not exist in DNS. The request can only succeed because it is pinned to 127.0.0.1.
    const response = await pinnedRequest({
      url: `http://rebind.invalid:${port}/ok`,
      address: '127.0.0.1',
      timeout: 3000,
    });
    assert.equal(response.status, 200);
    assert.equal(response.text, '{"ok":true}');
    const redirect = await pinnedRequest({
      url: `http://rebind.invalid:${port}/redirect`,
      address: '127.0.0.1',
      timeout: 3000,
    });
    assert.equal(redirect.status, 302, 'the pinned transport does not follow redirects');
  } finally {
    await new Promise(resolve => target.close(resolve));
  }
});

test('host normalization is lower-case, trailing-dot tolerant and fails closed on a lookalike', async () => {
  await withApi({allowedNetHosts: ['127.0.0.1.:1']}, async ({base}) => {
    // Both sides lose the root dot; there is no listener on port 1, so this is a network error, not a 403.
    const normalized = await net(base, {url: 'http://127.0.0.1:1/'});
    assert.notEqual(normalized.status, 403, await normalized.clone().text());
    const lookalike = await net(base, {url: 'http://127.0.0.1.evil.invalid:1/'});
    assert.equal(lookalike.status, 403);
  });
});
});

describe("plugin-tokens", () => {
// Scoped tokens for client plugins: the host exchanges its own credential for a short-lived token limited to the
// capabilities a package declared, and the SERVER enforces them on every call. This is the boundary that does not
// depend on the host page being honest.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');

const TOKEN = 'owner-token-123';
const OWNER = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};

async function withServer(options, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-plugin-token-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  const base = await app.listen(0);
  try {
    await work({app, base, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const mint = async (base, capabilities, headers = OWNER, pluginId) => {
  const response = await fetch(base + '/api/auth/plugin-session', {
    method: 'POST',
    headers,
    body: JSON.stringify({capabilities, plugin_id: pluginId}),
  });
  const body = await response.json().catch(() => undefined);
  return {status: response.status, body};
};
const use = (base, token, method, route, body) =>
  fetch(base + '/api/' + route, {
    method,
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-AgentSys': '1'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('verified plugin identity prevents Library takeover through every mutation route', async () => {
  await withServer({}, async ({base}) => {
    const caps = ['library.read', 'library.write', 'graph.read', 'graph.write'];
    const first = (await mint(base, caps, OWNER, 'first')).body.token;
    const second = (await mint(base, caps, OWNER, 'second')).body.token;
    const spec = {name: 'Owned', code: 'node.output.value = 1;', plugin: {id: 'first'}};
    const created = await use(base, first, 'POST', 'library/script-nodes', spec);
    assert.equal(created.status, 200);
    const resource = await created.json();
    assert.equal(resource.payload.plugin.id, 'first');
    const graphOnly = (await mint(base, ['graph.write'], OWNER, 'first')).body.token;
    const encoded = await use(base, graphOnly, 'PUT', 'projects/%6cib-' + resource.id + '/input-values', {});
    assert.equal(encoded.status, 403);
    assert.match((await encoded.json()).error.message, /library\.write/, 'encoded project IDs cannot bypass the Library capability');
    assert.equal((await use(base, second, 'GET', 'resources/' + resource.id)).status, 200, 'Library definitions are shared reads');
    for (const [method, route, body] of [
      ['POST', 'library/script-nodes', {...spec, resource_id: resource.id, code: 'node.output.value = 99;'}],
      ['POST', 'library/script-nodes', {...spec, name: 'Forged new node'}],
      ['PUT', 'resources/' + resource.id, {name: 'Taken', payload: {...resource.payload, plugin: {id: 'second'}}}],
      ['DELETE', 'resources/' + resource.id],
      ['POST', 'library/node-editor', {resource_id: resource.id}],
      ['POST', 'library/custom-nodes/' + resource.id + '/move', {folder: ''}],
      ['POST', 'library/node-folders', {action: 'delete', path: ''}],
      ['PUT', 'projects/lib-' + resource.id + '/policy', {grants: ['graph.write']}],
    ]) {
      const response = await use(base, second, method, route, body);
      assert.equal(response.status, 403, `${method} ${route}: ${await response.text()}`);
    }
    const unchanged = await (await use(base, first, 'GET', 'resources/' + resource.id)).json();
    assert.deepEqual(unchanged, resource);
    assert.equal((await use(base, first, 'POST', 'library/script-nodes', {...spec, resource_id: resource.id})).status, 200);
    await use(base, first, 'DELETE', 'auth/plugin-session');
    assert.equal((await use(base, first, 'GET', 'resources')).status, 401);
    assert.equal((await use(base, second, 'GET', 'resources')).status, 200);
  });
});

test('a token can only be issued by an authenticated caller and only with known capabilities', async () => {
  await withServer({}, async ({base}) => {
    assert.equal((await mint(base, ['graph.read'], {})).status, 401);
    assert.equal((await mint(base, ['graph.read'], {Authorization: 'Bearer wrong', 'Content-Type': 'application/json'})).status, 401);
    for (const capabilities of [['root'], ['system.admin'], 'graph.read', Array(51).fill('graph.read')]) {
      const answer = await mint(base, capabilities);
      assert.equal(answer.status, 400, JSON.stringify(capabilities));
      assert.equal(answer.body.error.code, 'invalid_request');
    }
    const issued = await mint(base, ['graph.read', 'graph.read']);
    assert.equal(issued.status, 200);
    assert.match(issued.body.token, /^pst_/);
    assert.deepEqual(issued.body.capabilities, ['graph.read'], 'duplicates are removed');
    assert.equal(typeof issued.body.expires_in, 'number');
    assert.equal(issued.body.token.includes(TOKEN), false, 'the owner token is never handed out');
  });
});

test('the server, not the host, refuses a call outside the token capabilities', async () => {
  await withServer({}, async ({base}) => {
    const {body} = await mint(base, ['graph.read', 'settings.read']);
    const token = body.token;
    // The token authenticates on its own: no cookie, no owner token.
    assert.equal((await use(base, token, 'GET', 'projects')).status, 200);
    const write = await use(base, token, 'POST', 'projects', {name: 'injected'});
    assert.equal(write.status, 403);
    const denied = await write.json();
    assert.equal(denied.error.code, 'permission_denied');
    assert.match(denied.error.message, /graph\.write/);
    assert.equal((await use(base, token, 'GET', 'settings')).status, 200);
    assert.equal((await use(base, token, 'PUT', 'settings', {developer_mode: true})).status, 403);
    // Library and collections are separate families.
    assert.equal((await use(base, token, 'GET', 'library/sections')).status, 403);
    // Nothing was written.
    const projects = await (await fetch(base + '/api/projects', {headers: OWNER})).json();
    assert.deepEqual(projects, []);
  });
});

test('a wider token reaches exactly its families, including a named secret and a network host', async () => {
  await withServer({}, async ({base}) => {
    const {body} = await mint(base, [
      'graph.read',
      'graph.write',
      'library.read',
      'library.write',
      'collections.read',
      'collections.write',
      'run.read',
      'run.start',
      'settings.read',
      'settings.write',
      'secrets.use:openai',
      'net.fetch:127.0.0.1:1',
    ]);
    const token = body.token;
    assert.equal((await use(base, token, 'POST', 'projects', {name: 'made by a plugin'})).status, 200);
    assert.equal((await use(base, token, 'PUT', 'collections/notes', {title: 'Notes'})).status, 200);
    assert.equal((await use(base, token, 'POST', 'collections/notes/records', {data: {text: 'x'}})).status, 200);
    assert.equal((await use(base, token, 'GET', 'secrets/openai')).status, 200);
    assert.equal((await use(base, token, 'GET', 'secrets/other')).status, 403, 'a secret is named, not a wildcard');
    assert.equal((await use(base, token, 'GET', 'secrets/openai')).status, 200);
    // net: the host is named; the body can also carry a secret reference. Nothing external is contacted:
    // port 1 refuses at once, and a 403 would mean the capability was refused before the call.
    const allowedNet = await use(base, token, 'POST', 'net', {url: 'http://127.0.0.1:1/'});
    assert.notEqual(allowedNet.status, 403);
    const elsewhere = await use(base, token, 'POST', 'net', {url: 'http://127.0.0.1:2/'});
    assert.equal(elsewhere.status, 403);
    const withSecret = await use(base, token, 'POST', 'net', {
      url: 'http://127.0.0.1:1/',
      headers: {Authorization: '{{secret:openai}}'},
    });
    assert.notEqual(withSecret.status, 403, 'secrets.use:openai covers the reference; the secret itself is missing');
  });
});

test('a plugin token cannot use authentication, events, diagnostics or the contract', async () => {
  await withServer({}, async ({base}) => {
    const {body} = await mint(base, ['graph.read', 'graph.write']);
    const token = body.token;
    const second = await mint(base, ['graph.read'], {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-AgentSys': '1',
    });
    assert.equal(second.status, 403, 'a plugin token cannot mint another token');
    for (const [method, route] of [
      ['GET', 'events'],
      ['GET', 'diagnostics'],
      ['GET', 'openapi.json'],
    ]) {
      const response = await use(base, token, method, route);
      assert.equal(response.status, 403, `${method} ${route}`);
    }
    // The owner's own credentials still read them.
    assert.equal((await fetch(base + '/api/diagnostics', {headers: OWNER})).status, 200);
  });
});

test('a revoked token stops working at once, even when a valid session cookie is present', async () => {
  await withServer({}, async ({base}) => {
    const session = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: TOKEN}),
    });
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const {body} = await mint(base, ['graph.read']);
    const token = body.token;
    assert.equal((await use(base, token, 'GET', 'projects')).status, 200);
    const revoked = await fetch(base + '/api/auth/plugin-session', {
      method: 'DELETE',
      headers: {Authorization: 'Bearer ' + token},
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).revoked, true);
    // The cookie would authenticate the request, but an invalid plugin token is refused explicitly.
    const after = await fetch(base + '/api/projects', {headers: {Authorization: 'Bearer ' + token, Cookie: cookie}});
    assert.equal(after.status, 401);
    assert.equal((await after.json()).error.code, 'plugin_token_invalid');
    // The cookie alone still works: only the token was revoked.
    assert.equal((await fetch(base + '/api/projects', {headers: {Cookie: cookie}})).status, 200);
  });
});

test('a token expires, and the number of live tokens is bounded without silently revoking one', async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  await withServer({pluginSessionTtlMs: 1000, pluginSessionLimit: 2}, async ({base, app}) => {
    const first = (await mint(base, ['graph.read'])).body.token;
    assert.equal((await use(base, first, 'GET', 'projects')).status, 200);
    await sleep(1100);
    const expired = await use(base, first, 'GET', 'projects');
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).error.code, 'plugin_token_expired');

    const a = (await mint(base, ['graph.read'])).body.token;
    const b = (await mint(base, ['graph.read'])).body.token;
    const c = await mint(base, ['graph.read']);
    assert.equal(c.status, 429, 'at the limit a new token is refused');
    assert.equal(c.body.error.code, 'too_many_tokens');
    assert.equal((await use(base, a, 'GET', 'projects')).status, 200, 'the oldest live token was not revoked');
    assert.equal((await use(base, b, 'GET', 'projects')).status, 200);
    const diagnostics = await (await fetch(base + '/api/diagnostics', {headers: OWNER})).json();
    assert.equal(diagnostics.plugin_sessions, 2);
    assert.equal(JSON.stringify(diagnostics).includes(a), false, 'diagnostics names no token');
    assert.ok(app);
  });
});
});

describe("security", () => {
// The HTTP security surface of an AgentSys server: authentication, sessions, CSRF, Origin and Host checks,
// CORS, the event stream, body limits and redaction. Each test starts a server on a free loopback port with a
// temporary data folder. No external system is contacted.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');

const TOKEN = 'test-token-0123456789';

async function withServer(options, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-security-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  const base = await app.listen(0);
  try {
    await work({base, app, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const request = async (base, route, {method = 'GET', body, headers = {}, redirect} = {}) =>
  fetch(base + '/api/' + route, {
    method,
    headers,
    redirect,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

const bearer = {Authorization: 'Bearer ' + TOKEN};
const json = {...bearer, 'Content-Type': 'application/json'};

/** A raw HTTP request: fetch refuses to set Host or to send TRACE, and a Host check must be tested for real. */
const raw = (base, pathname, {method = 'GET', headers = {}, body} = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(base + pathname);
    const request = require('node:http').request(
      {hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers},
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () =>
          resolve({status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8')})
        );
      }
    );
    request.on('error', reject);
    if (body !== undefined) request.write(typeof body === 'string' ? body : JSON.stringify(body));
    request.end();
  });

const session = async base => {
  const response = await fetch(base + '/api/auth/session', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({token: TOKEN}),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return {cookie: cookie.split(';')[0], raw: cookie};
};

test('every protected family refuses an unauthenticated caller and an invalid session', async () => {
  await withServer({}, async ({base}) => {
    for (const [method, route] of [
      ['GET', 'projects'],
      ['POST', 'projects'],
      ['GET', 'diagnostics'],
      ['GET', 'events'],
      ['GET', 'settings'],
      ['PUT', 'settings'],
      ['GET', 'openapi.json'],
    ]) {
      const response = await request(base, route, {method, body: method === 'GET' ? undefined : {}});
      assert.equal(response.status, 401, `${method} ${route}`);
      const body = await response.json();
      assert.equal(body.error.code, 'unauthorized');
    }
    // A made-up cookie is not a session, and neither is a plausible but unknown value.
    for (const value of ['agentsys_session=deadbeef', 'agentsys_session=' + 'a'.repeat(43)]) {
      const response = await request(base, 'projects', {headers: {Cookie: value}});
      assert.equal(response.status, 401, value.slice(0, 40));
    }
    // Discovery is public; it carries no data and no secrets.
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.product, 'agentsys');
    assert.equal(JSON.stringify(meta).includes(TOKEN), false);
  });
});

test('a session ends at logout and cannot be replayed afterwards', async () => {
  await withServer({}, async ({base}) => {
    const {cookie} = await session(base);
    assert.equal((await request(base, 'projects', {headers: {Cookie: cookie}})).status, 200);
    const diagnostics = await request(base, 'diagnostics', {headers: bearer});
    const before = (await diagnostics.json()).sessions;
    assert.equal(before, 1);
    const logout = await request(base, 'auth/logout', {method: 'POST', headers: {Cookie: cookie}});
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request(base, 'projects', {headers: {Cookie: cookie}})).status, 401);
    const after = (await (await request(base, 'diagnostics', {headers: bearer})).json()).sessions;
    assert.equal(after, 0, 'the session was removed, not only forgotten by the browser');
  });
});

test('a cookie write needs the CSRF header and an allowed origin; a bearer token does not', async () => {
  await withServer({allowedOrigins: ['http://client.example']}, async ({base}) => {
    const {cookie} = await session(base);
    const write = (headers, body = {name: 'x'}) =>
      request(base, 'projects', {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body});

    assert.equal((await write({Cookie: cookie})).status, 403, 'no CSRF header');
    assert.equal((await write({Cookie: cookie, 'X-AgentSys': '1'})).status, 200, 'same-origin cookie write');
    assert.equal(
      (await write({Cookie: cookie, 'X-AgentSys': '1', Origin: 'http://evil.example'})).status,
      403,
      'a foreign origin cannot write with a cookie'
    );
    assert.equal(
      (await write({Cookie: cookie, 'X-AgentSys': '1', Origin: 'http://client.example'})).status,
      200,
      'a configured origin can'
    );
    // A bearer token is not attached automatically by a browser, so an Origin is not required with it.
    assert.equal((await write({...bearer})).status, 200, 'a bearer write needs no CSRF header');
    // A GET with a cookie needs no CSRF header: it changes nothing.
    assert.equal((await request(base, 'projects', {headers: {Cookie: cookie}})).status, 200);
  });
});

test('an unexpected Host is refused on a loopback server, including a rebinding name', async () => {
  await withServer({allowedHosts: ['trusted.example']}, async ({base}) => {
    const get = host => raw(base, '/api/projects', {headers: {...bearer, Host: host}});
    assert.equal((await get('127.0.0.1')).status, 200);
    assert.equal((await get('localhost')).status, 200);
    assert.equal((await get('evil.example')).status, 403);
    assert.equal((await get('trusted.example')).status, 200, 'a configured name is accepted');
    // The Host check also applies to the session endpoint, which is otherwise public.
    const login = await raw(base, '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Host: 'evil.example'},
      body: {token: TOKEN},
    });
    assert.equal(login.status, 403);
  });
});

test('CORS answers only configured origins, never with a wildcard and never with a foreign one', async () => {
  await withServer({allowedOrigins: ['http://client.example']}, async ({base}) => {
    const preflight = await fetch(base + '/api/projects', {
      method: 'OPTIONS',
      headers: {'Access-Control-Request-Method': 'POST', Origin: 'http://client.example'},
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://client.example');
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-AgentSys/);
    assert.match(preflight.headers.get('access-control-allow-headers'), /If-Match/);
    assert.notEqual(preflight.headers.get('access-control-allow-origin'), '*');

    for (const origin of ['http://evil.example', 'null', 'https://client.example.evil.test']) {
      const denied = await fetch(base + '/api/projects', {
        method: 'OPTIONS',
        headers: {'Access-Control-Request-Method': 'POST', Origin: origin},
      });
      assert.equal(denied.headers.get('access-control-allow-origin'), null, origin);
      const read = await request(base, 'projects', {headers: {...bearer, Origin: origin}});
      assert.equal(read.headers.get('access-control-allow-origin'), null, origin);
    }
    // The allowed origin is echoed back, not reflected from a prefix.
    const read = await request(base, 'projects', {headers: {...bearer, Origin: 'http://client.example'}});
    assert.equal(read.headers.get('access-control-allow-origin'), 'http://client.example');
    assert.match(read.headers.get('vary') || '', /Origin/);
  });
});

test('the event stream refuses an anonymous caller and reports changes to an authenticated one', async () => {
  await withServer({}, async ({base}) => {
    assert.equal((await fetch(base + '/api/events')).status, 401);
    assert.equal((await fetch(base + '/api/events', {headers: {Cookie: 'agentsys_session=nope'}})).status, 401);
    const controller = new AbortController();
    const response = await fetch(base + '/api/events', {headers: bearer, signal: controller.signal});
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (let i = 0; i < 20 && !text.includes('"type":"ready"'); i++) {
      const {value, done} = await reader.read();
      if (done) break;
      text += decoder.decode(value, {stream: true});
    }
    assert.match(text, /"type":"ready"/);
    assert.match(text, /"protocol":1/);
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

test('a wrong or conflicting credential never unlocks a write', async () => {
  await withServer({}, async ({base}) => {
    const response = await request(base, 'projects', {
      method: 'POST',
      headers: {Authorization: 'Bearer wrong', 'Content-Type': 'application/json'},
      body: {name: 'x'},
    });
    assert.equal(response.status, 401);
    // A valid session with a wrong bearer header is still the same authenticated user: the session counts.
    const {cookie} = await session(base);
    const mixed = await request(base, 'projects', {
      method: 'POST',
      headers: {Cookie: cookie, Authorization: 'Bearer wrong', 'X-AgentSys': '1', 'Content-Type': 'application/json'},
      body: {name: 'session still works'},
    });
    assert.equal(mixed.status, 200);
    // A wrong token in the login body is refused even when a valid cookie is present.
    const login = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Cookie: cookie},
      body: JSON.stringify({token: 'wrong'}),
    });
    assert.equal(login.status, 401);
  });
});

test('a body over the limit gets a 413 instead of a dead connection', async () => {
  await withServer({}, async ({base}) => {
    // The API accepts 20 MB; the session endpoint 64 KB.
    const big = 'x'.repeat(21 * 1024 * 1024);
    const response = await request(base, 'projects', {
      method: 'POST',
      headers: {...json},
      body: JSON.stringify({name: big}),
    }).catch(error => ({status: 0, failure: error.message}));
    assert.equal(response.status, 413, JSON.stringify(response));
    const body = await response.json();
    assert.equal(body.error.code, 'too_large');
    assert.match(body.error.message, /larger than the limit/);

    const login = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: 'x'.repeat(70000)}),
    });
    assert.equal(login.status, 413);
  });
});

test('an unknown route, an unknown method and a malformed escape answer in JSON and leak nothing', async () => {
  await withServer({}, async ({base}) => {
    const unknown = await request(base, 'nope/at/all', {headers: bearer});
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'not_found');
    const method = await raw(base, '/api/projects', {method: 'TRACE', headers: bearer});
    assert.equal(method.status, 405);
    const malformed = await raw(base, '/api/collections/%E0%A4%A/records', {headers: bearer});
    assert.equal(malformed.status, 400);
    const body = JSON.parse(malformed.text);
    assert.equal(JSON.stringify(body).includes('at Object.'), false, 'no stack in the answer');
    assert.equal(JSON.stringify(body).includes(path.sep + 'server.js'), false, 'no file path in the answer');
  });
});

test('diagnostics report state and counts, never workflow data, tokens or secrets', async () => {
  await withServer({}, async ({base}) => {
    await request(base, 'secrets/provider-key', {method: 'PUT', headers: json, body: {value: 'sk-live-super-secret'}});
    await request(base, 'collections/notes', {
      method: 'PUT',
      headers: json,
      body: {title: 'Notes', schema: {type: 'object', properties: {text: {type: 'string'}}}},
    });
    await request(base, 'collections/notes/records', {
      method: 'POST',
      headers: json,
      body: {data: {text: 'private note body'}},
    });
    const diagnostics = await request(base, 'diagnostics', {headers: bearer});
    assert.equal(diagnostics.status, 200);
    const text = await diagnostics.text();
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes('sk-live-super-secret'), false);
    assert.equal(text.includes('private note body'), false);
    const value = JSON.parse(text);
    assert.equal(typeof value.sessions, 'number');
    assert.equal(typeof value.storage.mode, 'string');
    assert.equal(Array.isArray(value.recent_errors), true);
  });
});

test('error messages are redacted before they are returned and logged', async () => {
  await withServer({}, async ({app}) => {
    const redacted = app.redact('Authorization: Bearer abc.def.ghi api_key=sk-live-123 token: "zzz" password=hunter2');
    assert.match(redacted, /Bearer \[REDACTED\]/);
    assert.equal(redacted.includes('abc.def.ghi'), false);
    assert.equal(redacted.includes('sk-live-123'), false);
    assert.equal(redacted.includes('zzz'), false);
    assert.equal(redacted.includes('hunter2'), false);
  });
});

test('one server refuses to expose the API on a non-loopback address without a token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-exposed-'));
  const app = createApiServer({dataDir: dir, host: '0.0.0.0', token: ''});
  const base = await app.listen(0);
  try {
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.auth, 'loopback');
    const response = await fetch(base + '/api/projects', {headers: {Host: '127.0.0.1'}});
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error.message, /AGENTSYS_TOKEN/);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('the generated contract matches the routes and reports the running version', async () => {
  await withServer({}, async ({base}) => {
    const spec = await (await request(base, 'openapi.json', {headers: bearer})).json();
    assert.equal(spec.info.version, require('../runtime/protocol').API_VERSION);
    assert.equal(spec.info['x-protocol'], 1);
    for (const route of ['/api/projects', '/api/projects/{project_id}/workflow', '/api/collections/{name}/records', '/api/events', '/api/meta'])
      assert.ok(spec.paths[route], `the contract documents ${route}`);
    // Every documented operation has a summary and responses; no operation is a client-only route.
    for (const [route, item] of Object.entries(spec.paths)) {
      assert.ok(route.startsWith('/api/'), route);
      for (const [method, operation] of Object.entries(item)) {
        assert.ok(['get', 'post', 'put', 'patch', 'delete'].includes(method), `${route} ${method}`);
        assert.equal(typeof operation.summary, 'string');
        assert.ok(operation.responses);
      }
    }
  });
});

test('sign-in attempts are limited per address, and a success clears the count', async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  await withServer({authAttempts: 3, authWindowMs: 1000}, async ({base}) => {
    const login = token =>
      fetch(base + '/api/auth/session', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token}),
      });
    for (let attempt = 0; attempt < 3; attempt++) assert.equal((await login('wrong')).status, 401);
    const limited = await login('wrong');
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'rate_limited');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1, 'the answer says how long to wait');
    // The right token waits out the window too: the limit is not an oracle for which guess was right.
    assert.equal((await login(TOKEN)).status, 429);
    await sleep(1100);
    const good = await login(TOKEN);
    assert.equal(good.status, 200);
    assert.match(good.headers.get('set-cookie'), /HttpOnly/);
    // A successful sign-in cleared the count, so one wrong attempt is a 401 again, not a 429.
    assert.equal((await login('wrong')).status, 401);
  });
});

test('on POSIX a secret file and the commit record are readable by their owner only', {skip: process.platform === 'win32'}, async () => {
  await withServer({}, async ({base, dir}) => {
    const response = await request(base, 'secrets/provider-key', {method: 'PUT', headers: json, body: {value: 'sk-live-1'}});
    assert.equal(response.status, 200);
    const file = path.join(dir, 'secrets', 'provider-key.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the stored secret is 0600');
    // The commit record carries the value too, and is written 0600 before the data files are applied.
    const transaction = path.join(dir, '.transaction.json');
    assert.equal(fs.existsSync(transaction), false, 'the record is gone after the commit');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.value, 'sk-live-1');
  });
});

test('a malformed cookie is an anonymous request, not a server error', async () => {
  await withServer({}, async ({base}) => {
    const response = await request(base, 'projects', {headers: {Cookie: 'agentsys_session=%E0%A4%A'}});
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error.code, 'unauthorized');
  });
});

test('an operator token that starts with the plugin prefix still authenticates', async () => {
  const operator = 'pst_operator_token_0123456789';
  await withServer({token: operator}, async ({base}) => {
    const response = await request(base, 'projects', {headers: {Authorization: 'Bearer ' + operator}});
    assert.equal(response.status, 200);
    // A real plugin token is still a plugin token: it cannot become an operator credential by its prefix.
    const issued = await request(base, 'auth/plugin-session', {
      method: 'POST',
      headers: {Authorization: 'Bearer ' + operator, 'Content-Type': 'application/json', 'X-AgentSys': '1'},
      body: {capabilities: ['graph.read']},
    });
    assert.equal(issued.status, 200);
    const token = (await issued.json()).token;
    assert.notEqual(token, operator);
    const pluginRead = await request(base, 'projects', {headers: {Authorization: 'Bearer ' + token}});
    assert.equal(pluginRead.status, 200);
    const pluginWrite = await request(base, 'projects', {
      method: 'POST',
      headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
      body: {name: 'not allowed'},
    });
    assert.equal(pluginWrite.status, 403);
  });
});
test('an expired session is refused and removed from the server', async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  await withServer({sessionTtlMs: 1000}, async ({base}) => {
    const {cookie} = await session(base);
    assert.equal((await request(base, 'projects', {headers: {Cookie: cookie}})).status, 200);
    const before = await (await request(base, 'diagnostics', {headers: bearer})).json();
    assert.equal(before.sessions, 1);
    await sleep(1100);
    const expired = await request(base, 'projects', {headers: {Cookie: cookie}});
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).error.code, 'unauthorized');
    const after = await (await request(base, 'diagnostics', {headers: bearer})).json();
    assert.equal(after.sessions, 0, 'the expired session was removed when it was presented');
  });
});
});

describe("tls", () => {
// Local TLS integration: a real HTTPS server with a generated self-signed certificate, plus the reverse-proxy
// Secure-cookie path. Skipped, with the reason, when openssl is not installed on this machine.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  https = require('node:https'),
  {execFileSync} = require('node:child_process');
const {createApiServer} = require('../server/api-server');

const OPENSSL = [
  process.env.OPENSSL,
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  '/usr/bin/openssl',
  '/usr/local/bin/openssl',
].find(candidate => candidate && fs.existsSync(candidate));
const TOKEN = 'tls-token-0123456789';

function request(base, route, {method = 'GET', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + '/api/' + route);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        rejectUnauthorized: false, // the certificate is self-signed and made for this test
        servername: 'localhost',
      },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () =>
          resolve({status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8')})
        );
      }
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('a generated certificate serves HTTPS with the protocol header and a Secure session cookie', {skip: !OPENSSL && 'openssl is not available'}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-tls-'));
  const key = path.join(dir, 'key.pem'),
    cert = path.join(dir, 'cert.pem');
  try {
    execFileSync(
      OPENSSL,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      {stdio: 'ignore'}
    );
    const app = createApiServer({
      dataDir: path.join(dir, 'data'),
      token: TOKEN,
      tls: {key: fs.readFileSync(key), cert: fs.readFileSync(cert)},
    });
    const base = await app.listen(0);
    try {
      assert.match(base, /^https:\/\//);
      const meta = await request(base, 'meta');
      assert.equal(meta.status, 200);
      assert.equal(JSON.parse(meta.text).product, 'agentsys');
      assert.equal(meta.headers['x-agentsys-protocol'], '1');
      const session = await request(base, 'auth/session', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: {token: TOKEN},
      });
      assert.equal(session.status, 200);
      assert.match(session.headers['set-cookie'][0], /HttpOnly/);
      assert.match(session.headers['set-cookie'][0], /Secure/, 'TLS makes the session cookie Secure');
      const cookie = session.headers['set-cookie'][0].split(';')[0];
      const projects = await request(base, 'projects', {headers: {Cookie: cookie}});
      assert.equal(projects.status, 200);
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('behind a trusted proxy, X-Forwarded-Proto marks the session cookie Secure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-proxy-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, trustProxy: true});
  const base = await app.listen(0);
  try {
    const response = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https'},
      body: JSON.stringify({token: TOKEN}),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /Secure/);
    const insecure = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: TOKEN}),
    });
    assert.doesNotMatch(insecure.headers.get('set-cookie'), /Secure/);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
});
