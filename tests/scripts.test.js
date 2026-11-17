'use strict';
const {describe} = require('node:test');

describe("net-allowlist", () => {
// The optional server-wide egress allowlist: on top of a Script's net.fetch grant, a deployment can restrict which
// hosts this server will contact. It applies to the HTTP route and to a Script's call, which share the same route.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');
const {createApp, nodes} = require('./harness');

const TOKEN = 'net-token';
const headers = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};

async function withApi(options, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-net-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  const base = await app.listen(0);
  try {
    await work({app, base, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const net = (base, url) => fetch(base + '/api/net', {method: 'POST', headers, body: JSON.stringify({url})});

test('without an allowlist the server tries the host and reports the network failure', async () => {
  await withApi({}, async ({base}) => {
    const response = await net(base, 'http://127.0.0.1:2/');
    assert.notEqual(response.status, 403, 'no allowlist refusal');
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.features.net_allowlist, false);
  });
});

test('with an allowlist only the named hosts are contacted, and the refusal names them', async () => {
  await withApi({allowedNetHosts: ['127.0.0.1:1', '*.example.test']}, async ({base}) => {
    const allowed = await net(base, 'http://127.0.0.1:1/');
    assert.notEqual(allowed.status, 403, 'an allowed host reaches the network layer (and fails to connect)');
    const denied = await net(base, 'http://127.0.0.1:2/');
    assert.equal(denied.status, 403);
    const body = await denied.json();
    assert.equal(body.error.code, 'permission_denied');
    assert.match(body.error.message, /127\.0\.0\.1:1/);
    // A wildcard matches subdomains only, not a lookalike suffix.
    const allowedWildcard = await net(base, 'https://api.example.test/');
    assert.notEqual(allowedWildcard.status, 403);
    const lookalike = await net(base, 'https://example.test.evil.invalid/');
    assert.equal(lookalike.status, 403);
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.features.net_allowlist, true);
  });
});

test('a Script obeys the same allowlist even with a net.fetch grant', async () => {
  const app = createApp({scripts: 'inline', allowedNetHosts: ['127.0.0.1:1']});
  try {
    const {id} = await app.api('POST', 'projects', {name: 'Egress'});
    const script = await app.api('POST', `projects/${id}/typed-nodes`, {
      workflow_id: id,
      node_type: 'custom',
      config: nodes.script(`try { await agentsys("POST", "net", {url: "http://127.0.0.1:2/"}); }
        catch (error) { node.display(error.message); }`),
    });
    const run = await app.api('POST', `projects/${id}/execution`, {workflow_id: id, node_ids: [script.id], wait: true});
    const shown = Object.values(run.displays || {}).join(' ');
    assert.match(shown, /does not fetch 127\.0\.0\.1:2/);
  } finally {
    await app.Backend.shutdownExecutions();
  }
});
});

describe("permissions", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn, flow, nodes, TYPES} = require('./harness');
async function fakeApp(scripts = 'inline') {
  const app = createApp({scripts});
  const p = await app.api('POST', 'projects', {name: 'AI'});
  return {app, p};
}
test('API calls from a Script require instance permissions and project policy', async () => {
  const {app, p} = await fakeApp();
  for (const options of [{grants: []}, {grants: ['graph.read']}, {grants: ['graph.write'], grants: []}]) {
    const n = await fn(
      app,
      p.id,
      {},
      {...options, code: 'await agentsys("PUT","projects/"+context.project_id,{description:"changed"});'}
    );
    const r = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true});
    assert.ok(Object.keys(r.errors).length > 0);
    assert.match(JSON.stringify(r.errors), /Permission denied/);
  }
  const n = await fn(
    app,
    p.id,
    {},
    {grants: ['graph.read'], code: 'const p=await agentsys("GET","projects"); node.display(p.length);'}
  );
  assert.equal((await app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true})).status, 'idle');
  assert.ok(
    await app.eval('ROUTES.every(r => [...r.methods].every(m => Array.isArray(r.needs[m]) && r.needs[m].length))')
  );
});

