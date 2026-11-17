'use strict';
const {describe} = require('node:test');

describe("backup", () => {
// The backup tool: refuses a live data folder unless forced, copies every file, checks that the JSON parses, and
// produces a folder that a server can start on directly.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  {execFileSync} = require('node:child_process');
const {createApiServer} = require('../server/api-server');

const TOOL = path.join(__dirname, '..', 'cli.js');
const run = (data, out, extra = []) => {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, 'backup', '--data', data, '--out', out, '--json', ...extra], {
      encoding: 'utf8',
    });
    return {code: 0, json: JSON.parse(stdout)};
  } catch (error) {
    return {code: error.status, stdout: error.stdout, stderr: error.stderr, json: error.stdout ? JSON.parse(error.stdout) : null};
  }
};

test('a stopped folder is copied completely, checked and restorable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-source-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-target-'));
  const restored = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-restored-'));
  try {
    const app = createApiServer({dataDir: dir, token: 't'});
    await app.api.request('POST', 'projects', {body: {name: 'Backed up'}, query: {}});
    await app.api.request('PUT', 'collections/notes', {
      body: {title: 'Notes', schema: {type: 'object', properties: {text: {type: 'string'}}}},
      query: {},
    });
    await app.api.request('POST', 'collections/notes/records', {body: {data: {text: 'kept'}}, query: {}});
    await app.close();

    const result = run(dir, out);
    assert.equal(result.code, 0, result.stderr || '');
    assert.equal(result.json.ok, true);
    assert.equal(result.json.live, false);
    assert.ok(result.json.files >= 3);
    assert.deepEqual(result.json.unreadable, []);
    const destination = result.json.destination;
    assert.equal(fs.existsSync(path.join(destination, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(destination, 'projects.json')), true);

    // Restore: the backup folder is itself a data folder.
    fs.cpSync(destination, restored, {recursive: true});
    const server = createApiServer({dataDir: restored, token: 't'});
    try {
      const projects = JSON.parse(JSON.stringify(await server.api.request('GET', 'projects', {body: {}, query: {}})));
      assert.deepEqual(projects.map(item => item.name), ['Backed up']);
      const records = JSON.parse(JSON.stringify(await server.api.request('GET', 'collections/notes/records', {body: {}, query: {}})));
      assert.deepEqual(records.records.map(record => record.data.text), ['kept']);
    } finally {
      await server.close();
    }
  } finally {
    for (const folder of [dir, out, restored]) fs.rmSync(folder, {recursive: true, force: true});
  }
});

test('a running server is refused without --force, and --force says the copy is live', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-live-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-live-out-'));
  const app = createApiServer({dataDir: dir, token: 't'});
  try {
    const refused = run(dir, out);
    assert.equal(refused.code, 3);
    assert.equal(refused.json.ok, false);
    assert.match(refused.json.error, /server is running/);
    const forced = run(dir, out, ['--force']);
    assert.equal(forced.code, 0, forced.stderr || '');
    assert.equal(forced.json.live, true);
    assert.equal(fs.existsSync(path.join(forced.json.destination, '.server.lock')), false, 'the source lock is not copied');
    // The copy can start on its own folder while the original server still runs.
    const restored = createApiServer({dataDir: forced.json.destination, token: 't'});
    try {
      await restored.listen(0);
    } finally {
      await restored.close();
    }
  } finally {
    await app.close();
    for (const folder of [dir, out]) fs.rmSync(folder, {recursive: true, force: true});
  }
});

test('a corrupted JSON file is copied, reported and makes the backup exit non-zero', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-bad-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-backup-bad-out-'));
  try {
    fs.writeFileSync(path.join(dir, 'projects.json'), '{"broken":');
    fs.writeFileSync(path.join(dir, 'prefs.json'), '{"theme":"Light"}');
    const result = run(dir, out);
    assert.equal(result.code, 1);
    assert.equal(result.json.unreadable.length, 1);
    assert.equal(result.json.unreadable[0].file, 'projects.json');
    assert.equal(fs.existsSync(path.join(result.json.destination, 'projects.json')), true, 'the file is kept for repair');
  } finally {
    for (const folder of [dir, out]) fs.rmSync(folder, {recursive: true, force: true});
  }
});
});

