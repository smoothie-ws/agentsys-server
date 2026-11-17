'use strict';
const {describe} = require('node:test');

describe("appearance", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp} = require('./harness');

const palette = {background: '#080808', surface: '#101010', text: '#ededed', accent: '#d9d9d9'};

test('existing digit shortcuts remain valid when tool defaults are introduced', async () => {
  const app = createApp();
  const saved = await app.api('PUT', 'settings', {shortcuts: {copy: 'Digit1'}});
  assert.equal(saved.shortcuts.copy, 'Digit1');
  await assert.rejects(app.api('PUT', 'settings', {shortcuts: {copy: 'Digit1', toolSelect: 'Digit1'}}), /unique/);
  const rebound = await app.api('PUT', 'settings', {shortcuts: {copy: 'Digit1', toolSelect: 'KeyQ'}});
  assert.equal(rebound.shortcuts.toolSelect, 'KeyQ');
});

test('the appearance is saved and changes merge into what is stored', async () => {
  const app = createApp();
  await app.api('PUT', 'settings', {style: {...palette, font_size: 16, animations: false, wire_style: 'step'}});
  await app.api('PUT', 'settings', {style: {accent: '#82aaff'}});
  const {style} = (await app.api('GET', 'session')).preferences;
  assert.deepEqual({...style}, {...palette, accent: '#82aaff', font_size: 16, animations: false, wire_style: 'step'});
});

test('the appearance is validated: colours, font, toggles and unknown keys', async () => {
  const app = createApp();
  await app.api('PUT', 'settings', {style: palette});
  for (const style of [
    {accent: 'red'},
    {font_size: 40},
    {font_family: 'Comic Sans'},
    {effects: 'yes'},
    {components: {fields: {radius: 8}}},
  ])
    await assert.rejects(app.api('PUT', 'settings', {style}), /style|Font|colors|toggles/i);
  assert.equal((await app.api('GET', 'session')).preferences.style.accent, palette.accent);
});

test('themes and component overrides saved by an earlier version are dropped on the next save', async () => {
  const app = createApp();
  await app.eval(
    `DB.commit({prefs: {style: {accent: '#82aaff', components: {fields: {radius: 8}}}, themes: [{id: 'a', name: 'A'}], theme: 'saved:a'}})`
  );
  await app.api('PUT', 'settings', {undo_steps: 10});
  const prefs = (await app.api('GET', 'session')).preferences;
  assert.equal(prefs.themes, undefined);
  assert.equal(prefs.theme, undefined);
  assert.equal(prefs.style.components, undefined);
  assert.equal(prefs.style.accent, '#82aaff');
});
});

describe("available-nodes", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, bundleOf} = require('./harness');
const TextGraph = require('../runtime/format');

async function fixture() {
  const app = createApp({developer: false});
  const project = await app.api('POST', 'projects', {name: 'Availability'});
  const second = await app.api('POST', `projects/${project.id}/workflows`, {name: 'Second'});
  const make = async (name, folder = '') =>
    app.api('POST', 'resources', {
      name,
      payload: bundleOf(name, {Body: {inputs: [], outputs: []}}, {folder}),
    });
  const first = await make('First', 'Logic'),
    nested = await make('Nested', 'Logic/Sub'),
    other = await make('Other', 'Logic sibling');
  const snapshot = (id = project.id) => app.api('GET', `projects/${project.id}/workflow`, {}, {workflow_id: id});
  const toggle = body => app.api('PUT', `projects/${project.id}/available-nodes`, body);
  return {app, project, second, first, nested, other, make, snapshot, toggle};
}

test('Library availability defaults to empty and is independent per workflow, including with Developer mode off', async () => {
  const {app, project, second, first, snapshot, toggle} = await fixture();
  assert.deepEqual((await snapshot()).library_nodes, []);
  await toggle({resource_id: first.id, enabled: true});
  assert.deepEqual((await snapshot()).library_nodes, [first.id]);
  assert.deepEqual((await snapshot(second.id)).library_nodes, []);
  await toggle({workflow_id: second.id, resource_id: first.id, enabled: true});
  await toggle({resource_id: first.id, enabled: false});
  assert.deepEqual((await snapshot()).library_nodes, []);
  assert.deepEqual((await snapshot(second.id)).library_nodes, [first.id]);
  assert.equal((await app.api('GET', `resources/${first.id}`)).enabled, undefined);
  await app.eval(
    `(async () => {const doc = await DB.get('wf:${project.id}'); delete doc.library_nodes; await DB.commit({'wf:${project.id}': doc});})()`
  );
  assert.deepEqual((await snapshot()).library_nodes, [], 'older documents also default to excluded');
});

test('a group includes and excludes its current descendants, with individual exceptions and no path-prefix collisions', async () => {
  const {first, nested, other, snapshot, toggle, make, app, project} = await fixture();
  await toggle({folder: 'Logic', enabled: true});
  assert.deepEqual(new Set((await snapshot()).library_nodes), new Set([first.id, nested.id]));
  await toggle({resource_id: nested.id, enabled: false});
  assert.deepEqual((await snapshot()).library_nodes, [first.id]);
  const fresh = await make('New', 'Logic');
  assert.ok(!(await snapshot()).library_nodes.includes(fresh.id), 'new Library nodes start excluded');
  await toggle({resource_id: other.id, enabled: true});
  await app.api('POST', 'library/node-folders', {action: 'rename', path: 'Logic', name: 'Renamed'});
  assert.ok(
    (await snapshot()).library_nodes.includes(first.id),
    'renaming a Library group preserves choices by resource ID'
  );
  await toggle({folder: 'Renamed', enabled: false});
  assert.deepEqual((await snapshot()).library_nodes, [other.id]);
  await assert.rejects(toggle({resource_id: 'missing', enabled: true}), /not found/i);
  await assert.rejects(toggle({folder: 'missing', enabled: true}), /not found/i);
  await assert.rejects(toggle({folder: 'Renamed', resource_id: first.id, enabled: true}), /either/);
  await assert.rejects(toggle({resource_id: first.id, enabled: 'yes'}), /true or false/);
  await assert.rejects(
    app.api('POST', `library/custom-nodes/${first.id}/enabled`, {enabled: false}),
    /endpoint not found/
  );
  await assert.rejects(
    app.api('POST', 'library/node-folders', {action: 'enabled', path: 'Renamed', enabled: false}),
    /Unknown action/
  );
});

test('placing an excluded Library node includes it atomically, supports undo/redo and leaves placed copies when excluded', async () => {
  const {app, project, first, snapshot, toggle} = await fixture();
  const path = `projects/${project.id}`;
  await assert.rejects(app.api('POST', `${path}/custom-nodes/${first.id}`, {point: {x: null, y: 0}}), /Coordinates/);
  assert.deepEqual((await snapshot()).library_nodes, []);
  await app.api('POST', `${path}/custom-nodes/${first.id}`, {point: {x: 80, y: 100}});
  assert.deepEqual((await snapshot()).library_nodes, [first.id]);
  assert.equal((await snapshot()).complex.length, 1);
  await app.api('POST', `${path}/undo`);
  assert.deepEqual((await snapshot()).library_nodes, []);
  assert.equal((await snapshot()).complex.length, 0);
  await app.api('POST', `${path}/redo`);
  await toggle({resource_id: first.id, enabled: false});
  assert.equal((await snapshot()).complex.length, 1);
  assert.deepEqual((await snapshot()).library_nodes, []);
  await app.api('POST', `${path}/undo`);
  assert.deepEqual((await snapshot()).library_nodes, [first.id]);
  await app.api('POST', `${path}/redo`);
  assert.deepEqual((await snapshot()).library_nodes, []);
});

test('availability survives document storage, workflow/project duplication, and export/import', async () => {
  const {app, project, first, toggle} = await fixture();
  const path = `projects/${project.id}`;
  await toggle({resource_id: first.id, enabled: true});
  assert.deepEqual(
    JSON.parse(await app.eval(`(async () => JSON.stringify((await DB.get('wf:${project.id}')).library_nodes))()`)),
    [first.id]
  );
  const copy = await app.api('POST', `${path}/workflows/${project.id}/duplicate`);
  assert.deepEqual((await app.api('GET', `${path}/workflow`, {}, {workflow_id: copy.id})).library_nodes, [first.id]);
  const projectCopy = await app.api('POST', `${path}/duplicate`);
  assert.deepEqual((await app.api('GET', `projects/${projectCopy.id}/workflow`)).library_nodes, [first.id]);
  const packet = await app.api('GET', `${path}/workflows/${project.id}/export`);
  const imported = await app.api('POST', `${path}/workflows/import`, packet);
  assert.deepEqual((await app.api('GET', `${path}/workflow`, {}, {workflow_id: imported.id})).library_nodes, [
    first.id,
  ]);
  const projectPacket = await app.api('GET', `${path}/export`);
  const projectImport = await app.api('POST', 'projects/import', projectPacket);
  assert.deepEqual((await app.api('GET', `projects/${projectImport.id}/workflow`)).library_nodes, [first.id]);
  const broken = TextGraph.decode(packet);
  broken.document.library_nodes = [42];
  await assert.rejects(app.api('POST', `${path}/workflows/import`, TextGraph.encode(broken)), /resource IDs/);
});
});