test('worker has no direct network, messaging, Node globals or constructor escape to the host', async () => {
  const {app, p} = await fakeApp('worker');
  const n = await fn(
    app,
    p.id,
    {},
    {
      code: 'node.output.result=[typeof fetch,typeof importScripts,typeof require,typeof process,typeof postMessage,typeof setTimeout.constructor("return globalThis.process")(),typeof globalThis.__host];',
      outputs: ['result'],
      grants: [],
    }
  );
  const r = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true});
  assert.equal(r.status, 'idle');
  assert.deepEqual(r.outputs[n.id].result, Array(7).fill('undefined'));
});

test('timer validation errors cannot expose the host realm to a Script', async () => {
  const {app, p} = await fakeApp('worker');
  try {
    const n = await fn(app, p.id, {}, {
      code: `const results = [];
        for (const delay of [Symbol('delay'), {valueOf() { return Symbol('delay'); }}]) {
          try { setTimeout(() => {}, delay); results.push('accepted'); }
          catch (error) { results.push(error.constructor.constructor('return typeof process')()); }
        }
        node.output.result = results;`,
      outputs: ['result'], grants: [],
    });
    const r = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true});
    assert.deepEqual(r.errors, {});
    assert.deepEqual(r.outputs[n.id].result, ['undefined', 'undefined']);
  } finally {
    await app.Backend.shutdownExecutions();
  }
});

test('network allow lists and secret substitution are enforced by the host', async () => {
  const {app, p} = await fakeApp();
  await app.api('PUT', `projects/${p.id}/policy`, {allow: ['net.fetch:good.test', 'secrets.use:service']});
  await app.api('PUT', 'secrets/service', {value: 'sensitive-value'});
  let calls = 0;
  app.context.fetch = async (url, init) => {
    calls++;
    assert.equal(init.headers.Authorization, 'Bearer sensitive-value');
    return {status: 200, text: async () => 'echo sensitive-value'};
  };
  const n = await fn(
    app,
    p.id,
    {},
    {
      grants: ['net.fetch:good.test', 'secrets.use:service'],
      code: 'node.output.result=await agentsys("POST","net",{url:"https://good.test/path",headers:{Authorization:"Bearer {{secret:service}}"}});',
      outputs: ['result'],
    }
  );
  const r = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true});
  assert.equal(r.status, 'idle');
  assert.equal(r.outputs[n.id].result.text, 'echo [REDACTED]');
  assert.equal(calls, 1);
  const bad = await fn(
    app,
    p.id,
    {},
    {grants: ['net.fetch:good.test'], code: 'await agentsys("POST","net",{url:"https://other.test"});'}
  );
  const denied = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [bad.id], wait: true});
  assert.ok(Object.keys(denied.errors).length > 0);
  assert.equal(calls, 1);
});

test('what a script writes into the Library is stripped of grants', async () => {
  const {app, p} = await fakeApp();
  const {bundleOf, nodes} = require('./harness');
  const made = bundleOf('Made by a script', {Body: {inputs: [], outputs: []}, Script: nodes.script('')});
  const writer = await fn(
    app,
    p.id,
    {},
    {
      grants: ['library.write', 'graph.read'],
      code: `await agentsys("POST","resources",{name:"Made by a script",payload:{bundle:${JSON.stringify(made.bundle)},grants:["graph.write"],grants:["graph.write"]}});`,
    }
  );
  await app.api('PUT', `projects/${p.id}/policy`, {allow: ['library.write', 'graph.read']});
  const run = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [writer.id], wait: true});
  assert.equal(run.status, 'idle', JSON.stringify(run.errors));
  const item = (await app.api('GET', 'resources')).find(r => r.name === 'Made by a script');
  assert.deepEqual(item.payload.grants, ['graph.read']);
});