describe("concurrency", () => {
// Two clients against one server, and two servers side by side: conditional writes, events for both readers,
// one client stopping work the other is watching, a stream across a restart, and no data mixing between servers.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');
const Protocol = require('../runtime/protocol');

const TOKEN = 'concurrency-token';
const bearer = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-concurrency-'))) {
  const app = createApiServer({dataDir: directory, token: TOKEN});
  const base = await app.listen(0);
  return {app, base, dir: directory};
}

const call = async (base, method, route, {body, headers = {}} = {}) => {
  const response = await fetch(base + '/api/' + route, {
    method,
    headers: {...bearer, ...headers},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers};
};

async function until(check, what) {
  for (let i = 0; i < 300; i++) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  assert.fail('not reached: ' + what);
}

/** Reads a Server-Sent Events stream and collects its data lines until `match` is satisfied. */
async function stream(base, controller) {
  const response = await fetch(base + '/api/events', {headers: bearer, signal: controller.signal});
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state = {text: ''};
  state.read = async match => {
    for (let i = 0; i < 200 && !match(state.text); i++) {
      const {value, done} = await reader.read();
      if (done) break;
      state.text += decoder.decode(value, {stream: true});
    }
    return state.text;
  };
  state.close = async () => {
    controller.abort();
    await reader.cancel().catch(() => {});
  };
  return state;
}

test('a conditional write is refused when the workflow changed since it was read', async () => {
  const {app, base, dir} = await start();
  try {
    await call(base, 'PUT', 'settings', {body: {developer_mode: true}});
    const project = (await call(base, 'POST', 'projects', {body: {name: 'Guarded'}})).body;
    const workflow = await call(base, 'GET', `projects/${project.id}/workflow`);
    const cursor = workflow.body.cursor;
    assert.equal(typeof cursor, 'number');
    const guarded = (name, x) =>
      call(base, 'POST', `projects/${project.id}/typed-nodes`, {
        body: {node_type: 'custom', config: {title: name, inputs: [], outputs: [{id: 'out', name: 'out', type: 'signal'}], op: 'on_run'}, position: {x, y: 0}},
        headers: {'If-Match': String(cursor)},
      });
    const [first, second] = await Promise.all([guarded('first', 0), guarded('second', 100)]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify([first, second]));
    const conflict = first.status === 409 ? first : second;
    assert.equal(conflict.body.error.code, 'conflict');
    assert.match(conflict.body.error.message, /changed since it was read/);
    const after = await call(base, 'GET', `projects/${project.id}/workflow`);
    assert.equal(after.body.nodes.length, 1, 'exactly one write was applied');
    assert.equal(after.body.cursor, cursor + 1);

    // Without If-Match the same two writes both apply: the server serialises them, so neither is lost.
    const make = (name, x) =>
      call(base, 'POST', `projects/${project.id}/typed-nodes`, {
        body: {node_type: 'custom', config: {title: name, inputs: [], outputs: [{id: 'out', name: 'out', type: 'signal'}], op: 'on_run'}, position: {x, y: 0}},
      });
    const [third, fourth] = await Promise.all([make('third', 200), make('fourth', 300)]);
    assert.equal(third.status, 200);
    assert.equal(fourth.status, 200);
    const final = await call(base, 'GET', `projects/${project.id}/workflow`);
    assert.equal(final.body.nodes.length, 3);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('each client has its own undo stack, and another client edit clears the stale one', async () => {
  const {app, base, dir} = await start();
  const client = id => ({[Protocol.CLIENT_HEADER]: id});
  try {
    await call(base, 'PUT', 'settings', {body: {developer_mode: true}});
    const project = (await call(base, 'POST', 'projects', {body: {name: 'Undo per client'}})).body;
    const make = (title, id, x) =>
      call(base, 'POST', `projects/${project.id}/typed-nodes`, {
        body: {
          node_type: 'custom',
          config: {title, inputs: [], outputs: [{id: 'out', name: 'out', type: 'signal'}], op: 'on_run'},
          position: {x, y: 0},
        },
        headers: client(id),
      });
    const snapshot = async id =>
      (await call(base, 'GET', `projects/${project.id}/workflow`, {headers: client(id)})).body;

    assert.equal((await make('A1', 'client-a', 0)).status, 200);
    let a = await snapshot('client-a'),
      b = await snapshot('client-b');
    assert.equal(a.history.undo, 1, 'the editor sees its own undo');
    assert.equal(b.history.undo, 0, 'the other editor has nothing to undo');

    // B edits: A's stack would now revert work A never saw, so it is dropped rather than applied.
    assert.equal((await make('B1', 'client-b', 100)).status, 200);
    a = await snapshot('client-a');
    b = await snapshot('client-b');
    assert.equal(a.history.undo, 0, 'a foreign edit cleared the stale stack');
    assert.equal(b.history.undo, 1);
    const undoA = await call(base, 'POST', `projects/${project.id}/undo`, {body: {}, headers: client('client-a')});
    assert.equal(undoA.body.undo, 0);
    assert.equal((await snapshot('client-a')).nodes.length, 2, 'nothing was reverted');

    // B's own undo is applied and removes only B's node.
    const undoB = await call(base, 'POST', `projects/${project.id}/undo`, {body: {}, headers: client('client-b')});
    assert.equal(undoB.body.undo, 0);
    const final = await snapshot('client-b');
    assert.deepEqual(final.nodes.map(node => node.config.title), ['A1']);
    assert.equal(final.history.undo, 0);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('two subscribed clients receive the same change, and neither receives it for the other server', async () => {
  const one = await start(),
    two = await start();
  const first = new AbortController(),
    second = new AbortController(),
    other = new AbortController();
  try {
    const [a, b, c] = await Promise.all([stream(one.base, first), stream(one.base, second), stream(two.base, other)]);
    await a.read(text => text.includes('"type":"ready"'));
    await b.read(text => text.includes('"type":"ready"'));
    await c.read(text => text.includes('"type":"ready"'));
    await call(one.base, 'POST', 'projects', {body: {name: 'Shared'}});
    await a.read(text => text.includes('"type":"change"'));
    await b.read(text => text.includes('"type":"change"'));
    assert.match(a.text, /"keys":\["projects"\]/);
    assert.match(b.text, /"keys":\["projects"\]/);
    // The second server has its own data and did not hear about the first server's write.
    await sleep(300);
    assert.equal(c.text.includes('"type":"change"'), false, 'no cross-server event');
    assert.deepEqual((await call(two.base, 'GET', 'projects')).body, []);
    assert.deepEqual((await call(one.base, 'GET', 'projects')).body.map(item => item.name), ['Shared']);
  } finally {
    await Promise.all([first.abort(), second.abort(), other.abort()]);
    await one.app.close();
    await two.app.close();
    fs.rmSync(one.dir, {recursive: true, force: true});
    fs.rmSync(two.dir, {recursive: true, force: true});
  }
});

test('one client stops work that a second client is watching', async () => {
  const {app, base, dir} = await start();
  try {
    await call(base, 'PUT', 'settings', {body: {developer_mode: true}});
    const project = (await call(base, 'POST', 'projects', {body: {name: 'Long work'}})).body;
    const query = {workflow_id: project.id};
    const startNode = (await call(base, 'POST', `projects/${project.id}/primitives`, {
      body: {...query, primitive: 'event', point: {x: 0, y: 0}},
    })).body;
    const slow = (await call(base, 'POST', `projects/${project.id}/primitives`, {
      body: {...query, primitive: 'script', point: {x: 100, y: 0}},
    })).body;
    await call(base, 'PUT', `projects/${project.id}/input-values`, {
      body: {...query, node_id: slow.id, values: {script: 'await node.sleep(3000); node.display("finished late");'}},
    });
    await call(base, 'POST', `projects/${project.id}/port-connections`, {
      body: {...query, add: [{source: startNode.id, source_port: 'out', target: slow.id, target_port: 'in'}]},
    });
    // Client A starts the work.
    const started = await call(base, 'POST', `projects/${project.id}/execution`, {body: {...query}});
    assert.equal(started.status, 200);
    // Client B sees the running state through the ordinary API.
    const running = await until(async () => {
      const detail = (await call(base, 'GET', `projects/${project.id}/execution?workflow_id=${project.id}`)).body;
      return detail.nodes?.some(node => node.node_id === slow.id && node.status === 'sleeping') ? detail : null;
    }, 'the second client sees the sleeping node');
    assert.equal(running.status === 'idle', false);
    // Client A stops it.
    assert.equal((await call(base, 'DELETE', `projects/${project.id}/execution?workflow_id=${project.id}`)).status, 200);
    // Client B sees the stop, and the work did not finish in the background.
    const stopped = await until(async () => {
      const detail = (await call(base, 'GET', `projects/${project.id}/execution?workflow_id=${project.id}`)).body;
      return detail.status === 'idle' ? detail : null;
    }, 'the stopped run is idle');
    assert.equal(JSON.stringify(stopped.displays || {}).includes('finished late'), false);
    await sleep(200);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a client reconnects after the server restarts and finds the same data, with no replayed run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-restart-'));
  let server = await start(dir);
  const controller = new AbortController();
  try {
    const project = (await call(server.base, 'POST', 'projects', {body: {name: 'Durable'}})).body;
    const projectId = project.id;
    const events = await stream(server.base, controller);
    await events.read(text => text.includes('"type":"ready"'));
    // The stream ends when the server goes away.
    await server.app.close();
    await events.read(() => false).catch(() => '');
    await events.close().catch(() => {});
    // Restart on the same folder; a client reconnects and sees the project.
    server = await start(dir);
    const projects = await call(server.base, 'GET', 'projects');
    assert.deepEqual(projects.body.map(item => item.name), ['Durable']);
    const execution = await call(server.base, 'GET', `projects/${projectId}/execution?workflow_id=${projectId}`);
    assert.equal(execution.body.status, 'idle', 'nothing restarts by itself');
    const again = new AbortController();
    const fresh = await stream(server.base, again);
    assert.match(await fresh.read(text => text.includes('"type":"ready"')), /"type":"ready"/);
    again.abort();
    await fresh.close().catch(() => {});
  } finally {
    await server.app.close().catch(() => {});
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a client that vanishes mid-run does not stop the work', async () => {
  const {app, base, dir} = await start();
  try {
    await call(base, 'PUT', 'settings', {body: {developer_mode: true}});
    const project = (await call(base, 'POST', 'projects', {body: {name: 'Unattended'}})).body;
    const query = {workflow_id: project.id};
    const startNode = (await call(base, 'POST', `projects/${project.id}/primitives`, {
      body: {...query, primitive: 'event', point: {x: 0, y: 0}},
    })).body;
    const slow = (await call(base, 'POST', `projects/${project.id}/primitives`, {
      body: {...query, primitive: 'script', point: {x: 100, y: 0}},
    })).body;
    await call(base, 'PUT', `projects/${project.id}/input-values`, {
      body: {...query, node_id: slow.id, values: {script: 'await node.sleep(400); node.display("done without its client");'}},
    });
    await call(base, 'POST', `projects/${project.id}/port-connections`, {
      body: {...query, add: [{source: startNode.id, source_port: 'out', target: slow.id, target_port: 'in'}]},
    });
    await call(base, 'POST', `projects/${project.id}/execution`, {body: {...query}});
    const finished = await until(async () => {
      const detail = (await call(base, 'GET', `projects/${project.id}/execution?workflow_id=${project.id}`)).body;
      return detail.status === 'idle' ? detail : null;
    }, 'the run finishes on its own');
    assert.match(Object.values(finished.displays || {}).join(' '), /done without its client/);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a collection record has its own version, and If-Match makes its writes conditional', async () => {
  const {app, base, dir} = await start();
  try {
    await call(base, 'PUT', 'collections/notes', {
      body: {title: 'Notes', schema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}},
    });
    const made = await call(base, 'POST', 'collections/notes/records', {body: {data: {text: 'one'}}});
    assert.equal(made.status, 200);
    assert.equal(made.body.version, 1);
    const id = made.body.id;
    const route = 'collections/notes/records/' + id;

    const first = await call(base, 'PUT', route, {body: {data: {text: 'two'}}, headers: {'If-Match': '1'}});
    assert.equal(first.status, 200);
    assert.equal(first.body.version, 2);

    const stale = await call(base, 'PUT', route, {body: {data: {text: 'lost'}}, headers: {'If-Match': '1'}});
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'conflict');
    assert.match(stale.body.error.message, /version is 2, not 1/);
    assert.equal((await call(base, 'GET', route)).body.data.text, 'two', 'the stale write changed nothing');

    // Without If-Match the write is last-one-wins, and the version still advances.
    const plain = await call(base, 'PUT', route, {body: {data: {text: 'three'}}});
    assert.equal(plain.status, 200);
    assert.equal(plain.body.version, 3);

    // Two writers that read version 3: one wins, one is told to read again.
    const [left, right] = await Promise.all([
      call(base, 'PUT', route, {body: {data: {text: 'left'}}, headers: {'If-Match': '3'}}),
      call(base, 'PUT', route, {body: {data: {text: 'right'}}, headers: {'If-Match': '3'}}),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [200, 409]);

    const bad = await call(base, 'PUT', route, {body: {data: {text: 'x'}}, headers: {'If-Match': 'soon'}});
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'invalid_request');

    const versionNow = (await call(base, 'GET', route)).body.version;
    const staleDelete = await call(base, 'DELETE', route, {headers: {'If-Match': '1'}});
    assert.equal(staleDelete.status, 409);
    assert.equal((await call(base, 'GET', route)).status, 200, 'the refused delete kept the record');
    const deleted = await call(base, 'DELETE', route, {headers: {'If-Match': String(versionNow)}});
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.version, versionNow);
    assert.equal((await call(base, 'GET', route)).status, 404);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
});

describe("exchange", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, fn} = require('./harness');
const TextGraph = require('../runtime/format');

test('graph import preserves empty group geometry and ignores execution state', async () => {
  const app = createApp();
  const p = await app.api('POST', 'projects', {name: 'Empty group exchange'});
  const path = `projects/${p.id}`;
  await app.api('PUT', path + '/groups', {groups: [{id: 'empty', name: 'Empty', members: [], parent: null,
    position: {x: 120, y: 240, width: 320, height: 180}}]});
  const packet = await app.api('GET', `${path}/workflows/${p.id}/export`);
  const decoded = TextGraph.decode(packet);
  assert.equal(decoded.document.runtime, undefined);
  decoded.document.runtime = {state: {shouldNotImport: true}};
  const target = await app.api('POST', path + '/workflows', {name: 'Destination'});
  await app.api('POST', path + '/import-graph', {workflow_id: target.id, graph: TextGraph.encode(decoded), point: {x: 500, y: 600}});
  const snap = await app.api('GET', path + '/workflow', {}, {workflow_id: target.id});
  assert.deepEqual(snap.groups[0].position, {x: 500, y: 600, width: 320, height: 180});
  assert.deepEqual((await app.api('GET', path + '/execution', {}, {workflow_id: target.id})).state, {});
  const created = await app.api('POST', path + '/workflows/import', TextGraph.encode({...decoded, name: 'Chosen name'}));
  assert.equal(created.name, 'Chosen name');
  assert.deepEqual((await app.api('GET', path + '/execution', {}, {workflow_id: created.id})).state, {});
});

test('graph import keeps Complex Node bindings, group sizes, widgets, styles and external wires', async () => {
  const app = createApp();
  const p = await app.api('POST', 'projects', {name: 'Complex exchange'}), path = `projects/${p.id}`;
  const source = await fn(app, p.id, {}, {name: 'Source', code: 'node.output.result=7;', outputs: ['result']});
  const target = await app.api('POST', path + '/typed-nodes', {node_type: 'custom',
    config: {title: 'Target', inputs: [{id: 'in', name: 'in'}], outputs: []}, position: {x: 700, y: 200}});
  await app.api('POST', path + '/port-connections', {add: [{source: source.wrapper, source_port: 'result', target: target.id, target_port: 'in'}]});
  const before = await app.api('GET', path + '/workflow');
  await app.api('PUT', path + '/groups', {groups: [
    ...before.groups.map(g => ({id:g.id,name:g.name,members:g.members,parent:'outer',position:g.position})),
    {id:'outer',name:'Outer',members:[target.id],parent:null,position:{x:-100,y:-80,width:1100,height:500}},
  ]});
  await app.api('PUT', path + '/node-style', {group_id:'outer',color:'#123456',pinned:true});
  await app.api('PUT', path + '/widgets/' + target.id, {widgets:[{id:'text',kind:'text',value:'kept'}]});
  const packet = await app.api('GET', `${path}/workflows/${p.id}/export`);
  const destination = await app.api('POST', path + '/workflows', {name:'Destination'});
  const paste = await app.api('POST', path + '/import-graph', {workflow_id:destination.id,graph:packet,point:{x:100,y:200}});
  const snap = await app.api('GET', path + '/workflow', {}, {workflow_id:destination.id});
  assert.equal(snap.complex.length,before.complex.length);
  const group = snap.groups.find(g=>g.name==='Outer');
  assert.deepEqual(group.position,{x:100,y:200,width:1100,height:500});
  assert.equal(group.pinned,true);assert.equal(group.color,'#123456');
  assert.equal(paste.roots.length,1);assert.equal(paste.roots[0],group.id);
  const wrapper = snap.complex[0];
  assert.equal(snap.groups.find(g=>g.id===wrapper.id).parent,group.id);
  for(const port of [...wrapper.interface.inputs,...wrapper.interface.outputs])
    for(const binding of port.bound??[]) assert.ok(wrapper.members.includes(binding.node_id));
  const pastedTarget = snap.nodes.find(n=>n.config?.title==='Target');
  assert.equal(snap.widgets[pastedTarget.id][0].value,'kept');
  assert.ok(snap.edges.some(e=>e.source==='complex:'+wrapper.id&&e.target===pastedTarget.id));
});
});

describe("soak", () => {
// Bounded execution, memory and resource-leak regression. All fixtures are temporary.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {createApiServer} = require('../server/api-server');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (samples, share) => {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] * 100) / 100;
};
const heap = () => {
  if (typeof global.gc === 'function') global.gc();
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
};
const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const resources = () => {
  const names = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
  return {
    handles: (typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : []).length,
    requests: (typeof process._getActiveRequests === 'function' ? process._getActiveRequests() : []).length,
    resources: names.length,
    listeners: typeof process.eventNames === 'function' ? process.eventNames().length : 0,
  };
};
const descriptors = () => {
  if (process.platform !== 'linux') return null;
  try {
    return require('node:fs').readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
};

/**
 * Runs the loop and returns a report. The caller owns `dataDir` when it passes one; otherwise a temporary folder
 * is created and removed. `onSample` sees every sample (used by tests to watch progress).
 */
async function runSoak({seconds = 60, dataDir = null, onSample = null} = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-soak-'));
  const app = createApiServer({dataDir: dir, token: 'soak-token'});
  const base = await app.listen(0);
  const headers = {Authorization: 'Bearer soak-token', 'Content-Type': 'application/json', 'X-AgentSys': '1'};
  const call = async (method, route, body) => {
    const startedAt = performance.now();
    const response = await fetch(base + '/api/' + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    report.request_ms.push(performance.now() - startedAt);
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : undefined;
  };
  const report = {
    seconds,
    cycles: 0,
    errors: 0,
    error_messages: [],
    run_ms: [],
    request_ms: [],
    heap_start_mb: heap(),
    heap_end_mb: 0,
    heap_max_mb: 0,
    rss_start_mb: rss(),
    rss_end_mb: 0,
    rss_max_mb: 0,
    handles_start: resources(),
    handles_end: null,
    handles_max: {handles: 0, requests: 0, resources: 0, listeners: 0},
    fds_start: descriptors(),
    fds_end: null,
    fds_max: 0,
    sessions: null,
    plugin_sessions: null,
    runtimes: null,
    client_streams: null,
    worker_start: null,
    running_runtimes: null,
    data_dir: dir,
  };
  const sampleHandles = () => {
    const now = resources();
    for (const key of Object.keys(report.handles_max)) report.handles_max[key] = Math.max(report.handles_max[key], now[key]);
    const fds = descriptors();
    if (fds !== null) report.fds_max = Math.max(report.fds_max, fds);
  };
  const deadline = Date.now() + seconds * 1000;
  try {
    await call('PUT', 'settings', {developer_mode: true});
    await call('PUT', 'collections/soak', {
      title: 'Soak',
      schema: {type: 'object', properties: {n: {type: 'integer'}}, additionalProperties: false},
    });
    while (Date.now() < deadline) {
      const cycle = report.cycles;
      try {
        const project = await call('POST', 'projects', {name: 'Soak ' + cycle});
        const query = {workflow_id: project.id};
        const event = await call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'event', point: {x: 0, y: 0}});
        const script = await call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'script', point: {x: 80, y: 0}});
        await call('PUT', `projects/${project.id}/input-values`, {
          ...query,
          node_id: script.id,
          values: {script: `node.display("cycle ${cycle}");`},
        });
        await call('POST', `projects/${project.id}/port-connections`, {
          ...query,
          add: [{source: event.id, source_port: 'out', target: script.id, target_port: 'in'}],
        });
        const started = performance.now();
        const run = await call('POST', `projects/${project.id}/execution`, {...query, wait: true});
        report.run_ms.push(performance.now() - started);
        if (Object.keys(run.errors || {}).length) throw new Error('run errors: ' + JSON.stringify(run.errors));
        const graph = await call('GET', `projects/${project.id}/workflow?workflow_id=${project.id}`);
        if (graph.nodes.length !== 2) throw new Error('graph read back with ' + graph.nodes.length + ' nodes');
        await call('POST', 'collections/soak/records', {data: {n: cycle}});
        await call('DELETE', `projects/${project.id}`);
        report.cycles++;
      } catch (error) {
        report.errors++;
        if (report.error_messages.length < 10) report.error_messages.push(String(error.message || error));
      }
      if (report.cycles % 10 === 0) heap(); // let the runtime collect between samples when --expose-gc is used
      const sample = heap();
      report.heap_max_mb = Math.max(report.heap_max_mb, sample);
      report.rss_max_mb = Math.max(report.rss_max_mb, rss());
      sampleHandles();
      if (onSample)
        onSample({cycle: report.cycles, heap_mb: sample, rss_mb: rss(), handles: resources(), report});
      await sleep(1);
    }
    const diagnostics = await call('GET', 'diagnostics');
    report.worker_start = diagnostics.workers;
    report.running_runtimes = diagnostics.runtime.running;
    report.plugin_sessions = diagnostics.plugin_sessions;
    report.sessions = diagnostics.sessions;
    report.client_streams = diagnostics.clients;
    report.runtimes = diagnostics.runtime.runtimes?.length ?? null;
  } finally {
    report.heap_end_mb = heap();
    report.heap_growth_mb = report.heap_end_mb - report.heap_start_mb;
    report.rss_end_mb = rss();
    report.rss_growth_mb = report.rss_end_mb - report.rss_start_mb;
    report.run_median_ms = percentile(report.run_ms, 0.5);
    report.run_p95_ms = percentile(report.run_ms, 0.95);
    report.request_median_ms = percentile(report.request_ms, 0.5);
    report.request_p95_ms = percentile(report.request_ms, 0.95);
    await app.close();
    // Give the HTTP client its idle sockets a moment to close before counting; a real leak stays above this.
    await sleep(250);
    report.handles_end = resources();
    report.fds_end = descriptors();
    if (!dataDir) fs.rmSync(dir, {recursive: true, force: true});
  }
  return report;
}


const test = require('node:test'),
  assert = require('node:assert/strict');

test('a short soak finishes with no error, no running runtime and bounded memory', {timeout: 120000}, async () => {
  const samples = [];
  const report = await runSoak({seconds: 8, onSample: sample => samples.push(sample)});
  assert.deepEqual(report.error_messages, []);
  assert.equal(report.errors, 0);
  assert.ok(report.cycles >= 5, `the loop made progress (${report.cycles} cycles)`);
  assert.equal(report.running_runtimes, 0, 'no runtime is left running');
  assert.ok(report.worker_start.started >= 1, 'the work really ran');
  assert.ok(report.heap_growth_mb < 64, `heap grew by ${report.heap_growth_mb} MB`);
  assert.ok(report.heap_max_mb < 256, `heap peaked at ${report.heap_max_mb} MB`);
  assert.ok(report.rss_growth_mb < 200, `RSS grew by ${report.rss_growth_mb} MB`);
  assert.ok(report.run_p95_ms < 2000, `run p95 ${report.run_p95_ms} ms`);
  assert.ok(report.request_p95_ms < 500, `request p95 ${report.request_p95_ms} ms`);
  assert.ok(report.runtimes === 0, `${report.runtimes} runtime(s) survived their deleted workflows`);
  assert.ok(report.handles_end.handles <= 12, `active handles stayed bounded (${report.handles_end.handles})`);
  assert.ok(report.handles_end.handles <= report.handles_max.handles, 'no handle outlived the peak sample');
  assert.ok(report.handles_max.listeners <= report.handles_start.listeners + 8, 'event listeners stayed bounded');
  assert.ok(samples.length >= report.cycles, 'the loop was sampled');
  assert.ok(samples.every(sample => Number.isFinite(sample.rss_mb) && sample.handles), 'memory and handles were sampled');
});
});

describe("storage-integrity", () => {
// Storage and data integrity: an interrupted multi-key commit, a file that was being written when the process
// ended, a corrupted JSON file, a copy of the data folder, the sidecar scripts of a workflow, and two servers on
// one folder. Every test uses a temporary data folder.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');

const TOKEN = 'storage-token';
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-storage-'));
  require('../server/file-store').checkStoreFormat(dir, {initialize: true});
  return dir;
};
const clean = dir => fs.rmSync(dir, {recursive: true, force: true});
const read = (dir, ...parts) => fs.readFileSync(path.join(dir, ...parts), 'utf8');
const exists = (dir, ...parts) => fs.existsSync(path.join(dir, ...parts));

test('an invalid percent escape in an unrelated filename cannot prevent startup or change scans', async () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'other'));
    fs.writeFileSync(path.join(dir, 'other', 'broken%ZZ.json'), '{}');
    const {createFileStore} = require('../server/file-store');
    const store = createFileStore(dir);
    store.commit({set: {projects: []}});
    assert.deepEqual(store.get('projects'), []);
    assert.deepEqual(await store.scan(), []);
    const {app} = await boot(dir);
    await app.close();
  } finally { clean(dir); }
});

test('a malformed redo or commit is rejected in full before any key is written', async () => {
  const {createFileStore} = require('../server/file-store');
  for (const invalid of [null, [], {set: []}, {remove: 'projects'}, {set: {projects: ['bad']}, remove: [5]}]) {
    const dir = tmp();
    try {
      const store = createFileStore(dir);
      assert.throws(() => store.commit(invalid), /Invalid storage/);
      assert.equal(store.get('projects'), undefined);
      fs.writeFileSync(path.join(dir, '.transaction.json'), JSON.stringify(invalid));
      const restored = createFileStore(dir);
      assert.equal(restored.get('projects'), undefined);
      assert.ok(exists(dir, '.transaction.json.invalid'));
    } finally { clean(dir); }
  }
});

const seedProjects = name => [{id: 'p1', name, workflows: [{id: 'w1', name: 'Flow'}]}];

/** Boots a server on the folder and returns {app, call} where call goes through the API without HTTP. */
async function boot(dir, options = {}) {
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  if (!app.api) throw new Error('the backend did not load');
  const call = async (method, route, body, query) => {
    const result = await app.api.request(method, route, {body: body ?? {}, query});
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  };
  return {app, call};
}

test('a commit interrupted after its redo record is replayed once at the next start', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(
      path.join(dir, '.transaction.json'),
      JSON.stringify({
        set: {
          projects: [{id: 'p1', name: 'replayed', description: '', created: 1, workflows: [{id: 'w1', name: 'Flow', created: 1}]}],
        },
        remove: [],
      })
    );
    const {app, call} = await boot(dir);
    try {
      const projects = await call('GET', 'projects');
      assert.deepEqual(projects.map(item => [item.id, item.name, item.workflow_count]), [['p1', 'replayed', 1]]);
      assert.equal(exists(dir, '.transaction.json'), false, 'the record is consumed');
      assert.match(read(dir, 'projects.json'), /replayed/);
    } finally {
      await app.close();
    }
    // Starting again applies nothing a second time.
    const again = await boot(dir);
    try {
      assert.deepEqual((await again.call('GET', 'projects')).map(item => item.name), ['replayed']);
    } finally {
      await again.app.close();
    }
  } finally {
    clean(dir);
  }
});