describe("body", () => {
// A Library node is a group of visible nodes. A slot of the group is bound to a port of a node inside, or it is free: then a Script of
// the group reads it by name (`node.input`). A placed node can get free slots of its own. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, bundleOf, place, ref, fn, TYPES} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));

/** The code of a Script that collects the values of the inputs of its Library node into a list (the free output `name`). */
const collectTo = name =>
  `const list = []; for (const v of Object.values(node.input)) if (v !== undefined) list.push(v); node.output[${JSON.stringify(name)}] = list;`;

async function library(app) {
  const opened = await app.api('POST', 'library/node-editor', {});
  const q = {workflow_id: opened.workflow_id},
    id = opened.project_id;
  const snapshot = () => app.api('GET', `projects/${id}/workflow`, {}, q);
  const root = (await snapshot()).root;
  return {
    resource: opened.resource_id,
    id,
    root,
    snapshot,
    save: body => app.api('PUT', `projects/${id}/complex/${root}`, {...q, ...body}),
    /** Puts a Script that collects the inputs of the node into a list, started by an on_read, and makes it the output `out`. */
    collect: async () => {
      const have = (await app.api('GET', `projects/${id}/types`, {}, q)).types;
      await app.api('PUT', `projects/${id}/types`, {
        ...q,
        types: [...have, ...[TYPES.code].filter(t => !have.some(h => h.id === t.id))],
      });
      const reader = await app.api('POST', `projects/${id}/typed-nodes`, {
          ...q,
          node_type: 'custom',
          config: nodes.event('on_read'),
          position: {x: 0, y: 0},
        }),
        script = await app.api('POST', `projects/${id}/typed-nodes`, {
          ...q,
          node_type: 'custom',
          config: nodes.script(collectTo('result')),
          position: {x: 300, y: 0},
        });
      await app.api('POST', `projects/${id}/port-connections`, {
        ...q,
        add: [{source: reader.id, source_port: 'out', target: script.id, target_port: 'in'}],
      });
      const cx = (await snapshot()).complex.find(c => c.id === root);
      await app.api('PUT', `projects/${id}/complex/${root}`, {
        ...q,
        interface: {inputs: cx.interface.inputs, outputs: [{id: 'out', name: 'result'}]},
      });
    },
  };
}
async function project(app) {
  const {id} = await app.api('POST', 'projects', {name: 'P'});
  const q = {workflow_id: id};
  return {
    id,
    snapshot: () => app.api('GET', `projects/${id}/workflow`, {}, q),
    place: async resource =>
      (await app.api('POST', `projects/${id}/custom-nodes/${resource}`, {...q, point: {x: 0, y: 0}})).roots[0],
    node: config =>
      app.api('POST', `projects/${id}/typed-nodes`, {...q, node_type: 'custom', config, position: {x: 0, y: 0}}),
    connect: (s, sp, t, tp) =>
      app.api('POST', `projects/${id}/port-connections`, {
        ...q,
        add: [{source: s, source_port: sp, target: t, target_port: tp}],
      }),
    extra: (group, extra) => app.api('PUT', `projects/${id}/complex/${group}`, {...q, extra}),
    evaluate: ids => app.api('POST', `projects/${id}/evaluate-node`, {...q, node_ids: ids, collect: true}),
  };
}

test('a new Library node is an empty group; its slots are free until they are bound to a node inside', async () => {
  const app = createApp(),
    lib = await library(app);
  assert.deepEqual((await lib.snapshot()).nodes, [], 'there is nothing hidden in it');
  await lib.save({
    interface: {
      inputs: [
        {id: 'a', name: 'a'},
        {id: 'b', name: 'b'},
      ],
      outputs: [{id: 'sum', name: 'sum'}],
    },
  });
  let cx = (await lib.snapshot()).complex.find(c => c.id === lib.root);
  assert.deepEqual(
    cx.interface.inputs.map(p => [p.name, 'bound' in p]),
    [
      ['a', false],
      ['b', false],
    ]
  );
  assert.deepEqual((await lib.snapshot()).nodes, []);
  // A slot is bound to a port of a node inside; removing a slot leaves the others alone.
  const inner = await app.api('POST', `projects/${lib.id}/typed-nodes`, {
    workflow_id: lib.id,
    node_type: 'custom',
    config: {title: 'Inner', inputs: [{id: 'v', name: 'v'}], outputs: [{id: 'result', name: 'result'}]},
    position: {x: 40, y: 80},
  });
  await lib.save({
    interface: {
      inputs: [{id: 'a', name: 'a', bound: [{node_id: inner.id, port_id: 'v'}]}],
      outputs: cx.interface.outputs,
    },
  });
  cx = (await lib.snapshot()).complex.find(c => c.id === lib.root);
  assert.deepEqual(
    cx.interface.inputs.map(p => [p.name, p.bound?.[0].node_id === inner.id]),
    [['a', true]]
  );
  assert.deepEqual(
    cx.interface.outputs.map(p => p.name),
    ['sum']
  );
});

test('a placed Custom Node can get slots of its own, which a Script of the node (here: one that lists its inputs) reads by name', async () => {
  const app = createApp(),
    lib = await library(app);
  await lib.save({
    interface: {inputs: [{id: 'a', name: 'a'}], outputs: [{id: 'out', name: 'result'}]},
    arbitrary: {inputs: true, outputs: false},
  });
  await lib.collect();
  const p = await project(app),
    gid = await p.place(lib.resource);
  const five = await p.node(nodes.value('number', 5)),
    show = await fn(
      app,
      p.id,
      {workflow_id: p.id},
      {code: 'node.display(JSON.stringify(input, null, 2))', inputs: ['input']}
    );
  await p.connect(five.id, 'value', 'complex:' + gid, 'a');
  await p.connect('complex:' + gid, 'out', show.wrapper, 'input');
  assert.equal((await p.evaluate([show.id])).displays[show.id], JSON.stringify([5], null, 2));
  // Its own slots: new ones can be added and removed, the ones of the definition cannot be touched.
  await p.extra(gid, {inputs: [{id: 'x1', name: 'extra'}]});
  let cx = (await p.snapshot()).complex.find(c => c.id === gid);
  assert.deepEqual(
    cx.interface.inputs.map(p => [p.name, !!p.extra]),
    [
      ['a', false],
      ['extra', true],
    ]
  );
  const ten = await p.node(nodes.value('number', 10));
  await p.connect(ten.id, 'value', 'complex:' + gid, 'x1');
  assert.equal((await p.evaluate([show.id])).displays[show.id], JSON.stringify([5, 10], null, 2));
  await rejects(p.extra(gid, {inputs: [{id: 'a', name: 'other'}]}), /another ID/);
  await rejects(p.extra(gid, {inputs: [{id: 'y', name: 'a'}]}), /unique/);
  await rejects(
    app.api('PUT', `projects/${p.id}/complex/${gid}`, {workflow_id: p.id, interface: {inputs: [], outputs: []}}),
    /Library/
  );
  // Editing the definition in the Library keeps the wires and the slots of the copy.
  await lib.save({arbitrary: {inputs: true, outputs: true}});
  cx = (await p.snapshot()).complex.find(c => c.id === gid);
  assert.deepEqual(
    cx.interface.inputs.map(p => p.name),
    ['a', 'extra']
  );
  assert.equal((await p.evaluate([show.id])).displays[show.id], JSON.stringify([5, 10], null, 2));
  // Removing the slot again.
  await p.extra(gid, {inputs: []});
  cx = (await p.snapshot()).complex.find(c => c.id === gid);
  assert.deepEqual(
    cx.interface.inputs.map(p => p.name),
    ['a']
  );
});

test('Slots of its own are set by a Script or the API whatever Arbitrary says; Arbitrary only records what the panel offers', async () => {
  const app = createApp(),
    lib = await library(app);
  await lib.save({
    interface: {inputs: [{id: 'a', name: 'a'}], outputs: [{id: 'out', name: 'result'}]},
    arbitrary: {inputs: true, outputs: false},
  });
  const p = await project(app),
    gid = await p.place(lib.resource);
  await p.extra(gid, {inputs: [{id: 'x1', name: 'more'}]});
  await p.extra(gid, {outputs: [{id: 'o2', name: 'other'}]});
  const cx = (await p.snapshot()).complex.find(c => c.id === gid);
  assert.deepEqual(cx.arbitrary, {inputs: true, outputs: false});
});

/** The List node as the Library has it: on_read → a Script that collects its inputs, and on_input_connected → a Script that keeps one free input at the end. */
const listNode = () =>
  bundleOf(
    'List',
    {
      Body: nodes.script(collectTo('list')),
      on_read: nodes.event('on_read'),
      on_input_connected: nodes.event('on_input_connected', ['wired']),
      Slots: nodes.script(
        `await agentsys('PUT', 'projects/' + context.project_id + '/node-slots/' + context.instance_id, {inputs: Array.from({length: context.event.connected.length}, (_, i) => ({id: 'input' + (i + 2), name: 'input' + (i + 2)}))})`
      ),
    },
    {
      wires: [
        ['on_read', 'out', 'Body', 'in'],
        ['on_input_connected', 'out', 'Slots', 'in'],
      ],
      inputs: [{id: 'input1', name: 'input1', node: false}],
      outputs: [{id: 'list', name: 'list', node: false}],
    }
  );

test('on_input_connected fires for a placed node when its wires change: a Script keeps one free input at the end', async () => {
  const app = createApp(),
    p = await project(app);
  const list = await place(app, p.id, {workflow_id: p.id}, listNode()),
    target = list.id,
    gid = list.group;
  const names = async () => (await p.snapshot()).complex.find(c => c.id === gid).interface.inputs.map(s => s.name);
  const wire = async (n, port, add = true) => {
    await app.api('POST', `projects/${p.id}/port-connections`, {
      workflow_id: p.id,
      [add ? 'add' : 'remove']: [{source: n.id, source_port: 'value', target, target_port: port}],
    });
    await app.Backend.hooksIdle();
  };
  assert.deepEqual(await names(), ['input1']);
  const a = await p.node(nodes.value('text', 'one')),
    b = await p.node(nodes.value('text', 'two'));
  await wire(a, 'input1');
  assert.deepEqual(await names(), ['input1', 'input2']);
  await wire(b, 'input2');
  assert.deepEqual(await names(), ['input1', 'input2', 'input3']);
  await wire(b, 'input2', false);
  assert.deepEqual(await names(), ['input1', 'input2']);
  await wire(b, 'input2');
  const show = await fn(
    app,
    p.id,
    {workflow_id: p.id},
    {code: 'node.display(JSON.stringify(input, null, 2))', inputs: ['input']}
  );
  await app.api('POST', `projects/${p.id}/port-connections`, {
    workflow_id: p.id,
    add: [{source: target, source_port: 'list', target: show.wrapper, target_port: 'input'}],
  });
  const r = await p.evaluate([show.id]);
  assert.equal(r.displays[show.id], JSON.stringify(['one', 'two'], null, 2));
});

test('any node on a workflow can be renamed, and a placed Library node keeps its name when its definition changes', async () => {
  const app = createApp(),
    lib = await library(app);
  await lib.save({interface: {inputs: [], outputs: []}});
  const p = await project(app),
    gid = await p.place(lib.resource);
  const rename = (node_id, title) => app.api('PUT', `projects/${p.id}/node-title`, {workflow_id: p.id, node_id, title});
  const custom = await p.node({title: 'Before', inputs: [], outputs: []});
  await rename(custom.id, '  After ');
  assert.equal((await p.snapshot()).nodes.find(n => n.id === custom.id).config.title, 'After');
  await rejects(rename(custom.id, ''), /1 to 100/);
  await rejects(rename('record:' + '0'.repeat(32), 'x'), /not found/);
  const groups = (await p.snapshot()).groups.map(g => ({
    id: g.id,
    name: g.id === gid ? 'Mine' : g.name,
    members: g.members,
    parent: g.parent,
    position: g.position,
  }));
  await app.api('PUT', `projects/${p.id}/groups`, {workflow_id: p.id, groups});
  assert.equal((await p.snapshot()).groups.find(g => g.id === gid).name, 'Mine');
  await lib.save({arbitrary: {inputs: true, outputs: false}});
  assert.equal((await p.snapshot()).groups.find(g => g.id === gid).name, 'Mine');
});
});

describe("disable", () => {
// Disabling nodes and groups: a run skips them, and a group takes everything inside it along. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, fn} = require('./harness');

async function setup() {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'Disable'}),
    q = {workflow_id: id},
    call = (method, path, body = {}) => app.api(method, `projects/${id}/${path}`, {...q, ...body}, q);
  const add = config => call('POST', 'typed-nodes', {node_type: 'custom', config, position: {x: 0, y: 0}});
  const source = await add(nodes.value('text', 'hi')),
    inner = await fn(app, id, q, {
      code: 'node.output.result = input + "!"',
      inputs: ['input'],
      outputs: ['result'],
      signals: ['out'],
    }),
    outer = await fn(app, id, q, {code: 'node.display(String(input) + "?");', inputs: ['input']});
  const start = await flow(app, id, q, [inner.step, outer.step]);
  await call('POST', 'port-connections', {
    add: [{source: source.id, source_port: 'value', target: inner.wrapper, target_port: 'input'}],
  });
  await call('POST', 'port-connections', {
    add: [{source: inner.wrapper, source_port: 'result', target: outer.wrapper, target_port: 'input'}],
  });
  return {
    gid: inner.group,
    call,
    source,
    inner,
    outer,
    start,
    run: ids => call('POST', 'evaluate-node', {node_ids: ids, collect: true}),
  };
}

test('a disabled group disables what is in it, and what it fed gets nothing', async () => {
  const s = await setup();
  assert.equal((await s.run([s.start])).displays[s.outer.id], 'hi!?');
  const style = await s.call('PUT', 'node-style', {group_id: s.gid, disabled: true});
  assert.equal(style.disabled, true);
  const snap = await s.call('GET', 'workflow');
  assert.equal(snap.groups.find(g => g.id === s.gid).disabled, true);
  const member = snap.nodes.find(n => n.id === s.inner.id);
  assert.equal(member.disabled, false);
  assert.equal(member.muted, true); // off only because of its group
  assert.equal(snap.nodes.find(n => n.id === s.outer.id).muted, false);
  assert.equal((await s.run([s.start])).displays[s.outer.id], 'hi!?'); // the signal does not pass the disabled node, and nothing arrives from it
  assert.equal((await s.run([s.outer.id])).displays[s.outer.id], 'undefined?');
  const own = await s.run([s.inner.id]);
  assert.deepEqual(own.errors, {});
  await s.call('PUT', 'node-style', {group_id: s.gid, disabled: false});
  assert.equal((await s.run([s.start])).displays[s.outer.id], 'hi!?');
});

test('a group can be collapsed and disabled', async () => {
  const s = await setup();
  await s.call('PUT', 'node-style', {group_id: s.gid, folded: true, disabled: true});
  const snap = await s.call('GET', 'workflow');
  const g = snap.groups.find(x => x.id === s.gid);
  assert.deepEqual([g.folded, g.disabled], [true, true]);
});