test('Library permissions are placement defaults, never a ceiling for an existing instance', async () => {
  const {app, p} = await fakeApp('worker');
  const n = await fn(
    app,
    p.id,
    {},
    {grants: [], outputs: ['result'], code: 'node.output.result=(await agentsys("GET","projects")).length;'}
  );
  await flow(app, p.id, {}, [n.step]);
  const run = () => app.api('POST', `projects/${p.id}/execution`, {wait: true});
  assert.ok(Object.keys((await run()).errors).length > 0);
  await app.api('PUT', `projects/${p.id}/complex/${n.group}`, {grants: ['graph.read']});
  assert.equal((await run()).status, 'idle', 'instance can allow a right absent from the Library defaults');
  const resource = await app.api('GET', 'resources/' + n.resource);
  await app.api('PUT', 'resources/' + n.resource, {
    name: resource.name,
    payload: {...resource.payload, grants: ['library.read']},
  });
  const snapshot = await app.api('GET', `projects/${p.id}/workflow`);
  assert.deepEqual(snapshot.complex.find(c => c.id === n.group).grants, ['graph.read']);
  assert.equal((await run()).status, 'idle', 'changing the defaults does not restrict an existing copy');
  const next = await app.api('POST', `projects/${p.id}/custom-nodes/${n.resource}`, {point: {x: 300, y: 0}});
  const after = await app.api('GET', `projects/${p.id}/workflow`);
  assert.deepEqual(after.complex.find(c => c.id === next.roots[0]).grants, ['library.read']);
  await app.api('PUT', `projects/${p.id}/policy`, {allow: []});
  assert.ok(Object.keys((await run()).errors).length > 0);
});

test('unused permissions do not block a node from running ordinary code', async () => {
  const {app, p} = await fakeApp('worker');
  const n = await fn(app, p.id, {}, {grants: ['net.fetch:*'], outputs: ['result'], code: 'node.output.result=42;'});
  await app.api('PUT', `projects/${p.id}/policy`, {allow: []});
  const result = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true});
  assert.equal(result.status, 'idle');
  assert.equal(result.outputs[n.id].result, 42);
});

test('typed and wired Script code use the same instance permissions', async () => {
  const {app, p} = await fakeApp('worker');
  const code = await app.api('POST', `projects/${p.id}/typed-nodes`, {
    node_type: 'custom',
    config: {
      title: 'Code',
      inputs: [],
      outputs: [
        {
          id: 'value',
          name: 'value',
          type: 't:' + TYPES.code.id,
          editable: true,
          default: `await agentsys('PUT','projects/${p.id}',{description:'Written through an explicit instance grant'});`,
        },
      ],
    },
  });
  const script = await app.api('POST', `projects/${p.id}/typed-nodes`, {
    node_type: 'custom',
    config: {...nodes.script(''), grants: ['graph.write']},
  });
  await app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source: code.id, source_port: 'value', target: script.id, target_port: 'script'}],
  });
  const result = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [script.id], wait: true});
  assert.equal(result.status, 'idle', JSON.stringify(result.errors));
  assert.equal(
    (await app.api('GET', `projects/${p.id}`)).project.description,
    'Written through an explicit instance grant'
  );
});