test('an unreadable commit record is set aside and the server starts on the data files', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(
      path.join(dir, 'projects.json'),
      JSON.stringify([{id: 'p1', name: 'kept', description: '', created: 1, workflows: []}])
    );
    fs.writeFileSync(path.join(dir, '.transaction.json'), '{not json');
    const {app, call} = await boot(dir);
    try {
      assert.deepEqual((await call('GET', 'projects')).map(item => item.name), ['kept']);
      assert.equal(exists(dir, '.transaction.json'), false);
      assert.equal(exists(dir, '.transaction.json.invalid'), true, 'kept for a person to inspect');
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('a commit record that names a path outside the folder writes nothing', async () => {
  const dir = tmp();
  try {
    const escape = path.join(path.dirname(dir), 'replayed-escape.json');
    fs.writeFileSync(
      path.join(dir, '.transaction.json'),
      JSON.stringify({set: {'../replayed-escape': {owned: true}}, remove: []})
    );
    const {app, call} = await boot(dir);
    try {
      assert.equal(fs.existsSync(escape), false, 'no file was written outside the data folder');
      assert.deepEqual(await call('GET', 'projects'), []);
      assert.equal(exists(dir, '.transaction.json.invalid'), true);
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('the temporary file of a write that never finished is ignored, not read as data', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(
      path.join(dir, 'projects.json'),
      JSON.stringify([{id: 'p1', name: 'real', description: '', created: 1, workflows: []}])
    );
    fs.writeFileSync(path.join(dir, 'projects.json.tmp-4242'), '{"half":');
    const {app, call} = await boot(dir);
    try {
      assert.deepEqual((await call('GET', 'projects')).map(item => item.name), ['real']);
      assert.ok(app.api.diagnostics().routes > 0);
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('a corrupted data file fails its own requests, not the server', async () => {
  const dir = tmp();
  let app;
  let base;
  try {
    app = createApiServer({dataDir: dir, token: TOKEN});
    base = await app.listen(0);
    const headers = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};
    await fetch(base + '/api/projects', {method: 'POST', headers, body: JSON.stringify({name: 'Fine'})});
    await app.close();
    // Corrupt the file while the server is stopped, so the next read cannot come from a cache.
    fs.writeFileSync(path.join(dir, 'projects.json'), '{"broken":');
    app = createApiServer({dataDir: dir, token: TOKEN});
    base = await app.listen(0);
    const broken = await fetch(base + '/api/projects', {headers});
    assert.equal(broken.status, 500);
    const body = await broken.json();
    assert.equal(body.error.code, 'internal');
    assert.equal(body.error.message.includes('at '), false, 'no stack trace');
    // The server is still alive and other families still answer.
    assert.equal((await fetch(base + '/api/meta')).status, 200);
    const diagnostics = await (await fetch(base + '/api/diagnostics', {headers})).json();
    assert.ok(diagnostics.recent_errors.some(entry => entry.status === 500));
    // Fixing the file (or restoring a copy) recovers: a restart reads the repaired folder.
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([]));
    await app.close();
    app = createApiServer({dataDir: dir, token: TOKEN});
    base = await app.listen(0);
    const fixed = await fetch(base + '/api/projects', {headers: {'Authorization': 'Bearer ' + TOKEN}});
    assert.equal(fixed.status, 200);
    assert.deepEqual(await fixed.json(), []);
  } finally {
    if (app) await app.close();
    clean(dir);
  }
});

test('a commit the folder cannot accept does not prevent the next start', async () => {
  const dir = tmp();
  let app;
  try {
    fs.writeFileSync(path.join(dir, 'other'), 'this file blocks the directory a key needs');
    app = createApiServer({dataDir: dir, token: TOKEN});
    let base = await app.listen(0);
    const headers = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};
    const failed = await fetch(base + '/api/collections/write-probe', {
      method: 'PUT',
      headers,
      body: JSON.stringify({title: 'Write probe'}),
    });
    assert.equal(failed.status, 500, 'the write fails, and reports it');
    assert.equal(exists(dir, '.transaction.json'), true, 'the redo record survives for diagnosis');
    await app.close();
    app = null;

    // Starting again must not retry the impossible write forever; the record is set aside and the server is usable.
    app = createApiServer({dataDir: dir, token: TOKEN});
    base = await app.listen(0);
    assert.equal((await fetch(base + '/api/meta')).status, 200);
    assert.equal((await fetch(base + '/api/projects', {headers})).status, 200);
    assert.equal(exists(dir, '.transaction.json'), false);
    assert.equal(exists(dir, '.transaction.json.invalid'), true);
  } finally {
    if (app) await app.close();
    clean(dir);
  }
});

test('a copy of a stopped data folder is a complete backup, including a pending redo record', async () => {
  const dir = tmp(),
    copy = tmp();
  try {
    let first = await boot(dir);
    await first.call('POST', 'projects', {name: 'Backed up'});
    const made = await first.call('POST', 'collections/notes/records', undefined).catch(error => error);
    assert.ok(made);
    await first.call('PUT', 'collections/notes', {
      title: 'Notes',
      schema: {type: 'object', properties: {text: {type: 'string'}}},
    });
    await first.call('POST', 'collections/notes/records', {data: {text: 'kept'}});
    await first.app.close();
    // The lock is gone with the process, so the folder is a plain directory to copy.
    assert.equal(exists(dir, '.server.lock'), false);
    fs.cpSync(dir, copy, {recursive: true});
    // A copy taken while a commit was in flight still carries its redo record: the copy becomes consistent.
    fs.writeFileSync(
      path.join(copy, '.transaction.json'),
      JSON.stringify({set: {'collection:notes': [
        {id: 'r1', data: {text: 'kept'}, created: 1, updated: 1, version: 1},
        {id: 'r2', data: {text: 'from the interrupted commit'}, created: 2, updated: 2, version: 1},
      ]}, remove: []})
    );
    const restored = await boot(copy);
    try {
      const projects = await restored.call('GET', 'projects');
      assert.deepEqual(projects.map(item => item.name), ['Backed up']);
      const records = await restored.call('GET', 'collections/notes/records');
      assert.deepEqual(records.records.map(record => record.data.text).sort(), ['from the interrupted commit', 'kept']);
    } finally {
      await restored.app.close();
    }
  } finally {
    clean(dir);
    clean(copy);
  }
});

test('parallel writes from one server never lose a record', async () => {
  const dir = tmp();
  try {
    const {app, call} = await boot(dir);
    try {
      await call('PUT', 'collections/events', {
        title: 'Events',
        schema: {type: 'object', properties: {n: {type: 'integer'}}, additionalProperties: false},
      });
      const writes = Array.from({length: 25}, (_, n) => call('POST', 'collections/events/records', {data: {n}}));
      const results = await Promise.all(writes);
      assert.equal(results.length, 25);
      const list = await call('GET', 'collections/events/records', undefined, {limit: 100});
      assert.equal(list.total, 25, 'every concurrent record is stored');
      assert.deepEqual([...new Set(list.records.map(record => record.data.n))].length, 25);
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('a workflow keeps its sidecar scripts, and changing the node removes the script it no longer uses', async () => {
  const dir = tmp();
  try {
    const {app, call} = await boot(dir);
    try {
      await call('PUT', 'settings', {developer_mode: true});
      const project = await call('POST', 'projects', {name: 'Sidecars'});
      const query = {workflow_id: project.id}; // a new project's first workflow has its id
      const made = await call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'script', point: {x: 10, y: 20}});
      // The code of a Script is the value of its `script` input; typing it stores it as a sidecar file.
      await call('PUT', `projects/${project.id}/input-values`, {
        ...query,
        node_id: made.id,
        values: {script: 'node.output.text = 1;'},
      });
      const scripts = path.join(dir, 'workflows', project.id + '.files', 'scripts');
      assert.equal(fs.existsSync(scripts), true, 'the script is a real sidecar file');
      const files = fs.readdirSync(scripts);
      assert.equal(files.length, 1, files.join(', '));
      assert.equal(fs.readFileSync(path.join(scripts, files[0]), 'utf8'), 'node.output.text = 1;');

      const snapshot = await call('GET', `projects/${project.id}/workflow`, undefined, query);
      const script = snapshot.nodes.find(node => node.config?.op === 'script');
      assert.ok(script, 'the graph reads back with its Script');
      const code = script.config.inputs.find(input => input.id === 'script').default;
      assert.equal(code, 'node.output.text = 1;');

      // Change the node into a value node: its code input is gone, so the sidecar file is removed.
      await call('PUT', `projects/${project.id}/typed-nodes/${script.id}`, {
        ...query,
        node_type: 'custom',
        config: {title: 'Value', inputs: [], outputs: [{id: 'result', name: 'result'}]},
      });
      assert.deepEqual(fs.readdirSync(scripts), [], 'the unused script file is deleted');
      const again = await call('GET', `projects/${project.id}/workflow`, undefined, query);
      const value = again.nodes.find(node => node.id === script.id);
      assert.equal(value.config.title, 'Value');
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('one data folder belongs to one server process; a stale lock is taken over', async () => {
  const dir = tmp();
  const first = createApiServer({dataDir: dir, token: TOKEN});
  try {
    assert.equal(exists(dir, '.server.lock'), true);
    assert.throws(() => createApiServer({dataDir: dir, token: TOKEN}), /in use by another AgentSys server/);
    // A lock whose process no longer exists is stale: the folder is taken over.
    await first.close();
    assert.equal(exists(dir, '.server.lock'), false, 'closing releases the folder');
    fs.writeFileSync(path.join(dir, '.server.lock'), JSON.stringify({pid: 999999, at: new Date().toISOString()}));
    const second = createApiServer({dataDir: dir, token: TOKEN});
    try {
      const holder = JSON.parse(read(dir, '.server.lock'));
      assert.equal(holder.pid, process.pid);
    } finally {
      await second.close();
    }
    // Sharing is possible deliberately, and is then the operator's responsibility.
    const shared = createApiServer({dataDir: dir, token: TOKEN, allowSharedData: true});
    const sharedToo = createApiServer({dataDir: dir, token: TOKEN, allowSharedData: true});
    await shared.close();
    await sharedToo.close();
  } finally {
    await first.close().catch(() => {});
    clean(dir);
  }
});

test('a deleted workflow does not leave its script folder behind', async () => {
  const dir = tmp();
  try {
    const {app, call} = await boot(dir);
    try {
      const project = await call('POST', 'projects', {name: 'Delete me'});
      const workflow = await call('POST', `projects/${project.id}/workflows`, {name: 'Second'});
      // A workflow with no nodes stores no script folder at all.
      assert.equal(exists(dir, 'workflows', `${workflow.id}.files`, 'scripts'), false);
      await call('DELETE', `projects/${project.id}/workflows/${workflow.id}`);
      assert.equal(exists(dir, 'workflows', `${workflow.id}.json`), false);
      assert.equal(exists(dir, 'workflows', `${workflow.id}.files`), false);
    } finally {
      await app.close();
    }
  } finally {
    clean(dir);
  }
});

test('record revisions survive restart and reject stale conditional writes', async () => {
  const dir = tmp();
  try {
    const first = await boot(dir);
    await first.call('PUT', 'collections/notes', {schema: {type: 'object'}});
    const record = await first.call('POST', 'collections/notes/records', {data: {text: 'first'}});
    await first.app.close();
    const {app, call} = await boot(dir);
    try {
      const written = await call('PUT', 'collections/notes/records/' + record.id, {data: {text: 'next'}}, {if_version: '1'});
      assert.equal(written.version, 2);
      await assert.rejects(call('PUT', 'collections/notes/records/' + record.id, {data: {}}, {if_version: '1'}), {code: 'conflict'});
    } finally { await app.close(); }
  } finally { clean(dir); }
});

test('undo history is per process: a restart keeps the document but not the history', async () => {
  const dir = tmp();
  let first;
  try {
    first = await boot(dir);
    await first.call('PUT', 'settings', {developer_mode: true});
    const project = await first.call('POST', 'projects', {name: 'Undo across restart'});
    const query = {workflow_id: project.id};
    await first.call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'event', point: {x: 0, y: 0}});
    const before = await first.call('GET', `projects/${project.id}/workflow`, undefined, query);
    assert.equal(before.nodes.length, 1);
    assert.equal(before.history.undo >= 1, true, 'the edit is in the in-memory history');
    await first.app.close();
    first = null;

    const second = await boot(dir);
    try {
      const after = await second.call('GET', `projects/${project.id}/workflow`, undefined, query);
      assert.equal(after.nodes.length, 1, 'the document is durable');
      const undone = await second.call('POST', `projects/${project.id}/undo`, undefined, query);
      assert.deepEqual(undone, {undo: 0, redo: 0}, 'the history did not survive the restart');
      assert.equal((await second.call('GET', `projects/${project.id}/workflow`, undefined, query)).nodes.length, 1);
    } finally {
      await second.app.close();
    }
  } finally {
    if (first) await first.app.close().catch(() => {});
    clean(dir);
  }
});
});

describe("store-format", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createApiServer} = require('../server/api-server');
const {checkStoreFormat, FORMAT, MARKER} = require('../server/file-store');

test('a new store is marked and can be reopened', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-format-'));
  try {
    const first = createApiServer({dataDir: dir});
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, MARKER))).format, FORMAT);
    await first.close();
    const next = createApiServer({dataDir: dir});
    await next.close();
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('unmarked and unsupported stores are refused before any file changes', () => {
  for (const marker of [null, '{broken', JSON.stringify({format: 'agentsys.store/2'})]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-format-'));
    try {
      fs.writeFileSync(path.join(dir, 'projects.json'), '[{"id":"keep"}]');
      if (marker !== null) fs.writeFileSync(path.join(dir, MARKER), marker);
      const snapshot = () => Object.fromEntries(fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name), 'hex')]));
      const before = snapshot();
      assert.throws(() => checkStoreFormat(dir, {initialize: true}), {code: 'unsupported_storage'});
      assert.throws(() => createApiServer({dataDir: dir}), {code: 'unsupported_storage'});
      assert.deepEqual(snapshot(), before);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});
});