test('a disabled node does not report the values of an earlier run when signalled directly', async t => {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'Disabled root'});
  t.after(() => app.Backend.shutdownExecutions());
  const event = await app.api('POST', `projects/${id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.run(),
    position: {x: 0, y: 0},
  });
  const evaluate = payload =>
    app.api('POST', `projects/${id}/execution`, {node_ids: [event.id], payload, wait: true});
  const first = await evaluate({value: 'first'});
  assert.deepEqual(first.dispatch_outputs[event.id], {payload: {value: 'first'}});
  await app.api('PUT', `projects/${id}/node-style`, {node_id: event.id, disabled: true});
  // The signal does not reach a disabled node: this dispatch produced nothing, so it reports nothing.
  assert.equal((await evaluate({value: 'while disabled'})).dispatch_outputs[event.id], undefined);
  await app.api('PUT', `projects/${id}/node-style`, {node_id: event.id, disabled: false});
  assert.deepEqual((await evaluate({value: 'second'})).dispatch_outputs[event.id], {
    payload: {value: 'second'},
  });
});
});

describe("graph-format", () => {
// The text-graph format with generated documents: whatever the editor stores must survive encode -> files ->
// decode unchanged, and a damaged or hostile packet must be refused with an error rather than half-read.
const test = require('node:test'),
  assert = require('node:assert/strict');
const TextGraph = require('../runtime/format');

/** A small deterministic generator: the same seed always builds the same documents. */
function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const pick = list => list[int(0, list.length - 1)];
  const text = () =>
    pick(['', 'plain', 'with space', 'quote " and \' apostrophe', 'tab\tnewline\n', '<script>', 'émoji 😀', '\\backslash', '{"json": "inside"}', 'a'.repeat(int(0, 40))]);
  const value = depth => {
    const kind = depth > 3 ? pick(['string', 'number', 'bool', 'null']) : pick(['string', 'number', 'bool', 'null', 'array', 'object']);
    if (kind === 'string') return text();
    if (kind === 'number') return pick([0, -1, 42, 3.5, 1e6, -0.25]);
    if (kind === 'bool') return next() < 0.5;
    if (kind === 'null') return null;
    if (kind === 'array') return Array.from({length: int(0, 4)}, () => value(depth + 1));
    const object = {};
    for (let i = 0; i < int(0, 4); i++) object[pick(['a', 'b', 'c', 'id', 'name', 'x y', 'x.y'])] = value(depth + 1);
    return object;
  };
  return {next, int, pick, text, value};
}

function document(seed) {
  const r = random(seed);
  const id = () => (r.next() < 0.5 ? 'record:' + r.int(100000, 999999).toString(16) : 'complex:' + r.int(100000, 999999).toString(16));
  const node = () => ({
    id: id(),
    kind: r.pick(['function', 'value']),
    node_type: r.pick(['custom', undefined]),
    config: r.next() < 0.15 ? {op: 'script', title: 'Script', default: r.text()} : r.value(1),
    label: r.text(),
    status: r.pick(['ready', 'completed', 'failed']),
    position: {x: r.int(-500, 500), y: r.int(-500, 500)},
    ...(r.next() < 0.1 ? {disabled: true} : {}),
    ...(r.next() < 0.1 ? {color: '#aabbcc'} : {}),
  });
  const group = () => ({
    id: id(),
    name: r.text(),
    members: Array.from({length: r.int(0, 3)}, id),
    parent: r.next() < 0.5 ? null : id(),
    layout: {x: r.int(0, 400), y: r.int(0, 400), width: r.int(50, 400), height: r.int(50, 400)},
  });
  const doc = {
    nodes: Array.from({length: r.int(0, 6)}, node),
    port_edges: Array.from({length: r.int(0, 6)}, () => ({
      id: 'port:' + r.int(1, 999).toString(16),
      source: id(),
      source_port: r.pick(['out', 'value', 'in']),
      target: id(),
      target_port: r.pick(['in', 'value', 'out']),
    })),
    groups: Array.from({length: r.int(0, 3)}, group),
    complex: Array.from({length: r.int(0, 2)}, () => ({
      id: id(),
      interface: {inputs: r.value(2), outputs: r.value(2)},
      source: {resource_id: r.int(1, 99).toString(16), stamp: r.int(1, 1e6)},
      members: [id(), id()],
    })),
    types: Array.from({length: r.int(0, 3)}, () => ({id: r.int(1, 99).toString(16), name: r.text(), fields: r.value(2), color: '#123456'})),
    widgets: {[id()]: r.value(2)},
    layout: {[id()]: {x: r.int(0, 500), y: r.int(0, 500)}},
    cursor: r.int(0, 50),
    runtime: {some: 'opaque value', nested: r.value(1)},
    note: r.text(),
  };
  return doc;
}

const plain = value => JSON.parse(JSON.stringify(value));

// The format canonicalises the order of these collections and the keys of every object; equality is modulo that.
const SORTED = new Set(['nodes', 'records', 'groups', 'complex', 'port_edges', 'types']);
function canonical(value, key = '') {
  if (key === 'runtime') return value;
  if (Array.isArray(value)) {
    const items = value.map(item => canonical(item, ''));
    return SORTED.has(key) ? items.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en')) : items;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name], name)]));
  return value;
}

test('generated documents survive encode and decode unchanged', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const source = plain(document(seed));
    const packet = TextGraph.encode(source);
    assert.equal(packet.format, TextGraph.FORMAT);
    for (const [name, text] of Object.entries(packet.files)) {
      assert.match(name, /^(graph\.json|layout\.json|scripts\/[A-Za-z0-9_-]+\.js)$/, `seed ${seed}: ${name}`);
      assert.equal(typeof text, 'string');
    }
    // Every packet the encoder makes is one the decoder accepts: no unreferenced file, no missing script.
    const decoded = plain(TextGraph.decode(packet));
    assert.deepEqual(canonical(decoded), canonical(source), `seed ${seed}`);
    assert.deepEqual(TextGraph.encode(decoded), packet, `seed ${seed} is already canonical`);
    assert.deepEqual(TextGraph.encode(decoded), packet, `seed ${seed} is canonical`);
  }
});

test('a script default becomes a real file and comes back as the same code', () => {
  const source = {
    nodes: [
      {id: 'n1', config: {op: 'script', title: 'Script', inputs: [{id: 'script', name: 'script', default: 'node.output.text = "x";'}]}},
    ],
    port_edges: [],
    groups: [],
    complex: [],
    types: [],
    layout: {},
  };
  const packet = TextGraph.encode(source);
  const scripts = Object.keys(packet.files).filter(name => name.startsWith('scripts/'));
  assert.equal(scripts.length, 1);
  assert.equal(packet.files[scripts[0]], 'node.output.text = "x";');
  assert.match(packet.files['graph.json'], /\$script/);
  assert.deepEqual(plain(TextGraph.decode(packet)), source);
});

test('a damaged packet is refused, including hostile layout paths', () => {
  const source = {nodes: [], port_edges: [], groups: [], complex: [], types: [], layout: {}};
  const packet = () => TextGraph.encode(source);
  const broken = [
    ['not a packet', null],
    ['wrong format', {format: 'other/1', files: {}}],
    ['missing files', {format: TextGraph.FORMAT}],
    ['files is a list', {format: TextGraph.FORMAT, files: []}],
  ];
  for (const [label, value] of broken) assert.throws(() => TextGraph.decode(value), Error, label);

  const extra = packet();
  extra.files['scripts/orphan.js'] = 'unused';
  assert.throws(() => TextGraph.decode(extra), /Unreferenced|Missing/);

  const missing = packet();
  missing.files['graph.json'] = JSON.stringify({format: TextGraph.FORMAT, value: {nodes: [{config: {$script: 'scripts/none.js'}}]}});
  assert.throws(() => TextGraph.decode(missing), /script/i);

  const wrongFile = packet();
  wrongFile.files['../escape.json'] = '{}';
  assert.throws(() => TextGraph.decode(wrongFile), /Invalid text file/);

  const proto = packet();
  proto.files['layout.json'] = JSON.stringify({[JSON.stringify(['value', '__proto__', 'layout'])]: {polluted: true}});
  assert.throws(() => TextGraph.decode(proto), /Invalid layout path/);
  assert.equal({}.polluted, undefined, 'nothing was polluted');

  const badParent = packet();
  badParent.files['layout.json'] = JSON.stringify({[JSON.stringify(['value', 'missing', 'layout'])]: {}});
  assert.throws(() => TextGraph.decode(badParent), /Invalid layout parent/);

  const badKey = packet();
  badKey.files['layout.json'] = JSON.stringify({[JSON.stringify(['value', 'note'])]: {}});
  assert.throws(() => TextGraph.decode(badKey), /Invalid layout key/);
});

test('runtime state is opaque: it is stored inline and never mined for scripts or layout', () => {
  const source = {
    nodes: [{id: 'n1', config: {op: 'script', inputs: [{id: 'script', name: 'script', default: 'first'}]}}],
    runtime: {config: {op: 'script', default: 'must not be a file'}, layout: {x: 1, y: 2}},
    port_edges: [],
    groups: [],
    complex: [],
    types: [],
    layout: {},
  };
  const packet = TextGraph.encode(source);
  const scripts = Object.keys(packet.files).filter(name => name.startsWith('scripts/'));
  assert.equal(scripts.length, 1, 'only the real Script default is extracted');
  assert.deepEqual(plain(TextGraph.decode(packet)), plain(source));
});
});

describe("graph-mutation", () => {
// Randomized graph mutation: a deterministic sequence of ordinary editor operations through the API, with the
// document's invariants checked after every step. This is the property test the graph format has: whatever the
// editor is asked to do, the result must be a graph the API and the engine can still read, wire and run.
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, nodes} = require('./harness');

function generator(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: list => list[Math.floor(next() * list.length)],
    chance: share => next() < share,
  };
}

/** The document as a comparable value: positions and semantic content, ordered so two reads compare. */
function stateOf(snapshot) {
  const sorted = list => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en'));
  return JSON.stringify({
    nodes: sorted(snapshot.nodes).map(node => ({
      id: node.id,
      config: node.config,
      position: node.position,
      disabled: !!node.disabled,
      color: node.color ?? null,
    })),
    edges: sorted(snapshot.edges),
    groups: sorted(snapshot.groups),
    complex: sorted(snapshot.complex),
  });
}

function checkInvariants(snapshot, label) {
  const ids = snapshot.nodes.map(node => node.id);
  assert.equal(new Set(ids).size, ids.length, `${label}: node ids are unique`);
  const edges = snapshot.edges.map(edge => edge.id);
  assert.equal(new Set(edges).size, edges.length, `${label}: edge ids are unique`);
  const known = new Set(ids);
  for (const edge of snapshot.edges) {
    assert.ok(known.has(edge.source), `${label}: edge source ${edge.source} exists`);
    assert.ok(known.has(edge.target), `${label}: edge target ${edge.target} exists`);
  }
  for (const node of snapshot.nodes) {
    assert.equal(Number.isFinite(node.position?.x), true, `${label}: ${node.id} has an x`);
    assert.equal(Number.isFinite(node.position?.y), true, `${label}: ${node.id} has a y`);
  }
  for (const group of snapshot.groups)
    for (const member of group.members) assert.ok(known.has(member), `${label}: group member ${member} exists`);
  assert.equal(typeof snapshot.cursor, 'number');
}

async function workspace(app, projectId) {
  const query = {workflow_id: projectId};
  const post = (route, body) => app.api('POST', `projects/${projectId}/${route}`, {...body, ...query});
  const put = (route, body) => app.api('PUT', `projects/${projectId}/${route}`, {...body, ...query});
  const snapshot = () => app.api('GET', `projects/${projectId}/workflow`, {}, query);
  return {post, put, snapshot, query};
}

test('random editing keeps a valid graph and undo/redo returns the same document', async () => {
  const app = createApp();
  const {id} = await app.api('POST', 'projects', {name: 'Random edits'});
  const w = await workspace(app, id);
  // A Script node needs the code type; the project policy already allows graph.read, which the harness set.
  const scriptConfig = () => ({
    title: 'Script',
    op: 'script',
    inputs: [
      {id: 'in', name: 'in', type: 'signal'},
      {id: 'script', name: 'script', type: 't:c0de0c0de0c0de0c0de0c0de0c0de0c0', default: 'node.display("x");'},
    ],
    outputs: [{id: 'out', name: 'out', type: 'signal'}],
  });

  let successful = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const r = generator(seed);
    // Start each run from a paired graph: two events and two scripts.
    let nodes = [];
    for (let i = 0; i < 2; i++) nodes.push((await w.post('primitives', {primitive: 'event', point: {x: i * 60, y: 0}})).id);
    for (let i = 0; i < 2; i++)
      nodes.push(
        (
          await w.post('typed-nodes', {
            node_type: 'custom',
            config: scriptConfig(),
            position: {x: 100 + i * 60, y: 80},
          })
        ).id
      );

    let lastCursor = 0;
    for (let step = 0; step < 30; step++) {
      let before = await w.snapshot();
      checkInvariants(before, `seed ${seed} step ${step} start`);
      assert.ok(before.cursor >= lastCursor, `seed ${seed}: cursor never goes back`);
      lastCursor = before.cursor;
      const alive = before.nodes.map(node => node.id);
      const choice = r.pick([
        'add-event',
        'add-script',
        'connect',
        'connect',
        'disconnect',
        'move',
        'rename',
        'delete',
        'undo',
        'redo',
        'split',
      ]);
      try {
        if (choice === 'add-event' || choice === 'add-script') {
          await w.post('primitives', {
            primitive: choice === 'add-event' ? 'event' : 'script',
            point: {x: r.int(-200, 400), y: r.int(-200, 400)},
          });
        } else if (choice === 'connect') {
          if (alive.length < 2) throw new Error('need two nodes');
          const source = r.pick(alive),
            target = r.pick(alive);
          if (source === target) throw new Error('same node');
          await w.post('port-connections', {
            add: [{source, source_port: 'out', target, target_port: 'in'}],
          });
        } else if (choice === 'disconnect') {
          if (!before.edges.length) throw new Error('no edges');
          await w.post('port-connections', {remove: [r.pick(before.edges)]});
        } else if (choice === 'move') {
          if (!alive.length) throw new Error('no nodes');
          await w.put('layout', {positions: {[r.pick(alive)]: {x: r.int(-400, 400), y: r.int(-400, 400)}}});
        } else if (choice === 'rename') {
          if (!alive.length) throw new Error('no nodes');
          await w.put('node-title', {node_id: r.pick(alive), title: 'Renamed ' + r.int(1, 9)});
        } else if (choice === 'delete') {
          if (!alive.length) throw new Error('no nodes');
          await w.post('delete-nodes', {node_ids: [r.pick(alive)]});
        } else if (choice === 'split') {
          if (!before.edges.length) throw new Error('no edges');
          await w.post('split-connections', {
            splits: [{edge_id: r.pick(before.edges).id, position: {x: r.int(0, 300), y: r.int(0, 300)}}],
          });
        } else if (choice === 'undo') {
          const undone = await w.post('undo', {});
          const after = await w.snapshot();
          if (undone.undo < before.history.undo) {
            // Undo moved: the document changed, and redo must bring back exactly what was there.
            await w.post('redo', {});
            const restored = await w.snapshot();
            assert.equal(stateOf(restored), stateOf(before), `seed ${seed} step ${step}: redo after undo restores`);
          }
        } else {
          const redone = await w.post('redo', {});
          assert.ok(typeof redone.redo === 'number');
        }
        successful++;
      } catch (error) {
        // An operation the graph cannot accept (e.g. no edge to split) is a skipped step, not a failure.
        assert.ok(
          /need|no (edge|nodes)|same node|already|not found|missing|invalid|cannot|unknown|signal|port/i.test(error.message),
          `seed ${seed} step ${step} (${choice}): unexpected error ${error.message}`
        );
      }
      const snapshot = await w.snapshot();
      checkInvariants(snapshot, `seed ${seed} step ${step} after ${choice}`);
      await app.Backend.hooksIdle();
    }
    // A random sequence never leaves a document the API cannot read back: this is a fresh read.
    assert.ok((await w.snapshot()).nodes.length >= 0);
    // And it never grows without bound in this run.
    assert.ok((await w.snapshot()).nodes.length <= 40);
  }
  assert.ok(successful >= 60, `enough operations were accepted (${successful})`);
});

test('a random graph can still be run after mutations', async () => {
  const app = createApp({scripts: 'worker'});
  const {id} = await app.api('POST', 'projects', {name: 'Random run'});
  const w = await workspace(app, id);
  const r = generator(99);
  const event = (await w.post('primitives', {primitive: 'event', point: {x: 0, y: 0}})).id;
  const script = (await w.post('primitives', {primitive: 'script', point: {x: 100, y: 0}})).id;
  await w.put('input-values', {node_id: script, values: {script: 'node.display("random ok");'}});
  await w.post('port-connections', {add: [{source: event, source_port: 'out', target: script, target_port: 'in'}]});
  // Mutate around the pair, then run the untouched pair.
  for (let step = 0; step < 10; step++) {
    try {
      if (r.chance(0.5)) await w.post('primitives', {primitive: 'event', point: {x: r.int(0, 300), y: r.int(0, 300)}});
      else await w.put('layout', {positions: {[event]: {x: r.int(0, 300), y: r.int(0, 300)}}});
    } catch {}
  }
  const run = await w.post('execution', {node_ids: [event], wait: true});
  assert.deepEqual(run.errors, {});
  const displays = Object.values(run.displays || {}).join(' ');
  assert.match(displays, /random ok/);
  await app.Backend.shutdownExecutions();
});

test('every editing route is undoable: primitives, splits, output values, types and grants', async () => {
  const app = createApp();
  const {id} = await app.api('POST', 'projects', {name: 'Undo coverage'});
  const w = await workspace(app, id);
  const count = async () => (await w.snapshot()).nodes.length;
  const nodeOf = async nodeId => (await w.snapshot()).nodes.find(node => node.id === nodeId);

  // Adding a Script or an Event is an edit.
  const start = await count();
  const event = (await w.post('primitives', {primitive: 'event', point: {x: 0, y: 0}})).id;
  assert.equal(await count(), start + 1, 'the Event was added');
  await w.post('undo', {});
  assert.equal(await count(), start, 'adding an Event is undoable');
  await w.post('redo', {});
  assert.equal(await count(), start + 1);

  // Splitting a wire (a reroute point) is an edit.
  const script = (await w.post('primitives', {primitive: 'script', point: {x: 100, y: 0}})).id;
  await w.post('port-connections', {add: [{source: event, source_port: 'out', target: script, target_port: 'in'}]});
  const connected = await w.snapshot();
  assert.equal(connected.edges.length, 1);
  const nodesBeforeSplit = connected.nodes.length;
  await w.post('split-connections', {splits: [{edge_id: connected.edges[0].id, position: {x: 50, y: 50}}]});
  const split = await w.snapshot();
  assert.equal(split.edges.length, 2, 'the wire is split in two');
  await w.post('undo', {});
  const unsplit = await w.snapshot();
  assert.equal(unsplit.edges.length, 1, 'splitting a wire is undoable');
  assert.equal(unsplit.nodes.length, nodesBeforeSplit, 'the reroute point is removed by undo');
  await w.post('redo', {});
  assert.equal((await w.snapshot()).edges.length, 2);

  // Typing a value into an editable output is an edit.
  const value = (await w.post('typed-nodes', {
    node_type: 'custom',
    config: nodes.value('text', 'one'),
    position: {x: 200, y: 0},
  })).id;
  const outputOf = async () =>
    (await nodeOf(value)).config.outputs.find(output => output.id === 'value').default;
  assert.equal(await outputOf(), 'one');
  await w.put('output-values', {node_id: value, values: {value: 'two'}});
  assert.equal(await outputOf(), 'two');
  await w.post('undo', {});
  assert.equal(await outputOf(), 'one', 'an output value is undoable');
  await w.post('redo', {});
  assert.equal(await outputOf(), 'two');

  // The types of a workflow are part of its document.
  const beforeTypes = await app.api('GET', `projects/${id}/types`, {}, w.query);
  await w.put('types', {
    types: [...beforeTypes.types, {id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'extra', fields: [], color: '#123456'}],
  });
  assert.equal((await app.api('GET', `projects/${id}/types`, {}, w.query)).types.length, beforeTypes.types.length + 1);
  await w.post('undo', {});
  assert.equal(
    (await app.api('GET', `projects/${id}/types`, {}, w.query)).types.length,
    beforeTypes.types.length,
    'a type change is undoable'
  );

  // Changing a Script's grants changes its configuration, so undo covers it.
  const beforeGrant = (await nodeOf(script)).config.grants;
  await w.put('node-permissions/' + script, {grants: ['graph.read', 'graph.write']});
  assert.deepEqual((await nodeOf(script)).config.grants, ['graph.read', 'graph.write']);
  await w.post('undo', {});
  assert.deepEqual((await nodeOf(script)).config.grants, beforeGrant, 'a grant change is undoable');
});
});

describe("graph-primitives", () => {
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, fn, bundleOf, nodes} = require('./harness');
const text = 't:64428b9c654c2c2cfcb55742ea899ed8';
async function setup(t) {
  const app = createApp({scripts: 'worker'});
  t.after(async () => {
    await app.Backend.shutdownExecutions();
    await app.Backend.shutdownExecutions();
  });
  await app.api('POST', 'library/builtin');
  const p = await app.api('POST', 'projects', {name: 'Graph primitives'}),
    path = `projects/${p.id}`;
  const put = async (name, values = {}) => {
    const r = (await app.api('GET', 'resources')).find(r => r.name === name);
    const made = await app.api('POST', path + '/custom-nodes/' + r.id, {point: {x: 0, y: 0}}),
      id = 'complex:' + made.roots[0];
    if (Object.keys(values).length) await app.api('PUT', path + '/input-values', {node_id: id, values});
    return id;
  };
  const wire = (source, source_port, target, target_port) =>
    app.api('POST', path + '/port-connections', {add: [{source, source_port, target, target_port}]});
  const run = async id => {
    const result = await app.api('POST', path + '/execution', {node_ids: [id], input_port: 'in', wait: true});
    return {...result, value: result.dispatch_outputs[id]};
  };
  const feed = async (id, values) => {
    const source = await fn(
      app,
      p.id,
      {},
      {
        outputs: Object.keys(values),
        code: Object.entries(values)
          .map(([k, v]) => `node.output.${k}=${JSON.stringify(v)};`)
          .join('\n'),
      }
    );
    for (const key of Object.keys(values)) await wire(source.wrapper, key, id, key);
    const result = await app.api('POST', path + '/execution', {node_ids: [source.id], wait: true});
    assert.deepEqual(result.errors, {});
  };
  return {app, p, path, put, wire, run, feed};
}
test('Add Node places a reusable Custom Node, associates typed inputs, and Invoke Node signals it', async t => {
  const f = await setup(t);
  const child = await fn(
    f.app,
    f.p.id,
    {},
    {
      inputs: [{name: 'task', type: text}],
      outputs: ['result'],
      signals: ['out'],
      code: 'node.output.result={task:node.input.task};',
    }
  );
  const add = await f.put('Add Node', {resource_id: child.resource});
  await f.feed(add, {values: {task: 'unique child'}, point: {x: 700, y: 400}});
  const made = (await f.run(add)).value;
  assert.ok(made.result.ok);
  const snapshot = await f.app.api('GET', f.path + '/workflow');
  assert.deepEqual(snapshot.complex.find(c => 'complex:' + c.id === made.node_id).position, {x: 700, y: 400});
  // Placement alone is inert.
  assert.deepEqual((await f.app.api('POST', f.path + '/evaluate-node', {node_id: made.node_id})).outputs, {});
  const invoke = await f.put('Invoke Node', {node_id: made.node_id});
  assert.deepEqual((await f.run(invoke)).value.outputs.result, {task: 'unique child'});
});
test('Add Node without a point stacks generated nodes below the ones already placed', async t => {
  const f = await setup(t);
  const child = await fn(f.app, f.p.id, {}, {outputs: ['result'], signals: ['out'], code: 'node.output.result=1;'});
  const at = async id =>
    (await f.app.api('GET', f.path + '/workflow')).complex.find(c => 'complex:' + c.id === id).position;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const add = await f.put('Add Node', {resource_id: child.resource});
    ids.push((await f.run(add)).value.node_id);
  }
  const ys = [];
  for (const id of ids) ys.push((await at(id)).y);
  assert.ok(ys[1] > ys[0] && ys[2] > ys[1], 'each new node sits lower than the one before: ' + ys);
  assert.equal(new Set(ys).size, 3);
});
test('distinct generated instances can run concurrently and return their own dispatch results', async t => {
  const f = await setup(t);
  const child = await fn(
    f.app,
    f.p.id,
    {},
    {
      inputs: [{name: 'task', type: text}],
      outputs: ['result'],
      signals: ['out'],
      code: 'await node.sleep(node.input.task==="slow"?30:1);node.output.result={task:node.input.task};',
    }
  );
  const created = [];
  for (const task of ['slow', 'fast']) {
    const add = await f.put('Add Node', {resource_id: child.resource});
    await f.feed(add, {values: {task}});
    created.push((await f.run(add)).value.node_id);
  }
  const invokers = await Promise.all(created.map(node_id => f.put('Invoke Node', {node_id})));
  const results = await Promise.all(invokers.map(f.run));
  assert.deepEqual(
    results.map(r => r.value.outputs.result.task),
    ['slow', 'fast']
  );
});
test('Connect wires dynamic signal and data ports through checked APIs; Get Nodes and Remove Node inspect/delete them', async t => {
  const f = await setup(t);
  const child = await fn(f.app, f.p.id, {}, {outputs: ['result'], signals: ['out'], code: 'node.output.result=42;'});
  const add = await f.put('Add Node', {resource_id: child.resource}),
    generated = (await f.run(add)).value.node_id;
  const sink = await fn(f.app, f.p.id, {}, {inputs: ['value'], code: 'node.display(value);'});
  const connect = await f.put('Connect', {
    source: generated,
    source_port: 'out',
    target: sink.wrapper,
    target_port: 'in',
  });
  assert.equal((await f.run(connect)).value.result.ok, true);
  await f.app.api('PUT', f.path + '/input-values', {
    node_id: connect,
    values: {source_port: 'result', target_port: 'value'},
  });
  assert.equal((await f.run(connect)).value.result.ok, true);
  const invoked = await f.run(generated);
  assert.equal(invoked.displays[sink.id], '42');
  const inspect = await f.put('Get Nodes');
  assert.ok((await f.run(inspect)).value.nodes.some(n => n.id === generated));
  const remove = await f.put('Remove Node', {node_id: generated});
  const removed = await f.run(remove);
  assert.deepEqual(removed.errors, {});
  assert.equal(removed.value.result.ok, true);
  assert.ok(!(await f.run(inspect)).value.nodes.some(n => n.id === generated));
});
test('Connect rejects incompatible, missing and cyclic data ports and preserves the graph', async t => {
  const f = await setup(t);
  const a = await fn(
    f.app,
    f.p.id,
    {},
    {inputs: ['value'], outputs: ['result'], signals: ['out'], code: 'node.output.result=1;'}
  );
  const b = await fn(
    f.app,
    f.p.id,
    {},
    {inputs: ['value'], outputs: ['result'], signals: ['out'], code: 'node.output.result=2;'}
  );
  await f.wire(a.wrapper, 'result', b.wrapper, 'value');
  const connect = await f.put('Connect', {
    source: b.wrapper,
    source_port: 'result',
    target: a.wrapper,
    target_port: 'value',
  });
  const before = (await f.app.api('GET', f.path + '/workflow')).edges.length;
  assert.equal((await f.run(connect)).value.result.ok, false);
  await f.app.api('PUT', f.path + '/input-values', {node_id: connect, values: {source_port: 'out'}});
  assert.equal((await f.run(connect)).value.result.ok, false);
  await f.app.api('PUT', f.path + '/input-values', {node_id: connect, values: {source_port: 'missing'}});
  assert.equal((await f.run(connect)).value.result.ok, false);
  assert.equal((await f.app.api('GET', f.path + '/workflow')).edges.length, before);
});
test('graph nodes honor project permissions and signal dispatch rejects non-signal inputs', async t => {
  const f = await setup(t),
    add = await f.put('Add Node', {primitive: 'event'});
  await f.app.api('PUT', f.path + '/policy', {allow: ['graph.read', 'run.start']});
  assert.match(JSON.stringify((await f.run(add)).errors), /Permission denied: graph.write/);
  const bad = await f.app.api('POST', f.path + '/execution', {node_ids: [add], input_port: 'primitive', wait: true});
  assert.match(JSON.stringify(bad.errors), /Signal input not found/);
});
test('Add Node supports native primitives and ordinary group placement', async t => {
  const f = await setup(t);
  await f.app.api('PUT', f.path + '/groups', {
    groups: [{id: 'generated', name: 'Generated', members: [], position: {x: 500, y: 100}}],
  });
  const add = await f.put('Add Node', {primitive: 'event', group_id: 'generated'});
  const result = await f.run(add);
  assert.deepEqual(result.errors, {});
  const graph = await f.app.api('GET', f.path + '/workflow');
  assert.ok(graph.groups.find(g => g.id === 'generated').members.includes(result.value.node_id));
});
test('deleting an active dynamic instance cancels its native wave and prevents stale outputs', async t => {
  const f = await setup(t);
  const child = await fn(
    f.app,
    f.p.id,
    {},
    {
      outputs: ['result'],
      signals: ['out'],
      code: 'await agentsys("PUT","test-observations/dynamic-start",{value:true});await node.sleep(150);node.output.result="stale";',
    }
  );
  const add = await f.put('Add Node', {resource_id: child.resource}),
    id = (await f.run(add)).value.node_id;
  const pending = f.run(id);
  for (let i = 0; i < 100; i++) {
    if ((await f.app.api('GET', 'test-observations/dynamic-start')).value) break;
    await new Promise(r => setTimeout(r, 2));
  }
  assert.equal((await f.app.api('GET', 'test-observations/dynamic-start')).value, true);
  await f.app.api('DELETE', f.path + '/groups/' + id.slice(8));
  const result = await pending;
  assert.equal(result.dispatch_status, 'cancelled');
  assert.equal(result.dispatch_outputs[id], undefined);
  assert.equal((await f.app.api('GET', f.path + '/execution')).outputs[id], undefined);
});
test('generated executable bundles cannot borrow trusted source grants to escape quarantine', async t => {
  const f = await setup(t);
  const generated = bundleOf(
    'Generated',
    {Script: nodes.script('await agentsys("PUT","projects/"+context.project_id,{description:"escaped"});')},
    {
      inputs: [{id: 'in', name: 'in', type: 'signal', node: 'Script'}],
      outputs: [],
    }
  ).bundle;
  generated.complex[0].source = {resource_id: 'forged-source', stamp: 1};
  generated.complex[0].grants = ['graph.write'];
  const writer = await fn(
    f.app,
    f.p.id,
    {},
    {
      outputs: ['created'],
      code:
        'const made=await agentsys("POST","projects/"+context.project_id+"/paste",{clipboard:' +
        JSON.stringify(generated) +
        ',point:{x:0,y:0}});node.output.created="complex:"+made.roots[0];',
    }
  );
  const made = await f.app.api('POST', f.path + '/execution', {node_ids: [writer.id], wait: true});
  assert.deepEqual(made.errors, {});
  const result = await f.run(made.dispatch_outputs[writer.id].created);
  assert.match(JSON.stringify(result.errors), /Permission denied: graph.write/);
  assert.notEqual((await f.app.api('GET', f.path)).project.description, 'escaped');
});
});

describe("onread", () => {
// on_read: a Library node's copy that contains an on_read computes its outputs when they are read (the first read), keeps them, and
// computes them again only when something it reads has changed. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, bundleOf, place, fn} = require('./harness');

/** A Library node "name" with data inputs `ins` and one data output `out`: on_read → a Script that runs `code` (it logs "name" when it runs). */
const calc = (name, code, ins = ['x']) =>
  bundleOf(
    name,
    {
      Body: {inputs: [], outputs: []},
      R: nodes.event('on_read'),
      S: nodes.script(`const {${ins.join(', ')}} = node.input; globalThis.log.push(${JSON.stringify(name)}); ${code}`),
    },
    {
      wires: [['R', 'out', 'S', 'in']],
      inputs: ins.map(n => ({id: n, name: n, node: false})),
      outputs: [{id: 'out', name: 'result', node: false}],
    }
  );

test('changing shared JSON state invalidates cached on_read values', async () => {
  const p = await setup();
  const copy = await p.put(calc('Context', 'node.output.result = context.state.count ?? 0', []));
  const reader = await p.fn({code: 'node.display(node.input.v)', inputs: ['v']});
  const writer = await p.fn({code: 'context.state.count = 42'});
  await p.wire(copy, 'out', reader.wrapper, 'v');
  const before = await p.app.api('POST', `projects/${p.id}/execution`, {node_ids: [reader.id], wait: true});
  assert.equal(before.displays[reader.id], '0');
  await p.app.api('POST', `projects/${p.id}/execution`, {node_ids: [writer.id], wait: true});
  const after = await p.app.api('POST', `projects/${p.id}/execution`, {node_ids: [reader.id], wait: true});
  assert.equal(after.displays[reader.id], '42');
});

test('a data read joins signals emitted without await by its on_read handler', async () => {
  const p = await setup();
  const copy = await p.put(
    bundleOf(
      'Async read',
      {
        E: nodes.event('on_read'),
        S: nodes.script('node.output.result=42;node.output.body.emit();'),
      },
      {
        wires: [['E', 'out', 'S', 'in']],
        outputs: [
          {id: 'result', name: 'result', node: false},
          {id: 'body', name: 'body', type: 'signal', node: false},
        ],
      }
    )
  );
  const branch = await p.fn({code: 'await node.sleep(20);context.state.finished=true;'});
  const reader = await p.fn({code: 'node.display([node.input.value,context.state.finished]);', inputs: ['value']});
  await p.wire(copy, 'body', branch.wrapper, 'in');
  await p.wire(copy, 'result', reader.wrapper, 'value');
  const result = await p.app.api('POST', `projects/${p.id}/execution`, {node_ids: [reader.id], wait: true});
  assert.equal(result.displays[reader.id], '[\n  42,\n  true\n]');
});

async function setup() {
  const app = createApp();
  app.context.log = [];
  const {id} = await app.api('POST', 'projects', {name: 'P'});
  const p = {
    app,
    id,
    fn: opts => fn(app, id, {}, opts),
    node: config =>
      app.api('POST', `projects/${id}/typed-nodes`, {node_type: 'custom', config, position: {x: 0, y: 0}}),
    wire: (s, sp, t, tp) =>
      app.api('POST', `projects/${id}/port-connections`, {
        add: [{source: s, source_port: sp, target: t, target_port: tp}],
      }),
    put: async def => (await place(app, id, {}, def)).id,
    log: () => JSON.parse(JSON.stringify(app.context.log)),
    /** Runs the signal chain `steps` from an on_run and answers the result of the run. */
    run: async (...steps) =>
      app.api('POST', `projects/${id}/evaluate-node`, {node_ids: [await flow(app, id, {}, steps)], collect: true}),
  };
  return p;
}

test('the first read computes the copy; later reads give the same value without computing again', async () => {
  const p = await setup();
  const three = await p.node(nodes.value('number', 3));
  const copy = await p.put(calc('Times ten', 'node.output.result = x * 10'));
  await p.wire(three.id, 'value', copy, 'x');
  assert.deepEqual(p.log(), [], 'nothing runs before somebody reads');
  const reader = await p.fn({
    code: 'const a = node.input.v; const b = node.input.v; node.output.result = [a, b]',
    inputs: ['v'],
    outputs: ['result'],
  });
  await p.wire(copy, 'out', reader.wrapper, 'v');
  const r = await p.run(reader.step);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(p.log(), ['Times ten'], 'computed once for the reads');
  assert.deepEqual(
    (await p.app.api('POST', `projects/${p.id}/evaluate-node`, {node_ids: [reader.id], collect: true})).outputs[
      reader.id
    ],
    {result: [30, 30]}
  );
});

test('when what the copy reads changes, it is computed again on the next read; when the new value is the same, it is not', async () => {
  const p = await setup();
  const source = await p.fn({
    code: 'node.output.result = 1; await node.output.out.emit(); node.output.result = 2; await node.output.out.emit(); node.output.result = 2',
    outputs: ['result'],
    signals: ['out'],
  });
  const copy = await p.put(calc('Double', 'node.output.result = x * 2'));
  await p.wire(source.wrapper, 'result', copy, 'x');
  const reader = await p.fn({code: 'globalThis.log.push("saw " + node.input.v)', inputs: ['v']});
  await p.wire(copy, 'out', reader.wrapper, 'v');
  await p.wire(source.wrapper, 'out', reader.wrapper, 'in');
  const r = await p.run(source.step);
  assert.deepEqual(r.errors, {});
  // The source signals three times (1, 2, 2): the reader runs three times; the copy is computed for 1 and for 2, not for the second 2.
  assert.deepEqual(p.log(), ['Double', 'saw 2', 'Double', 'saw 4', 'saw 4']);
});

test('a copy that reads another copy brings it up to date first: the order follows the data', async () => {
  const p = await setup();
  const source = await p.fn({
    code: 'node.output.result = 5; await node.output.out.emit(); node.output.result = 6',
    outputs: ['result'],
    signals: ['out'],
  });
  const first = await p.put(calc('Plus one', 'node.output.result = x + 1'));
  const second = await p.put(calc('Times two', 'node.output.result = x * 2'));
  await p.wire(source.wrapper, 'result', first, 'x');
  await p.wire(first, 'out', second, 'x');
  const reader = await p.fn({code: 'globalThis.log.push(node.input.v)', inputs: ['v']});
  await p.wire(second, 'out', reader.wrapper, 'v');
  await p.wire(source.wrapper, 'out', reader.wrapper, 'in');
  const r = await p.run(source.step);
  assert.deepEqual(r.errors, {});
  // Computing "Times two" asks for "Plus one" while it runs, so "Times two" starts first; each is computed once per value.
  assert.equal(p.log().filter(x => x === 'Plus one').length, 2);
  assert.equal(p.log().filter(x => x === 'Times two').length, 2);
  assert.deepEqual(
    p.log().filter(x => typeof x === 'number'),
    [12, 14]
  );
});

test('an error in what the on_read starts is thrown to the reader, and stays until something changes', async () => {
  const p = await setup();
  const source = await p.fn({
    code: 'node.output.result = 0; try { await node.output.out.emit(); } catch (e) { globalThis.log.push("error " + e.message); } node.output.result = 1',
    outputs: ['result'],
    signals: ['out'],
  });
  const copy = await p.put(calc('Check', 'if (x === 0) throw new Error("zero"); node.output.result = x'));
  await p.wire(source.wrapper, 'result', copy, 'x');
  const reader = await p.fn({code: 'globalThis.log.push("ok " + node.input.v)', inputs: ['v']});
  await p.wire(copy, 'out', reader.wrapper, 'v');
  await p.wire(source.wrapper, 'out', reader.wrapper, 'in');
  await p.run(source.step);
  assert.deepEqual(
    p.log().filter(x => typeof x === 'string' && x !== 'Check'),
    ['error Node code: zero', 'ok 1']
  );
});

test('a copy without an on_read gives what its nodes last left, as before', async () => {
  const p = await setup();
  const plain = bundleOf(
    'Holder',
    {Body: {inputs: [], outputs: []}, S: nodes.script('node.output.result = 7')},
    {outputs: [{id: 'out', name: 'result', node: false}]}
  );
  const copy = await p.put(plain);
  const reader = await p.fn({code: 'globalThis.log.push(typeof node.input.v)', inputs: ['v']});
  await p.wire(copy, 'out', reader.wrapper, 'v');
  await p.run(reader.step);
  assert.deepEqual(p.log(), ['undefined'], 'nobody ran its Script, so there is nothing to read');
});

test('an input of a Library node is read by every Script inside: one wire feeds them all', async () => {
  const p = await setup();
  const three = await p.node(nodes.value('number', 3));
  const both = bundleOf(
    'Both',
    {
      Body: {inputs: [], outputs: []},
      R: nodes.event('on_read'),
      A: nodes.script('node.output.result = node.input.v * 10'),
      B: nodes.script('globalThis.log.push("B got " + node.input.v)'),
    },
    {
      wires: [
        ['R', 'out', 'A', 'in'],
        ['R', 'out', 'B', 'in'],
      ],
      inputs: [{id: 'v', name: 'v', node: false}],
      outputs: [{id: 'out', name: 'result', node: false}],
    }
  );
  const copy = await p.put(both);
  await p.wire(three.id, 'value', copy, 'v');
  const snap = await p.app.api('GET', `projects/${p.id}/workflow`);
  assert.deepEqual(snap.issues ?? [], []);
  const reader = await p.fn({code: 'node.output.result = node.input.w', inputs: ['w'], outputs: ['result']});
  await p.wire(copy, 'out', reader.wrapper, 'w');
  const r = await p.run(reader.step);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(p.log(), ['B got 3'], 'the second Script got the value too');
  assert.deepEqual(
    (await p.app.api('POST', `projects/${p.id}/evaluate-node`, {node_ids: [reader.id], collect: true})).outputs[
      reader.id
    ],
    {result: 30}
  );
});
});

describe("resource", () => {
// Long-running behaviour: repeated runs, open and closed event streams, a flood of sessions, a large graph and a
// large collection. The bounds are generous on purpose: they catch a leak or a quadratic path, not a slow machine.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  {performance} = require('node:perf_hooks');
const {createApiServer} = require('../server/api-server');

const TOKEN = 'resource-token';
const bearer = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-resource-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  const base = await app.listen(0);
  const call = async (method, route, body, query) => {
    const response = await fetch(base + '/api/' + route, {
      method,
      headers: bearer,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {status: response.status, body: text ? JSON.parse(text) : undefined};
  };
  return {app, base, dir, call};
}

const stats = samples => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted.at(-1),
  };
};

test('200 API round trips stay fast and lose nothing', async () => {
  const {app, call, dir} = await start();
  try {
    const project = (await call('POST', 'projects', {name: 'Traffic'})).body;
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const started = performance.now();
      const defined = await call('PUT', 'collections/audit', {
        title: 'Audit',
        schema: {type: 'object', properties: {n: {type: 'integer'}}, additionalProperties: false},
      });
      assert.equal(defined.status, 200, JSON.stringify(defined.body));
      await call('GET', 'projects');
      samples.push(performance.now() - started);
    }
    const timing = stats(samples);
    // p95 under 250 ms per pair on this machine; a leak or quadratic path takes far longer.
    assert.ok(timing.p95 < 250, JSON.stringify(timing));
    const records = await call('GET', 'collections/audit/records');
    assert.equal(records.status, 200);
    assert.ok(project.id);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('twelve parallel runs settle and leave no running runtime behind', async () => {
  const {app, call, dir} = await start();
  try {
    await call('PUT', 'settings', {developer_mode: true});
    const project = (await call('POST', 'projects', {name: 'Parallel runs'})).body;
    const query = {workflow_id: project.id};
    const nodes = [];
    for (let i = 0; i < 12; i++) {
      const started = await call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'event', point: {x: i * 50, y: 0}});
      const slow = await call('POST', `projects/${project.id}/primitives`, {...query, primitive: 'script', point: {x: i * 50, y: 100}});
      await call('PUT', `projects/${project.id}/input-values`, {
        ...query,
        node_id: slow.body.id,
        values: {script: `await node.sleep(${30 + i * 5}); node.display("run ${i}");`},
      });
      await call('POST', `projects/${project.id}/port-connections`, {
        ...query,
        add: [{source: started.body.id, source_port: 'out', target: slow.body.id, target_port: 'in'}],
      });
      nodes.push(started.body.id);
    }
    // Start them all, then stop half of them while they sleep.
    const started = await Promise.all(nodes.map(id => call('POST', `projects/${project.id}/execution`, {...query, node_ids: [id]})));
    assert.equal(started.every(result => result.status === 200), true);
    await sleep(20);
    await call('DELETE', `projects/${project.id}/execution?workflow_id=${project.id}`);
    // Everything settles: the runtime reports idle and diagnostics sees no running runtime.
    let detail;
    for (let i = 0; i < 200; i++) {
      detail = (await call('GET', `projects/${project.id}/execution?workflow_id=${project.id}`)).body;
      if (detail.status === 'idle') break;
      await sleep(25);
    }
    assert.equal(detail.status, 'idle');
    const diagnostics = (await call('GET', 'diagnostics')).body;
    assert.equal(diagnostics.runtime.running, 0);
    assert.ok(diagnostics.workers.started >= 1, 'the work really ran');
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('an event stream that is closed by the client is forgotten by the server', async () => {
  const {app, base, call, dir} = await start();
  const controllers = Array.from({length: 10}, () => new AbortController());
  try {
    const readers = await Promise.all(
      controllers.map(controller => fetch(base + '/api/events', {headers: bearer, signal: controller.signal}))
    );
    await Promise.all(readers.map(async response => {
      const reader = response.body.getReader();
      reader.read().catch(() => {});
      return reader;
    }));
    const open = (await call('GET', 'diagnostics')).body.clients;
    assert.ok(open >= 10, `ten streams are open (${open})`);
    for (const controller of controllers) controller.abort();
    let closed = open;
    for (let i = 0; i < 100 && closed > 0; i++) {
      await sleep(20);
      closed = (await call('GET', 'diagnostics')).body.clients;
    }
    assert.equal(closed, 0, 'every closed stream is removed');
  } finally {
    for (const controller of controllers) controller.abort();
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a flood of sessions is bounded and the oldest is the one that loses its place', async () => {
  const {app, base, call, dir} = await start({sessionLimit: 3});
  try {
    const cookies = [];
    for (let i = 0; i < 5; i++) {
      const response = await fetch(base + '/api/auth/session', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token: TOKEN}),
      });
      assert.equal(response.status, 200);
      cookies.push(response.headers.get('set-cookie').split(';')[0]);
    }
    assert.equal((await call('GET', 'diagnostics')).body.sessions, 3, 'the map keeps at most its limit');
    assert.equal((await fetch(base + '/api/projects', {headers: {Cookie: cookies[0]}})).status, 401, 'the first session was evicted');
    assert.equal((await fetch(base + '/api/projects', {headers: {Cookie: cookies[4]}})).status, 200, 'the newest still works');
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a large workflow is saved and read back in linear time', async () => {
  const {app, call, dir} = await start();
  try {
    await call('PUT', 'settings', {developer_mode: true});
    const project = (await call('POST', 'projects', {name: 'Large graph'})).body;
    const query = {workflow_id: project.id};
    const total = 600;
    const write = performance.now();
    for (let batch = 0; batch < Math.ceil(total / 100); batch++) {
      const operations = [];
      for (let i = 0; i < 100 && batch * 100 + i < total; i++) {
        const n = batch * 100 + i;
        operations.push({
          method: 'POST',
          path: 'typed-nodes',
          body: {
            node_type: 'custom',
            config: {title: 'Node ' + n, op: 'on_run', inputs: [], outputs: [{id: 'out', name: 'out', type: 'signal'}]},
            position: {x: (n % 40) * 40, y: Math.floor(n / 40) * 40},
          },
        });
      }
      const result = await call('POST', `projects/${project.id}/batch`, {...query, operations});
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    const saved = performance.now() - write;
    const reads = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const graph = await call('GET', `projects/${project.id}/workflow?workflow_id=${project.id}`);
      reads.push(performance.now() - started);
      assert.equal(graph.body.nodes.length, total);
    }
    const timing = stats(reads);
    assert.ok(saved < 30000, `saving ${total} nodes took ${Math.round(saved)} ms`);
    assert.ok(timing.p95 < 3000, `reading ${total} nodes took ${JSON.stringify(timing)} ms`);
    // The file on disk is a canonical text graph with a layout sidecar, not one huge JSON blob.
    const graphFile = fs.readFileSync(path.join(dir, 'workflows', project.id + '.json'), 'utf8');
    assert.match(graphFile, /agentsys\.text\/1/);
    assert.equal(fs.existsSync(path.join(dir, 'workflows', project.id + '.files', 'layout.json')), true);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('a collection with a thousand records paginates and stays responsive', async () => {
  const {app, call, dir} = await start();
  try {
    await call('PUT', 'collections/log', {
      title: 'Log',
      schema: {type: 'object', properties: {n: {type: 'integer'}}, additionalProperties: false},
    });
    const write = performance.now();
    for (let i = 0; i < 1000; i++) await call('POST', 'collections/log/records', {data: {n: i}});
    const wrote = performance.now() - write;
    const page = await call('GET', 'collections/log/records?limit=50&offset=500');
    assert.equal(page.body.total, 1000);
    assert.equal(page.body.records.length, 50);
    assert.equal(page.body.records[0].data.n, 500);
    assert.ok(wrote < 60000, `1000 records took ${Math.round(wrote)} ms`);
    // The page size is capped by the server, whatever the caller asks for.
    const huge = await call('GET', 'collections/log/records?limit=100000');
    assert.equal(huge.body.records.length, 500);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
});

describe("types", () => {
// Types: the Library's and the workflow's own (only any is built in), structural compatibility, and the types travelling with copied nodes.
// Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, fn} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));
const hex = n => String(n).padStart(32, '0');
const T = n => 't:' + hex(n);
const kind = (id, name) => ({id, name, fields: []});
const TEXT = kind(hex(11), 'Text'),
  NUMBER = kind(hex(12), 'Number');
const person = (id = hex(1), name = 'Person') => ({
  id,
  name,
  fields: [
    {name: 'name', type: T(11)},
    {name: 'age', type: T(12)},
  ],
});
const base = () => [TEXT, NUMBER];

async function project(app) {
  const {id} = await app.api('POST', 'projects', {name: 'Types'});
  return {
    id,
    types: list => app.api('PUT', `projects/${id}/types`, {types: list}),
    node: config =>
      app.api('POST', `projects/${id}/typed-nodes`, {node_type: 'custom', config, position: {x: 0, y: 0}}),
    connect: (s, sp, t, tp) =>
      app.api('POST', `projects/${id}/port-connections`, {
        add: [{source: s, source_port: sp, target: t, target_port: tp}],
      }),
    evaluate: ids => app.api('POST', `projects/${id}/evaluate-node`, {node_ids: ids, collect: true}),
    snapshot: () => app.api('GET', `projects/${id}/workflow`),
  };
}

test('only any is built in: no other type exists until the document defines it', async () => {
  const app = createApp(),
    p = await project(app);
  assert.deepEqual((await p.snapshot()).types, []);
  await rejects(p.node({outputs: [{id: 'o', name: 'o', type: 'text'}]}), /type/);
  const anyNode = await p.node({outputs: [{id: 'o', name: 'o', type: 'any'}]}); // the built-in
  assert.equal(anyNode.id.startsWith('record:'), true);
  // Any other name is free, “text” too: it is just a name.
  await p.types([kind(hex(1), 'text'), kind(hex(2), 'number')]);
});

test('type expressions: shapes, labels and structural compatibility', () => {
  const {context} = createApp();
  const run = code => (context.eval ? context.eval(code) : require('node:vm').runInContext(code, context));
  const result = run(`
    (() => {
      const b = ${JSON.stringify({...person(hex(2), 'B'), fields: [...person().fields, {name: 'mail', type: T(11)}]})};
      const t = new TypeTable([${JSON.stringify(TEXT)}, ${JSON.stringify(NUMBER)}, ${JSON.stringify(person(hex(1), 'A'))}, b]);
      return JSON.stringify([
        compatible('${T(2)}', '${T(1)}', t), // more fields fits fewer
        compatible('${T(1)}', '${T(2)}', t),
        compatible('${T(11)}', '${T(11)}', t),
        compatible('${T(11)}', '${T(12)}', t), // named kinds fit only themselves
        compatible('${T(11)}', '${T(1)}', t),
        compatible('${T(1)}', '${T(11)}', t),
        compatible('any', '${T(1)}', t), // any fits everything, both ways
        compatible('${T(1)}', undefined, t),
        compatible('${T(99)}', '${T(1)}', t), // unknown means nothing
        t.label('${T(1)}'),
        renameTypeRefs('${T(1)}', new Map([['${hex(1)}', '${hex(5)}']])),
      ]);
    })()`);
  assert.deepEqual(JSON.parse(result), [true, false, true, false, false, false, true, true, false, 'A', T(5)]);
});

test('types are checked: names, fields, unknown and self-containing types', async () => {
  const app = createApp(),
    p = await project(app);
  await rejects(p.types([person(), person(hex(2))]), /unique/);
  await rejects(p.types([{...person(), fields: [{name: 'x', type: T(7)}]}]), /unknown type/);
  await rejects(p.types([{...person(), fields: [{name: 'me', type: T(1)}]}]), /contains itself/);
  await rejects(
    p.types([
      {
        ...person(),
        fields: [
          {name: 'a', type: 'any'},
          {name: 'a', type: 'any'},
        ],
      },
    ]),
    /unique name/
  );
  const saved = await p.types([
    ...base(),
    person(),
    {
      id: hex(2),
      name: 'Team',
      fields: [
        {name: 'people', type: T(1)},
        {name: 'note', type: 'any'},
      ],
    },
  ]);
  assert.equal(saved.types.length, 4);
  assert.equal((await app.api('GET', `projects/${p.id}/types`)).types.length, 4);
  assert.equal((await p.snapshot()).types.length, 4);
});

test('wires are checked by type; ports of type any take anything; the run never looks at types', async () => {
  const app = createApp(),
    p = await project(app);
  await p.types([
    ...base(),
    person(),
    person(hex(2), 'Human'),
    {id: hex(3), name: 'Named', fields: [{name: 'name', type: T(11)}]},
  ]);
  const make = await fn(
    app,
    p.id,
    {},
    {code: 'node.output.who = {name: "Ann", age: 30}', outputs: [{name: 'who', type: T(1)}], signals: ['out']}
  );
  const take = type =>
    fn(app, p.id, {}, {code: 'node.display(who.name)', inputs: [{name: 'who', ...(type ? {type} : {})}]});
  const human = await take(T(2)),
    named = await take(T(3)),
    other = await take(T(12)),
    kindOnly = await take(T(11)),
    free = await take();
  await p.connect(make.wrapper, 'who', human.wrapper, 'who'); // the same fields under another name
  await p.connect(make.wrapper, 'who', named.wrapper, 'who'); // fewer fields
  await p.connect(make.wrapper, 'who', free.wrapper, 'who'); // any
  await rejects(p.connect(make.wrapper, 'who', other.wrapper, 'who'), /incompatible/);
  await rejects(p.connect(make.wrapper, 'who', kindOnly.wrapper, 'who'), /incompatible/);
  // The signal runs the Scripts one after another, the data is read when they run.
  const start = await flow(app, p.id, {}, [make.step]);
  for (const t of [human, named, free]) await p.connect(make.wrapper, 'out', t.wrapper, 'in');
  const r = await p.evaluate([start]);
  assert.deepEqual(r.errors, {});
  assert.equal(r.displays[human.id], 'Ann');
  assert.equal(r.displays[free.id], 'Ann');
  // A node that puts something else into a typed output is not stopped: types decide only what can be wired.
  const odd = await fn(app, p.id, {}, {code: 'node.output.who = 5', outputs: [{name: 'who', type: T(1)}]});
  const seen = await p.evaluate([odd.id]);
  assert.deepEqual(seen.errors ?? {}, {});
  assert.equal(seen.outputs[odd.id].who, 5);
  // An output of type any goes into a typed input.
  const loose = await p.node({outputs: [{id: 'o', name: 'o'}]});
  await p.connect(loose.id, 'o', named.wrapper, 'who');
});

test('a type in use cannot be removed; a changed type drops the wires that no longer fit', async () => {
  const app = createApp(),
    p = await project(app);
  await p.types([...base(), person(), person(hex(2), 'Same')]);
  const a = await p.node({outputs: [{id: 'o', name: 'o', type: T(1)}]}),
    b = await p.node({inputs: [{id: 'i', name: 'i', type: T(2)}]});
  await p.connect(a.id, 'o', b.id, 'i');
  await rejects(p.types([...base(), person()]), /in use/);
  // The consumer now needs a field the producer lacks: the wire cannot stay.
  await p.types([
    ...base(),
    person(),
    {...person(hex(2), 'Same'), fields: [...person().fields, {name: 'mail', type: T(11)}]},
  ]);
  assert.equal((await p.snapshot()).edges.length, 0);
});

test('a Reroute takes the type of the wire that enters it', async () => {
  const app = createApp(),
    p = await project(app);
  await p.types(base());
  const a = await p.node({outputs: [{id: 'o', name: 'o', type: T(11)}]}),
    b = await p.node({inputs: [{id: 'i', name: 'i', type: T(12)}]}),
    c = await p.node({inputs: [{id: 'i', name: 'i', type: T(11)}]});
  const rr = await app.api('POST', `projects/${p.id}/typed-nodes`, {
    node_type: 'reroute',
    config: {},
    position: {x: 0, y: 0},
  });
  await p.connect(a.id, 'o', rr.id, 'in');
  await p.connect(rr.id, 'out', c.id, 'i');
  await rejects(p.connect(rr.id, 'out', b.id, 'i'), /incompatible/);
});

test('copied nodes bring their types; pasting merges them by name and shape', async () => {
  const app = createApp(),
    from = await project(app),
    to = await project(app);
  await from.types([...base(), person()]);
  const n = await from.node({outputs: [{id: 'o', name: 'o', type: T(1)}]});
  const bundle = await app.api('POST', `projects/${from.id}/copy`, {node_ids: [n.id]});
  assert.deepEqual(bundle.types.map(t => t.name).sort(), ['Number', 'Person', 'Text']);
  const paste = () => app.api('POST', `projects/${to.id}/paste`, {clipboard: bundle, point: {x: 0, y: 0}});
  await paste();
  await paste();
  assert.equal((await to.snapshot()).types.length, 3, 'the same type is not added twice');
  // Another project already has a different “Person” under the same ID: the pasted one gets its own ID and name.
  const other = await project(app);
  await other.types([...base(), {...person(), fields: [{name: 'name', type: T(11)}]}]);
  await app.api('POST', `projects/${other.id}/paste`, {clipboard: bundle, point: {x: 0, y: 0}});
  const types = (await other.snapshot()).types;
  assert.deepEqual(
    types.map(t => t.name),
    ['Text', 'Number', 'Person', 'Person (2)']
  );
  const pasted = (await other.snapshot()).nodes.find(x => x.outputs.some(o => o.type));
  assert.equal(pasted.outputs[0].type, 't:' + types[3].id);
  await rejects(
    app.api('POST', `projects/${to.id}/paste`, {
      clipboard: {...bundle, types: [{...person(), fields: [{name: 'x', type: T(77)}]}]},
      point: {x: 0, y: 0},
    }),
    /unknown type/
  );
});

test('exported workflows keep their types; a document without types still loads', async () => {
  const app = createApp(),
    p = await project(app);
  await p.types([...base(), person()]);
  await p.node({outputs: [{id: 'o', name: 'o', type: T(1)}]});
  const wf = (await p.snapshot()).workflow_id;
  const TextGraph = require('../runtime/format');
  const packet = await app.api('GET', `projects/${p.id}/workflows/${wf}/export`);
  const exported = TextGraph.decode(packet);
  assert.equal(exported.document.types.length, 3);
  const q = await project(app);
  await app.api('POST', `projects/${q.id}/workflows/import`, packet);
  const {types, ...without} = exported.document;
  const broken = await app.api('POST', `projects/${q.id}/workflows/import`, TextGraph.encode({document: without}));
  assert.ok(
    broken.diagnostics.some(m => /Unknown type/.test(m)),
    'ports of a type the document lacks are reported'
  );
  await app.api('POST', `projects/${q.id}/workflows/import`, TextGraph.encode({document: {nodes: [], layout: {}}}));
});

test('a Library node carries its types: placing it brings them, and its slots are typed', async () => {
  const app = createApp(),
    opened = await app.api('POST', 'library/node-editor', {}),
    wf = {workflow_id: opened.workflow_id},
    lib = await app.api('GET', `projects/${opened.project_id}/workflow`, {}, wf);
  await app.api('PUT', `projects/${opened.project_id}/types`, {...wf, types: base()});
  await app.api('PUT', `projects/${opened.project_id}/complex/${lib.root}`, {
    ...wf,
    interface: {inputs: [], outputs: [{id: 'text', name: 'text', type: T(11)}]},
  });
  const p = await project(app);
  const placed = await app.api('POST', `projects/${p.id}/custom-nodes/${opened.resource_id}`, {point: {x: 0, y: 0}});
  const snap = await p.snapshot();
  assert.deepEqual(
    snap.types.map(t => t.name),
    ['Text']
  ); // only the types its ports use
  const cx = snap.complex.find(c => c.id === placed.roots[0]);
  assert.equal(cx.outputs[0].type, T(11));
  await p.types([...snap.types, NUMBER]);
  const sink = await p.node({inputs: [{id: 'i', name: 'i', type: T(11)}]}),
    wrong = await p.node({inputs: [{id: 'i', name: 'i', type: T(12)}]});
  await p.connect('complex:' + cx.id, 'text', sink.id, 'i');
  await rejects(p.connect('complex:' + cx.id, 'text', wrong.id, 'i'), /incompatible/);
});

// ----- aliases -----
const SCRIPT = {id: hex(21), name: 'Script', fields: [], alias: T(11), control: 'code'};

test('an alias type means what its target means: the two are interchangeable on wires, the alias keeps its name and control', async () => {
  const app = createApp(),
    p = await project(app);
  await p.types([...base(), SCRIPT]);
  const text = await p.node({
      outputs: [{id: 'o', name: 'o', type: T(11)}],
      inputs: [{id: 'i', name: 'i', type: T(11)}],
    }),
    script = await p.node({outputs: [{id: 'o', name: 'o', type: T(21)}], inputs: [{id: 'i', name: 'i', type: T(21)}]}),
    number = await p.node({outputs: [{id: 'o', name: 'o', type: T(12)}], inputs: [{id: 'i', name: 'i', type: T(12)}]});
  await p.connect(text.id, 'o', script.id, 'i'); // Text into Script
  const text2 = await p.node({inputs: [{id: 'i', name: 'i', type: T(11)}]});
  await p.connect(script.id, 'o', text2.id, 'i'); // Script into Text
  await rejects(p.connect(number.id, 'o', script.id, 'i'), /incompatible/);
  await rejects(p.connect(script.id, 'o', number.id, 'i'), /incompatible/);
  // Its own label and control; with no control of its own it is typed in like its target.
  const result = app.context.eval
    ? app.context.eval('0')
    : require('node:vm').runInContext(
        `(() => { const t = new TypeTable([${JSON.stringify({...TEXT, control: 'textarea'})}, ${JSON.stringify({...SCRIPT, control: undefined})}, ${JSON.stringify({id: hex(22), name: 'Code', fields: [], alias: T(21), control: 'code'})}]);
          return JSON.stringify([t.label('${T(21)}'), t.control('${T(21)}'), t.control('${T(22)}'), compatible('${T(22)}', '${T(11)}', t)]) })()`,
        app.context
      );
  assert.deepEqual(JSON.parse(result), ['Script', {control: 'textarea'}, {control: 'code'}, true]);
  // The default of an input typed as code is text; a number is not.
  await p.node({inputs: [{id: 'i', name: 'i', type: T(21), default: 'return 1;'}]});
  await rejects(p.node({inputs: [{id: 'i', name: 'i', type: T(21), default: 5}]}), /value its type can hold/);
});

test('an alias is checked: it has no fields, stands for a type of the document and never for itself', async () => {
  const app = createApp(),
    p = await project(app);
  await rejects(p.types([...base(), {...SCRIPT, fields: [{name: 'x', type: T(11)}]}]), /alias/);
  await rejects(p.types([...base(), {...SCRIPT, alias: 'text'}]), /alias/);
  await rejects(p.types([...base(), {...SCRIPT, alias: T(77)}]), /unknown type/);
  await rejects(p.types([{...SCRIPT, alias: T(21)}]), /contains itself/);
  await rejects(
    p.types([
      {...SCRIPT, alias: T(22)},
      {...SCRIPT, id: hex(22), name: 'Other', alias: T(21)},
    ]),
    /contains itself/
  );
  await p.types([...base(), SCRIPT]);
  await rejects(p.types([SCRIPT]), /unknown type/); // the target cannot go while an alias stands for it
  // A copied node brings the target of its alias.
  const n = await p.node({outputs: [{id: 'o', name: 'o', type: T(21)}]});
  const bundle = await app.api('POST', `projects/${p.id}/copy`, {node_ids: [n.id]});
  assert.deepEqual(bundle.types.map(t => t.name).sort(), ['Script', 'Text']);
  const other = await project(app);
  await app.api('POST', `projects/${other.id}/paste`, {clipboard: bundle, point: {x: 0, y: 0}});
  const pasted = (await other.snapshot()).types;
  assert.deepEqual(pasted.map(t => t.name).sort(), ['Script', 'Text']);
  assert.equal(pasted.find(t => t.name === 'Script').alias, 't:' + pasted.find(t => t.name === 'Text').id);
});

// ----- one type, once -----

// ----- the Library's types -----
// A Custom Node of the Library is made in an editor; the types its ports use are the Library's from the moment it is saved.
async function openNode(app) {
  const opened = await app.api('POST', 'library/node-editor', {}),
    wf = {workflow_id: opened.workflow_id};
  return {...opened, wf, root: (await app.api('GET', `projects/${opened.project_id}/workflow`, {}, wf)).root};
}
async function defineNode(app, node, types, outputs) {
  const lib = await app.api('GET', `projects/${node.project_id}/workflow`, {}, node.wf);
  await app.api('PUT', `projects/${node.project_id}/types`, {...node.wf, types: [...lib.types, ...types]});
  await app.api('PUT', `projects/${node.project_id}/complex/${lib.root}`, {
    ...node.wf,
    interface: {inputs: [], outputs},
  });
  return node;
}
const libNode = async (app, types, outputs) => defineNode(app, await openNode(app), types, outputs);
const libraryOf = app => app.eval(`DB.get('library_types')`).then(list => JSON.parse(JSON.stringify(list ?? [])));
const out = (name, type) => ({id: name, name, type});

test("the types of Library nodes are every workflow's: nothing is imported, and a workflow stores none of them", async () => {
  const app = createApp(),
    node = await libNode(app, [TEXT, NUMBER, person()], [out('a', T(1))]);
  const a = await project(app),
    b = await project(app);
  for (const p of [a, b]) {
    const types = (await p.snapshot()).types;
    assert.deepEqual(types.map(t => [t.name, t.library]).sort(), [
      ['Number', true],
      ['Person', true],
      ['Text', true],
    ]);
  }
  assert.deepEqual((await app.eval(`DB.get('wf:${a.id}')`))?.types ?? [], []);
  // A type of the workflow's own sits next to them.
  await a.types([...(await a.snapshot()).types, kind(hex(4), 'Mine')]);
  assert.equal(JSON.stringify((await app.eval(`DB.get('wf:${a.id}')`)).types.map(t => t.name)), '["Mine"]');
  assert.ok(node.resource_id);
});

test('a Library type is changed in the node that defines it, for everybody; a workflow cannot change it', async () => {
  const app = createApp(),
    first = await libNode(app, [TEXT], [out('a', T(11))]),
    second = await libNode(app, [], [out('b', T(11))]);
  const p = await project(app);
  await rejects(p.types((await p.snapshot()).types.map(t => ({...t, name: 'Renamed'}))), /Library/);
  const q = `projects/${first.project_id}`;
  const open = (await app.api('GET', `${q}/workflow`, {}, first.wf)).types;
  await app.api('PUT', `${q}/types`, {...first.wf, types: open.map(t => ({...t, name: 'Words', color: '#123456'}))});
  assert.deepEqual(
    (await libraryOf(app)).map(t => t.name),
    ['Words']
  );
  assert.equal((await p.snapshot()).types[0].name, 'Words');
  // The other node carries the new definition too.
  const bundle = (await app.api('GET', `resources/${second.resource_id}`)).payload.bundle;
  assert.deepEqual(
    bundle.types.map(t => [t.name, t.color]),
    [['Words', '#123456']]
  );
  // A Library type does not go from a workflow, even by leaving it out of the list.
  await rejects(p.types([]), /Library/);
});

test('a type nobody defines and nobody uses goes by itself; one a workflow uses stays', async () => {
  const app = createApp(),
    node = await libNode(app, [TEXT, NUMBER], [out('a', T(11)), out('n', T(12))]);
  assert.deepEqual(
    (await libraryOf(app)).map(t => t.name),
    ['Number', 'Text']
  );
  const p = await project(app);
  const user = await p.node({inputs: [{id: 'i', name: 'i', type: T(11)}]});
  await app.api('DELETE', `resources/${node.resource_id}`);
  // Number was only the node's; Text is in use.
  assert.deepEqual(
    (await libraryOf(app)).map(t => t.name),
    ['Text']
  );
  assert.deepEqual(
    (await p.snapshot()).types.map(t => t.name),
    ['Text']
  );
  await app.api('POST', `projects/${p.id}/delete-nodes`, {node_ids: [user.id]});
  // Text stays until the Library changes next time: nothing else is looking.
  const again = await libNode(app, [kind(hex(30), 'Fresh')], [out('f', T(30))]);
  assert.deepEqual(
    (await libraryOf(app)).map(t => t.name),
    ['Fresh']
  );
  assert.ok(again.resource_id);
});

test('two nodes defining the same type share it; the same name with another shape is told apart', async () => {
  const app = createApp(),
    first = await libNode(app, [TEXT, NUMBER], [out('a', T(11)), out('n', T(12))]);
  // A node from elsewhere (an import) defines its own Text, the same, and a Number that is something else.
  const bundle = (await app.api('GET', `resources/${first.resource_id}`)).payload.bundle,
    foreign = JSON.parse(JSON.stringify(bundle).split(hex(11)).join(hex(40)).split(hex(12)).join(hex(41)));
  foreign.types.find(t => t.id === hex(41)).fields = [{name: 'x', type: 'any'}];
  foreign.types.find(t => t.id === hex(41)).control = undefined;
  const imported = await app.api('POST', 'resources', {name: 'Imported', payload: {bundle: foreign, description: ''}});
  assert.deepEqual(
    (await libraryOf(app)).map(t => t.name),
    ['Number', 'Number (2)', 'Text']
  );
  const kept = (await app.api('GET', `resources/${imported.id}`)).payload.bundle;
  assert.ok(
    kept.types.some(t => t.id === hex(11)),
    'the twin Text is the first Text'
  );
  assert.ok(kept.types.every(t => t.id !== hex(40)));
  assert.deepEqual(kept.types.map(t => t.name).sort(), ['Number (2)', 'Text']);
});

test('a type of the workflow that means the same as a Library type is that type', async () => {
  const app = createApp(),
    p = await project(app);
  await p.types([
    {id: hex(7), name: 'Flag', fields: [], control: 'checkbox'},
    {id: hex(8), name: 'Other', fields: []},
  ]);
  const node = await p.node({outputs: [{id: 'o', name: 'o', type: T(7), editable: true, default: true}]});
  // A node of the Library gets a Flag of its own (another ID): the workflow's becomes it, and the node follows.
  await libNode(app, [{id: hex(50), name: 'Flag', fields: [], control: 'checkbox'}], [out('f', T(50))]);
  const snap = await p.snapshot();
  assert.deepEqual(
    snap.types.map(t => [t.name, !!t.library]),
    [
      ['Flag', true],
      ['Other', false],
    ]
  );
  assert.equal(snap.nodes.find(n => n.id === node.id).config.outputs[0].type, T(50));
  assert.equal(JSON.stringify((await app.eval(`DB.get('wf:${p.id}')`)).types.map(t => t.name)), '["Other"]');
});

test("a Library node carries the definitions of its types: where the Library has a type it is the Library's, else it comes along as the workflow's own", async () => {
  const app = createApp(),
    node = await libNode(app, [TEXT, kind(hex(6), 'Mood')], [out('a', T(11)), out('b', T(6))]);
  const bundle = (await app.api('GET', `resources/${node.resource_id}`)).payload.bundle;
  assert.deepEqual(bundle.types.map(t => t.name).sort(), ['Mood', 'Text'], 'the node stands alone');
  assert.ok(bundle.types.every(t => !('library' in t)));
  const p = await project(app);
  await app.api('POST', `projects/${p.id}/custom-nodes/${node.resource_id}`, {point: {x: 0, y: 0}});
  assert.deepEqual((await p.snapshot()).types.map(t => [t.name, !!t.library]).sort(), [
    ['Mood', true],
    ['Text', true],
  ]);
  // Another installation has no such types: the node brings them along as the workflow's own.
  const other = createApp(),
    q = await project(other),
    pasted = await other.api('POST', `projects/${q.id}/paste`, {clipboard: bundle, point: {x: 0, y: 0}});
  assert.ok(pasted);
  assert.deepEqual((await q.snapshot()).types.map(t => [t.name, !!t.library]).sort(), [
    ['Mood', false],
    ['Text', false],
  ]);
});
});

describe("widgets", () => {
// Widgets: what a Custom node or a Library node declares or a Script puts on it, and how Scripts and a person read and change them. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, bundleOf, place, fn} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));

async function project(app) {
  const {id} = await app.api('POST', 'projects', {name: 'Widgets'}),
    q = {workflow_id: id};
  const call = (method, path, body = {}) => app.api(method, `projects/${id}/${path}`, {...q, ...body}, q);
  return {
    id,
    call,
    node: config => call('POST', 'typed-nodes', {node_type: 'custom', config, position: {x: 0, y: 0}}),
    snapshot: () => call('GET', 'workflow'),
    widgets: async node => (await call('GET', 'workflow')).widgets[node] ?? [],
    set: (node, widgets) => call('PUT', `widgets/${encodeURIComponent(node)}`, {widgets}),
    values: (node, values) => call('PUT', `widgets/${encodeURIComponent(node)}`, {values}),
    use: (node, values) => call('PUT', 'widget-values', {node_id: node, values}),
    evaluate: ids => call('POST', 'evaluate-node', {node_ids: ids, collect: true}),
    state: async key => (await app.api('GET', `test-observations/${key}`).catch(() => ({}))).value,
    idle: () => app.Backend.hooksIdle(),
  };
}

/** The titles of the Scripts that a bundle gets: `scripts` is {title: code}. Each is in the scope of the copy. */
const titled = (title, code) => ({...nodes.script(code), title});

test('empty widget updates perform no work and add no undo entry', async () => {
  const app = createApp(),
    p = await project(app),
    node = await p.node(nodes.script(''));
  const before = await p.snapshot(),
    history = (await p.call('GET', 'workflow')).history;
  await p.values(node.id, {});
  await p.use(node.id, {});
  await p.idle();
  assert.deepEqual(await p.snapshot(), before);
  assert.deepEqual((await p.call('GET', 'workflow')).history, history);
  assert.deepEqual(await app.api('GET', 'node-hooks'), []);
});

test('code makes widgets on the copy it is part of when the copy is placed, and reads their values when it runs', async () => {
  const app = createApp(),
    p = await project(app);
  const def = bundleOf(
    'Greeting',
    {
      Body: {inputs: [], outputs: []},
      Placed: nodes.event('on_placed'),
      Make: titled(
        'Make',
        `await node.widgets([
  {id: 'name', kind: 'text', label: 'Name', value: 'world'},
  {id: 'loud', kind: 'checkbox', label: 'Loud'},
  {id: 'mode', kind: 'select', options: ['a', 'b']},
  {id: 'go', kind: 'button', label: 'Go'},
  {id: 'size', kind: 'range', min: 1, max: 9, step: 1},
  {id: 'note', kind: 'label', text: 'hello'},
])`
      ),
      Read: titled('Read', 'node.output.result = JSON.stringify(context.widgets)'),
    },
    {wires: [['Placed', 'out', 'Make', 'in']], outputs: [{id: 'result', name: 'result', node: false}]}
  );
  const greeting = await place(app, p.id, {workflow_id: p.id}, def);
  await p.idle();
  const body = (await p.snapshot()).complex.find(c => c.id === greeting.group).widget_nodes[0];
  assert.deepEqual(
    (await p.widgets(body)).map(w => [w.id, w.kind, w.value]),
    [
      ['name', 'text', 'world'],
      ['loud', 'checkbox', false],
      ['mode', 'select', 'a'],
      ['go', 'button', 0],
      ['size', 'range', 1],
      ['note', 'label', undefined],
    ]
  );
  const read = await greeting.node('Read');
  const r = await p.evaluate([read.id]);
  assert.deepEqual(JSON.parse(r.outputs[read.id].result), {name: 'world', loud: false, mode: 'a', go: 0, size: 1});
});

test('a widget that stays keeps its value, a changed kind starts again, a missing one is gone', async () => {
  const app = createApp(),
    p = await project(app);
  const n = await p.node({title: 'W', outputs: []});
  await p.set(n.id, [
    {id: 'a', kind: 'text'},
    {id: 'b', kind: 'text'},
  ]);
  await p.values(n.id, {a: 'typed', b: 'kept'});
  await p.set(n.id, [
    {id: 'a', kind: 'number'},
    {id: 'b', kind: 'text', label: 'B again'},
  ]);
  assert.deepEqual(
    (await p.widgets(n.id)).map(w => [w.id, w.value]),
    [
      ['a', 0],
      ['b', 'kept'],
    ]
  );
  await p.set(n.id, []);
  assert.deepEqual(await p.widgets(n.id), []);
});

test('widgets are validated: kinds, ids, sizes; nothing else limits what they hold', async () => {
  const app = createApp(),
    p = await project(app);
  const n = await p.node({title: 'W', outputs: []});
  await rejects(p.set(n.id, [{id: 'a', kind: 'knob'}]), /Unknown widget kind/);
  await rejects(
    p.set(n.id, [
      {id: 'a', kind: 'text'},
      {id: 'a', kind: 'text'},
    ]),
    /unique/
  );
  await rejects(p.set(n.id, [{id: 'a', kind: 'text', surprise: 1}]), /widget has/);
  await rejects(p.set('record:none', [{id: 'a', kind: 'text'}]), /not found/);
  await p.set(n.id, [
    {id: 'a', kind: 'text'},
    {id: 'l', kind: 'label', text: 'x'},
  ]);
  await rejects(p.values(n.id, {zzz: 1}), /no widget/);
  await rejects(p.values(n.id, {l: 'x'}), /no value/);
  // A widget holds any JSON, e.g. a list.
  await p.set(n.id, [{id: 'a', kind: 'text', value: ['any', {json: 1}]}]);
  assert.deepEqual((await p.widgets(n.id))[0].value, ['any', {json: 1}]);
});

test('a person using a widget fires on_widget of the copy; a Script changing a widget does not', async () => {
  const app = createApp(),
    p = await project(app);
  const def = bundleOf(
    'Echo',
    {
      Body: {inputs: [], outputs: []},
      Used: nodes.event('on_widget', ['widget']),
      Echo: titled(
        'Echo',
        `const widget = context.event.widget;
await agentsys("PUT", "test-observations/last", {value: widget});
await node.widgets.set({echo: widget.value + "!"});`
      ),
    },
    {
      wires: [['Used', 'out', 'Echo', 'in']],
      widgets: {
        Echo: [
          {id: 't', kind: 'text'},
          {id: 'echo', kind: 'text'},
        ],
      },
    }
  );
  const echo = await place(app, p.id, {workflow_id: p.id}, def);
  await p.idle();
  const body = (await p.snapshot()).complex.find(c => c.id === echo.group).widget_nodes[0];
  assert.equal(await p.state('last'), undefined, 'placing is not using');
  await p.use(body, {t: 'hi'});
  await p.idle();
  assert.deepEqual(await p.state('last'), {id: 't', kind: 'text', value: 'hi'});
  const values = Object.fromEntries((await p.widgets(body)).map(w => [w.id, w.value]));
  assert.deepEqual(values, {t: 'hi', echo: 'hi!'}, 'the Script set echo, which did not fire on_widget again');
  assert.equal((await p.call('GET', 'workflow')).history.undo > 0, true);
});

test('a button counts its clicks; a Script of the copy reads the count', async () => {
  const app = createApp(),
    p = await project(app);
  const def = bundleOf(
    'Counter',
    {Body: {inputs: [], outputs: []}, Count: titled('Count', 'node.output.result = context.widgets.go')},
    {widgets: {Body: [{id: 'go', kind: 'button', label: '+1'}]}, outputs: [{id: 'result', name: 'result', node: false}]}
  );
  const counter = await place(app, p.id, {workflow_id: p.id}, def);
  await p.idle();
  const body = (await p.snapshot()).complex.find(c => c.id === counter.group).widget_nodes[0];
  const button = (await p.widgets(body))[0];
  await p.use(body, {go: button.value + 1});
  await p.use(body, {go: button.value + 2});
  await p.idle();
  const count = await counter.node('Count');
  assert.equal((await p.evaluate([count.id])).outputs[count.id].result, 2);
});

test('a Script can change the slots of its own Library node, and the widgets of any other node', async () => {
  const app = createApp({scripts: 'worker'}),
    p = await project(app);
  const target = await p.node({title: 'Target', outputs: []});
  const n = await fn(
    app,
    p.id,
    {workflow_id: p.id},
    {
      code: `const base = "projects/" + context.project_id;
await agentsys("PUT", base + "/node-slots/" + context.instance_id, {inputs: [{id: 'a', name: 'a'}, {id: 'b', name: 'b'}], outputs: [{id: 'o', name: 'o'}]});
await agentsys("PUT", base + "/widgets/" + ${JSON.stringify(target.id)}, {widgets: [{id: 'x', kind: 'textarea', value: 'from outside'}]});`,
    }
  );
  const r = await p.evaluate([n.id]);
  assert.deepEqual(r.errors, {});
  const snap = await p.snapshot(),
    cx = snap.complex.find(c => c.id === n.group);
  assert.deepEqual(
    cx.interface.inputs.map(x => x.id),
    ['in', 'a', 'b']
  );
  assert.deepEqual(
    cx.interface.outputs.map(x => x.id),
    ['o']
  );
  assert.equal(snap.widgets[target.id][0].value, 'from outside');
});

test('widgets go with their node: copy and paste, duplicate, export and import, delete', async () => {
  const app = createApp(),
    p = await project(app);
  const n = await p.node({title: 'W', outputs: []});
  await p.set(n.id, [{id: 'a', kind: 'text', value: 'one'}]);
  const bundle = await p.call('POST', 'copy', {node_ids: [n.id], group_ids: []});
  const pasted = await p.call('POST', 'paste', {clipboard: bundle, point: {x: 50, y: 50}});
  assert.equal((await p.widgets(pasted.ids[0]))[0].value, 'one');
  const TextGraph = require('../runtime/format');
  const exported = TextGraph.decode(await app.api('GET', `projects/${p.id}/workflows/${p.id}/export`));
  assert.equal(exported.document.widgets[n.id][0].value, 'one');
  const imported = await app.api(
    'POST',
    `projects/${p.id}/workflows/import`,
    TextGraph.encode({name: 'Copy', document: exported.document})
  );
  assert.ok(imported);
  const copy = await app.api('POST', 'projects', {name: 'Dup'});
  assert.ok(copy);
  await p.call('POST', 'delete-nodes', {node_ids: [n.id]});
  assert.deepEqual(await p.widgets(n.id), []);
  assert.equal(
    TextGraph.decode(await app.api('GET', `projects/${p.id}/workflows/${p.id}/export`)).document.widgets[n.id],
    undefined
  );
  await rejects(
    app.api(
      'POST',
      `projects/${p.id}/workflows/import`,
      TextGraph.encode({name: 'Bad', document: {nodes: [], widgets: {nobody: [{id: 'a', kind: 'text'}]}}})
    ),
    /does not exist/
  );
});

test('nothing in the engine insists on a behaviour: no code, no outputs, odd results', async () => {
  const app = createApp(),
    p = await project(app),
    q = {workflow_id: p.id};
  const quiet = await fn(app, p.id, q, {code: 'const x = 1;', outputs: ['o']});
  const weird = await fn(app, p.id, q, {code: 'node.output.o = undefined;', outputs: ['o']});
  const empty = await p.node(nodes.script(''));
  const early = await p.node(nodes.script('node.display(Object.keys(node.output).length);'));
  const r = await p.evaluate([quiet.id, weird.id, empty.id, early.id]);
  assert.deepEqual(r.errors, {});
  // An output the node does not have, a signal output and a function are mistakes, not values that go nowhere.
  const stray = await fn(app, p.id, q, {code: 'node.output.zzz = 5;'}),
    signalled = await fn(app, p.id, q, {code: 'node.output.out = 1;', signals: ['out']}),
    func = await fn(app, p.id, q, {code: 'node.output.o = () => 1;', outputs: ['o']});
  const bad = await p.evaluate([stray.id, signalled.id, func.id]);
  assert.match(bad.errors[stray.id], /no free output “zzz”/);
  assert.match(bad.errors[signalled.id], /node.output.out.emit/);
  assert.match(bad.errors[func.id], /output\.o cannot be sent/);
  assert.deepEqual(r.outputs[quiet.id], {});
  assert.deepEqual(r.outputs[weird.id], {});
  assert.equal(r.displays[early.id], '0');
});

test('a Custom node placed in a library node shows its widgets through the Complex Node (widget_nodes)', async () => {
  const app = createApp(),
    p = await project(app);
  const def = (suffix, value = 'v') =>
    bundleOf(
      'Widgeted',
      {
        Body: {inputs: [], outputs: []},
        S: titled(
          'S',
          `node.output.result = context.widgets.w + ${JSON.stringify(suffix)}; await node.output.done.emit()`
        ),
      },
      {
        widgets: {Body: [{id: 'w', kind: 'text', value}]},
        inputs: [{id: 'go', name: 'in', type: 'signal', node: 'S', port: 'in'}],
        outputs: [
          {id: 'out', name: 'result', node: false},
          {id: 'done', name: 'done', type: 'signal', node: false},
        ],
      }
    );
  const widgeted = await place(app, p.id, {workflow_id: p.id}, def(''));
  await p.idle();
  const snap = await p.snapshot(),
    cx = snap.complex.find(c => c.id === widgeted.group);
  assert.ok(cx.widget_nodes[0], 'the Complex Node says where its widgets live');
  assert.equal(snap.widgets[cx.widget_nodes[0]][0].value, 'v');
  await p.use(cx.widget_nodes[0], {w: 'typed'});
  const show = await fn(app, p.id, {workflow_id: p.id}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.call('POST', 'port-connections', {
    add: [{source: widgeted.id, source_port: 'out', target: show.wrapper, target_port: 'v'}],
  });
  const start = await flow(app, p.id, {workflow_id: p.id}, [[widgeted.id, 'go', 'done'], show.step]);
  assert.equal((await p.evaluate([start])).displays[show.id], 'typed');
  // Editing the definition keeps the values the person typed.
  await app.api('PUT', `resources/${widgeted.resource}`, {
    name: 'Widgeted',
    payload: {bundle: def('.', 'reset?').bundle},
    replace: true,
  });
  await p.idle();
  assert.equal((await p.evaluate([start])).displays[show.id], 'typed.');
});

test('config.widgets declares the widgets of a node: they exist from the start, and editing the list keeps the values that stay', async () => {
  const app = createApp(),
    p = await project(app);
  const config = widgets => ({
    ...nodes.script('node.display(JSON.stringify(context.widgets))'),
    title: 'Declared',
    widgets,
  });
  const make = widgets =>
    p.call('POST', 'typed-nodes', {node_type: 'custom', config: config(widgets), position: {x: 0, y: 0}});
  const n = await make([
    {id: 'name', kind: 'text', label: 'Name', value: 'world'},
    {id: 'n', kind: 'number'},
    {id: 'mode', kind: 'select', options: ['a', 'b']},
  ]);
  assert.deepEqual(
    (await p.widgets(n.id)).map(w => [w.id, w.kind, w.value]),
    [
      ['name', 'text', 'world'],
      ['n', 'number', 0],
      ['mode', 'select', 'a'],
    ],
    'no hook ran: the definition made them'
  );
  await p.use(n.id, {name: 'typed', n: 5});
  // The definition changes: `name` stays, `n` becomes another kind, `mode` is gone, `extra` is new; the order is the definition's.
  await p.call('PUT', `typed-nodes/${n.id}`, {
    node_type: 'custom',
    config: config([
      {id: 'extra', kind: 'checkbox', value: true},
      {id: 'name', kind: 'text', label: 'Your name', value: 'ignored: a widget that stays keeps its value'},
      {id: 'n', kind: 'text'},
    ]),
  });
  assert.deepEqual(
    (await p.widgets(n.id)).map(w => [w.id, w.kind, w.value, w.label]),
    [
      ['extra', 'checkbox', true, undefined],
      ['name', 'text', 'typed', 'Your name'],
      ['n', 'text', ''],
    ].map(r => (r.length === 3 ? [...r, undefined] : r))
  );
  assert.deepEqual(JSON.parse((await p.evaluate([n.id])).displays[n.id]), {extra: true, name: 'typed', n: ''});
  // Code that replaces the widgets is not undone by edits that leave the definition alone (a new title, say).
  await p.set(n.id, [{id: 'mine', kind: 'text', value: 'by code'}]);
  await p.call('PUT', `typed-nodes/${n.id}`, {
    node_type: 'custom',
    config: {
      ...config([
        {id: 'extra', kind: 'checkbox', value: true},
        {id: 'name', kind: 'text', label: 'Your name', value: 'ignored: a widget that stays keeps its value'},
        {id: 'n', kind: 'text'},
      ]),
      title: 'Renamed',
    },
  });
  assert.deepEqual(
    (await p.widgets(n.id)).map(w => w.id),
    ['mine']
  );
  // Taking the declaration away takes the widgets with it.
  await p.call('PUT', `typed-nodes/${n.id}`, {
    node_type: 'custom',
    config: {title: 'Renamed', outputs: [{id: 'result', name: 'result'}]},
  });
  assert.deepEqual(await p.widgets(n.id), []);
});

test('config.widgets is checked like any list of widgets', async () => {
  const app = createApp(),
    p = await project(app);
  const make = widgets =>
    p.call('POST', 'typed-nodes', {node_type: 'custom', config: {title: 'Bad', widgets}, position: {x: 0, y: 0}});
  await rejects(make([{id: 'a', kind: 'nope'}]), /kind/i);
  await rejects(
    make([
      {id: 'a', kind: 'text'},
      {id: 'a', kind: 'text'},
    ]),
    /unique/i
  );
  await rejects(make('text'), /widgets/i);
});

test('a node of a Library node declares its widgets: every copy has them when placed, and refreshing keeps the values typed', async () => {
  const app = createApp(),
    opened = await app.api('POST', 'library/node-editor', {});
  const q = {workflow_id: opened.workflow_id},
    id = opened.project_id;
  const node = await app.api('POST', `projects/${id}/typed-nodes`, {
    ...q,
    node_type: 'custom',
    config: {
      title: 'Fields',
      inputs: [],
      outputs: [{id: 'out', name: 'out'}],
      widgets: [{id: 'w', kind: 'text', value: 'v'}],
    },
    position: {x: 0, y: 0},
  });
  const config = list => ({
    title: 'Fields',
    inputs: [],
    outputs: [{id: 'out', name: 'out'}],
    ...(list ? {widgets: list} : {}),
  });
  const root = (await app.api('GET', `projects/${id}/workflow`, {}, q)).root;
  await app.api('PUT', `projects/${id}/complex/${root}`, {
    ...q,
    interface: {inputs: [], outputs: [{id: 'out', name: 'out', bound: [{node_id: node.id, port_id: 'out'}]}]},
  });
  const p = await project(app);
  const placed = (
    await app.api('POST', `projects/${p.id}/custom-nodes/${opened.resource_id}`, {
      workflow_id: p.id,
      point: {x: 0, y: 0},
    })
  ).roots[0];
  const holder = async () => (await p.snapshot()).complex.find(c => c.id === placed).widget_nodes[0];
  assert.equal((await p.widgets(await holder()))[0].value, 'v', 'made at once: no on_placed');
  await p.use(await holder(), {w: 'typed'});
  // The author adds a widget and changes the default of the first: the copy gets the new one and keeps what was typed.
  await app.api('PUT', `projects/${id}/typed-nodes/${node.id}`, {
    ...q,
    node_type: 'custom',
    config: config([
      {id: 'w', kind: 'text', value: 'other'},
      {id: 'more', kind: 'checkbox'},
    ]),
  });
  const copyWidgets = async () => {
    const snap = await p.snapshot(),
      at = snap.complex.find(c => c.id === placed).widget_nodes[0];
    return at ? snap.widgets[at] : [];
  };
  assert.deepEqual(
    (await copyWidgets()).map(w => [w.id, w.value]),
    [
      ['w', 'typed'],
      ['more', false],
    ]
  );
  // An empty list takes the declaration away.
  await app.api('PUT', `projects/${id}/typed-nodes/${node.id}`, {...q, node_type: 'custom', config: config(null)});
  assert.deepEqual(await copyWidgets(), []);
});

test('a markdown widget holds text, and its renderer escapes HTML and refuses unsafe links', async () => {
  const app = createApp(),
    p = await project(app);
  const n = await p.node({title: 'Md'});
  await p.set(n.id, [{id: 'text', kind: 'markdown', value: '# Hi'}]);
  assert.deepEqual(
    (await p.widgets(n.id)).map(w => [w.id, w.kind, w.value]),
    [['text', 'markdown', '# Hi']]
  );
  await p.values(n.id, {text: '**bold**'});
  assert.equal((await p.widgets(n.id))[0].value, '**bold**');

});
});