test('permissions are set on the placed node and limit everything inside it', async () => {
  const {app, p} = await fakeApp();
  const n = await fn(
    app,
    p.id,
    {},
    {
      grants: ['graph.write'],
      grants: ['graph.write'],
      code: 'await agentsys("PUT","projects/"+context.project_id,{description:"changed"});',
    }
  );
  const run = () => app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true});
  assert.equal((await run()).status, 'idle');
  await app.api('PUT', `projects/${p.id}/complex/${n.group}`, {grants: []});
  const denied = await run();
  assert.ok(Object.keys(denied.errors).length > 0);
  assert.match(JSON.stringify(denied.errors), /Permission denied/);
  await assert.rejects(app.api('PUT', `projects/${p.id}/complex/${n.group}`, {grants: ['bogus']}), /Invalid grants/);
  await app.api('PUT', `projects/${p.id}/complex/${n.group}`, {grants: ['graph.write']});
  assert.equal((await run()).status, 'idle');
});
test('the user sets the grants of a standalone Script; a Script cannot authorize itself', async () => {
  const {app, p} = await fakeApp('worker');
  const n = await app.api('POST', `projects/${p.id}/typed-nodes`, {
    node_type: 'custom',
    config:
      nodes.script(`try{await agentsys('PUT','projects/'+context.project_id+'/node-permissions/'+context.node_id,{grants:['net.fetch:*']});}
      catch(error){context.state.denied=error.code;}`),
  });
  await app.api('PUT', 'settings', {developer_mode: false});
  await app.api('PUT', `projects/${p.id}/node-permissions/${n.id}`, {grants: ['graph.write', 'run.start']});
  const result = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [n.id], wait: true});
  assert.equal(result.state.denied, 'permission_denied');
  const detail = await app.api('GET', `projects/${p.id}/node-permissions/${n.id}`);
  assert.deepEqual(detail.effective, ['graph.write', 'run.start']);
  await app.api('PUT', `projects/${p.id}/policy`, {allow: ['graph.read']});
  assert.deepEqual((await app.api('GET', `projects/${p.id}/node-permissions/${n.id}`)).effective, []);
});
});

describe("request-node", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn, ref, TYPES} = require('./harness');
// A program fixture for the checked Script HTTP API; no dependency on a retired data-conversion tool.
const HTTP_CODE = `const options = node.input.request ?? {
  url: node.input.url,
  method: node.input.method || 'GET',
  headers: node.input.headers,
  body: node.input.body || undefined,
  timeout: node.input.timeout ?? 10000
};
const response = await agentsys('POST', 'net', options);
node.output.status = response.status;
node.output.response = response.text;`;

test('generic Request executes through net with HTTP fields and needs no plugin permission', async () => {
  const app = createApp();
  const project = await app.api('POST', 'projects', {name: 'HTTP Request'});
  const {types} = await app.api('GET', `projects/${project.id}/types`);
  await app.api('PUT', `projects/${project.id}/types`, {types: [...types, TYPES.text]});
  await app.api('PUT', `projects/${project.id}/policy`, {allow: ['net.fetch:request.test']});
  let called = false;
  app.context.fetch = async (url, options) => {
    called = true;
    assert.equal(url.href, 'https://request.test/echo');
    assert.equal(options.method, 'POST');
    assert.equal(options.body, 'payload');
    return {status: 201, text: async () => 'HTTP answer'};
  };
  const request = await fn(app, project.id, {}, {
    code: HTTP_CODE,
    inputs: [
      {name: 'url', type: ref('text'), default: 'https://request.test/echo'},
      {name: 'method', type: ref('text'), default: 'POST'},
      {name: 'body', type: ref('text'), default: 'payload'},
    ],
    outputs: ['status', 'response'],
    grants: ['net.fetch:request.test'],
  });
  const result = await app.api('POST', `projects/${project.id}/execution`, {node_ids: [request.id], wait: true});
  assert.deepEqual(result.errors, {});
  assert.equal(called, true);
  assert.deepEqual(result.outputs[request.wrapper], {status: 201, response: 'HTTP answer'});
});

test('HTTP headers and nested options stay HTTP options and cannot select an application route', async () => {
  const run = new (Object.getPrototypeOf(async function () {}).constructor)('node', 'agentsys', HTTP_CODE);
  for (const input of [
    {url: 'https://request.test/', method: 'PATCH', headers: {'X-Test': 'yes'}, body: 'body', timeout: 1234},
    {request: {url: 'https://request.test/nested', method: 'DELETE'}, endpoint: 'plugins/other/call'},
  ]) {
    const node = {input, output: {}};
    await run(node, async (method, route, options) => {
      assert.equal(method, 'POST');
      assert.equal(route, 'net');
      if (input.request) assert.deepEqual(options, input.request);
      else assert.deepEqual(options, input);
      return {status: 204, text: ''};
    });
    assert.deepEqual(node.output, {status: 204, response: ''});
  }
});
});

describe("script", () => {
// The one node that runs code: a Script. Its inputs are variables, what it sets in `output` is its result, an on_run node starts the chain.
// Run with:  node --test
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, nodes, flow, fn} = require('./harness');

async function setup(app) {
  const {id} = await app.api('POST', 'projects', {name: 'P'}),
    q = {workflow_id: id};
  const make = config =>
    app.api('POST', `projects/${id}/typed-nodes`, {...q, node_type: 'custom', config, position: {x: 0, y: 0}});
  const wire = (from, fromPort, to, toPort) =>
    app.api('POST', `projects/${id}/port-connections`, {
      ...q,
      add: [{source: from, source_port: fromPort, target: to, target_port: toPort}],
    });
  return {id, q, make, wire};
}

test('Script: the inputs of its Library node are variables next to display, what it sets in output.<name> is the result (inline and worker)', async () => {
  for (const mode of ['inline', 'worker']) {
    const app = createApp({scripts: mode}),
      s = await setup(app);
    const script = await fn(app, s.id, s.q, {
        code: 'node.display("hi"); node.output.result = n * 2',
        inputs: ['n'],
        outputs: ['result'],
        signals: ['out'],
      }),
      twentyOne = await s.make(nodes.value('number', 21)),
      shown = await fn(app, s.id, s.q, {code: 'node.display(String(v))', inputs: ['v']});
    await s.wire(twentyOne.id, 'value', script.wrapper, 'n');
    await s.wire(script.wrapper, 'result', shown.wrapper, 'v');
    const start = await flow(app, s.id, s.q, [script.step, shown.step]);
    const r = await app.api('POST', `projects/${s.id}/evaluate-node`, {...s.q, node_ids: [start], collect: true});
    assert.deepEqual(r.errors, {}, mode);
    assert.equal(r.displays[shown.id], '42', mode);
    assert.equal(r.displays[script.id], 'hi', mode);
  }
});

test('on_run: Run fires it, and a Script after it sees the payload of the trigger', async () => {
  const app = createApp(),
    s = await setup(app);
  const script = await fn(app, s.id, s.q, {code: 'node.display(context.event.payload.n * 2)'});
  await flow(app, s.id, s.q, [script.step]);
  const r = await app.api('POST', `projects/${s.id}/execution`, {...s.q, wait: true, payload: {n: 21}});
  assert.equal(r.status, 'idle', JSON.stringify(r.errors));
  assert.equal(r.displays[script.id], '42');
});

test('Script and Event are added as they are (no Library): an Event has no inputs, its event is chosen on it', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'P'}),
    q = {workflow_id: id};
  const script = await app.api('POST', `projects/${id}/primitives`, {...q, primitive: 'script', point: {x: 0, y: 0}}),
    again = await app.api('POST', `projects/${id}/primitives`, {...q, primitive: 'script', point: {x: 0, y: 80}}),
    event = await app.api('POST', `projects/${id}/primitives`, {...q, primitive: 'event', point: {x: 0, y: 160}});
  const get = () => app.api('GET', `projects/${id}/workflow`, {}, q);
  const snap = await get();
  const find = nid => snap.nodes.find(n => n.id === nid);
  assert.equal(find(script.id).config.op, 'script');
  assert.deepEqual(
    find(script.id).config.outputs,
    [{id: 'out', name: 'out', type: 'signal'}],
    'Script always has a completion signal'
  );
  assert.equal(snap.types.filter(t => t.name === 'script').length, 1, 'the code type is made once');
  assert.deepEqual(find(event.id).config.inputs, []);
  assert.deepEqual(
    find(event.id).config.outputs.map(p => p.type),
    ['signal']
  );
  assert.equal(find(event.id).config.op, 'on_run');
  await app.api('PUT', `projects/${id}/primitives/${event.id}/event`, {...q, event: 'on_read'});
  const after = await get();
  assert.equal(after.nodes.find(n => n.id === event.id).config.op, 'on_read');
  await assert.rejects(app.api('PUT', `projects/${id}/primitives/${event.id}/event`, {...q, event: 'script'}));
  await assert.rejects(app.api('PUT', `projects/${id}/primitives/${script.id}/event`, {...q, event: 'on_run'}));
  assert.ok(again.id);
});

test('an editable output of a Complex Node (a Library node that is only a frame, like Bool) is read as what is typed there', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'P'}),
    q = {workflow_id: id};
  const bundle = (outputs, types) => ({
    version: 1,
    source_project: 'lib-x',
    types,
    records: [],
    positions: {},
    port_edges: [],
    widgets: {},
    styles: {},
    groups: [
      {
        id: 'g1',
        name: 'V',
        parent: null,
        members: [],
        color: null,
        pinned: false,
        folded: false,
        disabled: false,
        position: {x: 0, y: 0},
      },
    ],
    complex: [
      {
        id: 'g1',
        interface: {inputs: [], outputs},
        collapsed: false,
        compact_width: 240,
        compact_height: 90,
        arbitrary: {inputs: false, outputs: false},
      },
    ],
  });
  const T = 'd1714f2eec0f4bcfa0edc8602f7f67c2';
  const types = [{id: T, name: 'bool', color: '#d666c2', fields: [], control: 'checkbox'}];
  const read = async (output, expected) => {
    const lib = await app.api('POST', 'resources', {
      name: 'V' + Math.random(),
      payload: {bundle: bundle([output], types), description: ''},
    });
    const placed = await app.api('POST', `projects/${id}/custom-nodes/${lib.id}`, {...q, point: {x: 0, y: 0}});
    const snap = await app.api('GET', `projects/${id}/workflow`, {}, q);
    const complexId = 'complex:' + placed.roots[0],
      port = snap.complex.find(c => c.id === placed.roots[0]).interface.outputs[0].id;
    const script = await fn(app, id, q, {code: 'node.display(String(input))', inputs: ['input']});
    await app.api('POST', `projects/${id}/port-connections`, {
      ...q,
      add: [{source: complexId, source_port: port, target: script.wrapper, target_port: 'input'}],
    });
    const start = await flow(app, id, q, [script.step]);
    const r = await app.api('POST', `projects/${id}/evaluate-node`, {...q, node_ids: [start], collect: true});
    assert.deepEqual(r.errors, {});
    assert.equal(r.displays[script.id], String(expected));
  };
  await read({id: 'p1', name: 'bool', type: 't:' + T, editable: true, default: true}, true);
  await read({id: 'p2', name: 'bool', type: 't:' + T, editable: true}, false);
});

test('a placed Library node that was saved again is brought up to date once: reading does not give its nodes new IDs every time', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'P'}),
    q = {workflow_id: id};
  const bundle = code => ({
    version: 1,
    source_project: 'lib-x',
    types: [],
    port_edges: [],
    widgets: {},
    positions: {r1: {x: 0, y: 0}},
    styles: {},
    records: [
      {
        id: 'r1',
        payload: {
          kind: 'function',
          node_type: 'custom',
          config: {title: 'S' + code, inputs: [], outputs: [{id: 'result', name: 'result'}]},
          label: 'Custom',
          status: 'ready',
        },
      },
    ],
    groups: [
      {id: 'g1', name: 'V', parent: null, members: ['r1'], color: null, pinned: false, folded: false, disabled: false},
    ],
    complex: [
      {
        id: 'g1',
        interface: {inputs: [], outputs: []},
        collapsed: false,
        compact_width: 240,
        compact_height: 90,
        arbitrary: {inputs: false, outputs: false},
      },
    ],
  });
  const lib = await app.api('POST', 'resources', {name: 'V', payload: {bundle: bundle(1), description: ''}});
  await app.api('POST', `projects/${id}/custom-nodes/${lib.id}`, {...q, point: {x: 0, y: 0}});
  await app.api('PUT', `resources/${lib.id}`, {name: 'V', payload: {bundle: bundle(2), description: ''}});
  const ids = async () =>
    (await app.api('GET', `projects/${id}/workflow`, {}, q)).nodes
      .map(n => n.id)
      .sort()
      .join();
  const first = await ids();
  assert.equal(await ids(), first);
});

test('a Script keeps a signal input: it is what starts it', async () => {
  const app = createApp(),
    s = await setup(app);
  await assert.rejects(
    s.make({title: 'S', op: 'script', inputs: [], outputs: [{id: 'result', name: 'result'}]}),
    /signal input/
  );
});

test('the types of a Script are the same in every workflow, so a Library node made from a Script brings no second copy', async () => {
  const app = createApp(),
    typesOf = async () => {
      const {id} = await app.api('POST', 'projects', {name: 'P'}),
        q = {workflow_id: id};
      await app.api('POST', `projects/${id}/primitives`, {...q, primitive: 'script', point: {x: 0, y: 0}});
      return (await app.api('GET', `projects/${id}/workflow`, {}, q)).types.map(t => t.id).sort();
    };
  assert.deepEqual(await typesOf(), await typesOf());
});

test('two Library nodes that each define the same type (Text and Preview both have "text") share one type in a workflow', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'P'}),
    q = {workflow_id: id};
  const make = async (name, T, port) => {
    const bundle = {
      version: 1,
      source_project: 'lib-' + name,
      types: [{id: T, name: 'text', fields: [], control: 'textarea'}],
      port_edges: [],
      widgets: {},
      positions: {},
      styles: {},
      records: [],
      groups: [
        {
          id: 'g1',
          name,
          parent: null,
          members: [],
          color: null,
          pinned: false,
          folded: false,
          disabled: false,
          position: {x: 0, y: 0},
        },
      ],
      complex: [
        {
          id: 'g1',
          interface: {inputs: [], outputs: [{id: 'p', name: port, type: 't:' + T, editable: true}]},
          collapsed: false,
          compact_width: 240,
          compact_height: 90,
          arbitrary: {inputs: false, outputs: false},
        },
      ],
    };
    const lib = await app.api('POST', 'resources', {name, payload: {bundle, description: ''}});
    return app.api('POST', `projects/${id}/custom-nodes/${lib.id}`, {...q, point: {x: 0, y: 0}});
  };
  await make('A', '1'.repeat(32), 'a');
  await make('B', '2'.repeat(32), 'b');
  const snap = await app.api('GET', `projects/${id}/workflow`, {}, q);
  assert.deepEqual(
    snap.types.map(t => t.name),
    ['text'],
    'one “text”, no “text (2)”'
  );
  const ports = snap.complex.flatMap(c => c.interface.outputs.map(p => p.type));
  assert.deepEqual([...new Set(ports)], ['t:' + snap.types[0].id], 'both nodes use it');
  const again = await app.api('GET', `projects/${id}/workflow`, {}, q);
  assert.deepEqual(
    again.types.map(t => t.id),
    snap.types.map(t => t.id),
    'and it stays so'
  );
});

test('what a Script returns is not used: only output.<name> of an output its Library node has, and any other name is an error', async () => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'P'}),
    q = {workflow_id: id};
  const noOut = await fn(app, id, q, {
      code: 'node.output.result = 1; return 2;',
      outputs: ['result'],
      signals: ['out'],
    }),
    typo = await fn(app, id, q, {code: 'node.output.other = 3;', outputs: ['result']});
  const run = node => app.api('POST', `projects/${id}/evaluate-node`, {...q, node_ids: [node], collect: true});
  const r = await run(noOut.id);
  assert.deepEqual(r.outputs[noOut.id], {result: 1}, 'the return value is not used');
  assert.match(
    (await run(typo.id)).errors[typo.id],
    /no free output “other”/,
    'a name the node has no output of is an error'
  );
});
});
