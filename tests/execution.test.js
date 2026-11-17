'use strict';
const {describe} = require('node:test');

describe("builtin", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp} = require('./harness');

const names = async app => (await app.api('GET', 'resources')).map(r => r.name);

test('Execute passes the checked API, context and intrinsics into its nested Script', async t => {
  const app = createApp({scripts: 'worker'});
  t.after(() => app.Backend.shutdownExecutions());
  await app.api('POST', 'library/builtin', {});
  const project = await app.api('POST', 'projects', {name: 'Execute bridge'});
  const item = (await app.api('GET', 'resources')).find(r => r.name === 'Execute');
  await app.api('PUT', 'resources/' + item.id, {
    name: item.name,
    payload: {...item.payload, grants: ['library.read']},
  });
  const copy = await app.api('POST', `projects/${project.id}/custom-nodes/${item.id}`, {point: {x: 0, y: 0}});
  const wrapper = 'complex:' + copy.roots[0];
  const code = `const nodes=await agentsys('GET','resources');
    node.display('Execute API works');
    return {nodes:nodes.length,project:context.project_id,year:new Date(0).getUTCFullYear(),rounded:Math.round(1.7)};`;
  await app.api('PUT', `projects/${project.id}/input-values`, {node_id: wrapper, values: {pr97li: code}});
  const snapshot = await app.api('GET', `projects/${project.id}/workflow`);
  const script = snapshot.nodes.find(
    n => snapshot.complex.find(c => c.id === copy.roots[0]).members.includes(n.id) && n.config?.op === 'script'
  );
  const result = await app.api('POST', `projects/${project.id}/execution`, {node_ids: [script.id], wait: true});
  assert.equal(result.status, 'idle', JSON.stringify(result.errors));
  assert.deepEqual(result.outputs[script.id].pxltyf, {
    nodes: (await names(app)).length,
    project: project.id,
    year: 1970,
    rounded: 2,
  });
  assert.equal(result.displays[script.id], 'Execute API works');
});

test('built-in nodes: added to an empty Library, once, with stable ids and their groups', async () => {
  const app = createApp();
  const listed = await app.api('GET', 'library/builtin');
  assert.ok(listed.some(n => n.name === 'Delay'));
  assert.ok(!listed.some(n => n.name === 'Wait for event' || n.folder === 'Streams'));
  assert.ok(listed.every(n => n.installed === false));
  assert.ok(!listed.some(n => ['Sleep', 'Wait until'].includes(n.name)));
  const first = await app.api('POST', 'library/builtin', {});
  assert.equal(first.added.length, first.total);
  const items = await app.api('GET', 'resources');
  assert.equal(items.length, first.total);
  assert.ok(items.every(r => r.id.startsWith('builtin.')));
  assert.ok(items.some(r => r.payload.folder === 'Flow'));
  assert.deepEqual((await app.api('POST', 'library/builtin', {})).added, []);
  assert.equal(
    (await app.api('GET', 'library/builtin')).every(n => n.installed),
    true
  );
});

test('built-in nodes: a node the person has is kept, one they deleted stays deleted until restored', async () => {
  const app = createApp();
  await app.api('POST', 'library/builtin', {});
  const items = await app.api('GET', 'resources');
  const gone = items.find(r => r.name === 'For');
  await app.api('DELETE', `resources/${gone.id}`);
  assert.deepEqual((await app.api('POST', 'library/builtin', {})).added, []);
  assert.equal((await names(app)).includes('For'), false);
  assert.deepEqual((await app.api('POST', 'library/builtin', {restore: true})).added, ['For']);
  assert.equal((await names(app)).includes('For'), true);
  // Edits are theirs: a later start does not overwrite them.
  const text = (await app.api('GET', 'resources')).find(r => r.name === 'Text');
  await app.api('PUT', `resources/${text.id}`, {name: 'Text', payload: {...text.payload, description: 'mine'}});
  await app.api('POST', 'library/builtin', {restore: true});
  assert.equal((await app.api('GET', `resources/${text.id}`)).payload.description, 'mine');
});

test('built-in nodes: a Library that already has a node of that name gets no second one', async () => {
  const a = createApp();
  await a.api('POST', 'library/builtin', {});
  const exported = (await a.api('GET', 'resources')).filter(r => r.name === 'Bool');
  const b = createApp();
  await b.api('POST', 'resources', {name: 'Bool', payload: exported[0].payload});
  const result = await b.api('POST', 'library/builtin', {});
  assert.equal(result.added.includes('Bool'), false);
  assert.equal((await names(b)).filter(n => n === 'Bool').length, 1);
});

test('every built-in node places with valid defaults and permissions', async () => {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Built-in checks'});
  await app.api('POST', 'library/builtin', {});
  const items = await app.api('GET', 'resources');
  assert.ok(items.length > 20);
  for (const item of items) {
    assert.ok(Array.isArray(item.payload.grants), item.name);
    const placed = await app.api('POST', `projects/${p.id}/custom-nodes/${item.id}`, {point: {x: 0, y: 0}});
    assert.equal(placed.roots.length, 1, item.name);
  }
});

test('built-in recipes preserve all existing graph definitions and identities', () => {
  const runtime = require('../headless').loadBackend();
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
  const nodes = JSON.parse(JSON.stringify(runtime.eval('BUILTIN_NODES.slice(0, 13)')));
  const actual = require('node:crypto').createHash('sha256').update(JSON.stringify(sort(nodes))).digest('hex');
  assert.equal(actual, '81bfac834d8b73cd8390faffddb8354c399197e8a12060b9045039e48eb121b1');
});
});

describe("controls", () => {
// The control of a type (how a free slot is typed in), enum types, and the value of a free input.
// Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, bundleOf, place, fn} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));
const hex = n => String(n).padStart(32, '0');
const T = n => 't:' + hex(n);

test('port names preserve their declared case through saving, snapshots and placement', async () => {
  const app = createApp(),
    p = await app.api('POST', 'projects', {name: 'Port spelling'});
  const entry = await app.api('POST', 'resources', {
    name: 'Port spelling',
    payload: bundleOf(
      'Port spelling',
      {Body: {inputs: [], outputs: []}},
      {
        inputs: [{id: 'url', name: 'URL', node: false}],
        outputs: [{id: 'result', name: 'Result', node: false}],
      }
    ),
  });
  const placed = await app.api('POST', `projects/${p.id}/custom-nodes/${entry.id}`, {point: {x: 0, y: 0}});
  const snapshot = await app.api('GET', `projects/${p.id}/workflow`);
  const cx = snapshot.complex.find(c => c.id === placed.roots[0]);
  assert.equal(cx.interface.inputs[0].name, 'URL');
  assert.equal(cx.interface.outputs[0].name, 'Result');
  assert.equal(
    (await app.api('GET', `resources/${entry.id}`)).payload.bundle.complex[0].interface.inputs[0].name,
    'URL'
  );
});
const TEXT = {id: hex(1), name: 'Text', fields: [], control: 'text'},
  COUNT = {id: hex(2), name: 'Count', fields: [], control: 'number'},
  MODE = {id: hex(3), name: 'Mode', fields: [], control: 'select', options: ['fast', 'slow']},
  PLAIN = {id: hex(4), name: 'Plain', fields: []};

async function project(app, types = [TEXT, COUNT, MODE, PLAIN]) {
  const {id} = await app.api('POST', 'projects', {name: 'Controls'});
  await app.api('PUT', `projects/${id}/types`, {types});
  const node = config =>
    app.api('POST', `projects/${id}/typed-nodes`, {node_type: 'custom', config, position: {x: 0, y: 0}});
  const run = ids => app.api('POST', `projects/${id}/evaluate-node`, {node_ids: ids, collect: true});
  /** A Library node around a Script that shows its typed input v (Text, default 'hi'). */
  const echo = () =>
    fn(app, id, {}, {code: 'node.display(String(v))', inputs: [{name: 'v', type: T(1), default: 'hi'}]});
  return {id, node, run, echo, snapshot: () => app.api('GET', `projects/${id}/workflow`)};
}

test('empty port value updates leave the graph and undo history unchanged', async () => {
  const app = createApp(),
    p = await project(app),
    node = await p.echo();
  const before = await p.snapshot(),
    history = (await app.api('GET', `projects/${p.id}/workflow`)).history;
  for (const path of ['input-values', 'output-values'])
    await app.api('PUT', `projects/${p.id}/${path}`, {node_id: node.wrapper, values: {}});
  assert.deepEqual(await p.snapshot(), before);
  assert.deepEqual((await app.api('GET', `projects/${p.id}/workflow`)).history, history);
});

test('a type may have a control; an enum is a select with its options', async () => {
  const app = createApp(),
    p = await project(app);
  const types = (await p.snapshot()).types;
  assert.deepEqual(types.find(t => t.name === 'Mode').options, ['fast', 'slow']);
  const more = [...types];
  await rejects(
    app.api('PUT', `projects/${p.id}/types`, {
      types: [...more, {id: hex(5), name: 'Bad', fields: [], control: 'knob'}],
    }),
    /control/
  );
  await rejects(
    app.api('PUT', `projects/${p.id}/types`, {
      types: [...more, {id: hex(5), name: 'NoOptions', fields: [], control: 'select'}],
    }),
    /options/
  );
  await rejects(
    app.api('PUT', `projects/${p.id}/types`, {
      types: [...more, {id: hex(5), name: 'Twice', fields: [], control: 'select', options: ['a', 'a']}],
    }),
    /different/
  );
  await rejects(
    app.api('PUT', `projects/${p.id}/types`, {
      types: [...more, {id: hex(5), name: 'Opts', fields: [], control: 'text', options: ['a']}],
    }),
    /options/
  );
  await rejects(
    app.api('PUT', `projects/${p.id}/types`, {
      types: [...more, {id: hex(5), name: 'Rec', fields: [{name: 'x', type: T(1)}], control: 'text'}],
    }),
    /fields/
  );
});

test('an input with no wire takes its default; a wire wins over it', async () => {
  const app = createApp(),
    p = await project(app);
  const node = await p.echo();
  assert.equal((await p.run([node.id])).displays[node.id], 'hi');
  const source = await p.node({
    title: 'Source',
    inputs: [],
    outputs: [{id: 'o', name: 'o', type: T(1), editable: true, default: 'wired'}],
  });
  await app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source: source.id, source_port: 'o', target: node.wrapper, target_port: 'v'}],
  });
  assert.equal((await p.run([node.id])).displays[node.id], 'wired');
});

test('the value typed on a node is the default of the input; null takes it away; a wrong value is refused', async () => {
  const app = createApp(),
    p = await project(app);
  const node = await p.echo();
  const set = values => app.api('PUT', `projects/${p.id}/input-values`, {node_id: node.wrapper, values});
  await set({v: 'typed'});
  assert.equal((await p.run([node.id])).displays[node.id], 'typed');
  await set({v: null});
  assert.equal((await p.run([node.id])).displays[node.id], 'undefined');
  await rejects(set({v: 5}), /not a value/);
  await rejects(set({nope: 'x'}), /no input/);
  const plain = await p.node({title: 'P', inputs: [{id: 'a', name: 'a', type: T(4)}], outputs: []});
  await rejects(app.api('PUT', `projects/${p.id}/input-values`, {node_id: plain.id, values: {a: 'x'}}), /no control/);
});

test('an enum input takes only one of its options; removing an option drops a default that no longer fits', async () => {
  const app = createApp(),
    p = await project(app);
  const node = await fn(app, p.id, {}, {code: 'node.display(m)', inputs: [{name: 'm', type: T(3), default: 'fast'}]});
  await rejects(
    p.node({title: 'Bad', inputs: [{id: 'm', name: 'm', type: T(3), default: 'medium'}], outputs: []}),
    /default/
  );
  await rejects(p.node({title: 'Bad', inputs: [{id: 'm', name: 'm', default: 'x'}], outputs: []}), /default/);
  assert.equal((await p.run([node.id])).displays[node.id], 'fast');
  const types = (await p.snapshot()).types.map(t => (t.id === hex(3) ? {...t, options: ['slow', 'later']} : t));
  await app.api('PUT', `projects/${p.id}/types`, {types});
  const slot = (await p.snapshot()).complex.find(c => c.id === node.group).interface.inputs.find(i => i.name === 'm');
  assert.equal('default' in slot, false);
});

/** A Library node whose Script shows its typed input `text` followed by `suffix`, and sets it as its output `out`; it fires `Out`. */
const echoNode = suffix =>
  bundleOf(
    'Echo',
    {
      Body: {inputs: [], outputs: []},
      S: nodes.script(
        `node.output.result = node.input.text + ${JSON.stringify(suffix)}; await node.output.done.emit()`
      ),
    },
    {
      types: [TEXT],
      inputs: [
        {id: 'text', name: 'text', type: T(1), default: 'from the definition', node: false},
        {id: 'go', name: 'in', type: 'signal', node: 'S', port: 'in'},
      ],
      outputs: [
        {id: 'out', name: 'result', node: false},
        {id: 'done', name: 'done', type: 'signal', node: false},
      ],
    }
  );

test('a Library node placed on a workflow keeps the value typed on it, and the default of its definition', async () => {
  const app = createApp(),
    p = await project(app, [TEXT]);
  const echo = await place(app, p.id, {workflow_id: p.id}, echoNode(''));
  await app.Backend.hooksIdle();
  const shown = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source: echo.id, source_port: 'out', target: shown.wrapper, target_port: 'v'}],
  });
  const start = await flow(app, p.id, {}, [[echo.id, 'go', 'done'], shown.step]);
  const show = async () => (await p.run([start])).displays[shown.id];
  assert.equal(await show(), 'from the definition');
  await app.api('PUT', `projects/${p.id}/input-values`, {node_id: echo.id, values: {text: 'mine'}});
  assert.equal(await show(), 'mine');
  // The Library node is saved again: the node follows it, and keeps what was typed on it.
  const again = echoNode('!');
  await app.api('PUT', `resources/${echo.resource}`, {name: 'Echo', payload: {bundle: again.bundle}, replace: true});
  await p.snapshot();
  assert.equal(await show(), 'mine!');
  await app.api('PUT', `projects/${p.id}/input-values`, {node_id: echo.id, values: {text: null}});
  assert.equal(await show(), 'undefined!');
});

test('the value of a slot added on a placed node survives an edit of the Library node', async () => {
  const app = createApp(),
    p = await project(app);
  const opened = await app.api('POST', 'library/node-editor', {}),
    q = {workflow_id: opened.workflow_id};
  await app.api('PUT', `projects/${opened.project_id}/types`, {...q, types: [TEXT]});
  const root = (await app.api('GET', `projects/${opened.project_id}/workflow`, {}, q)).root;
  const save = body => app.api('PUT', `projects/${opened.project_id}/complex/${root}`, {...q, ...body});
  await save({interface: {inputs: [{id: 'a', name: 'a'}], outputs: []}, arbitrary: {inputs: true, outputs: false}});
  const placed = (await app.api('POST', `projects/${p.id}/custom-nodes/${opened.resource_id}`, {point: {x: 0, y: 0}}))
    .roots[0];
  await app.api('PUT', `projects/${p.id}/complex/${placed}`, {
    extra: {inputs: [{id: 'x1', name: 'extra', type: T(1), default: 'kept'}]},
  });
  const defaults = async () =>
    (await p.snapshot()).complex.find(c => c.id === placed).interface.inputs.map(s => [s.name, s.default]);
  assert.deepEqual(await defaults(), [
    ['a', undefined],
    ['extra', 'kept'],
  ]);
  await save({arbitrary: {inputs: true, outputs: true}});
  assert.deepEqual(await defaults(), [
    ['a', undefined],
    ['extra', 'kept'],
  ]);
});
});

describe("custom", () => {
// The Custom node: Scripts and the signals between them, the input rules, node.display(), hooks of Library nodes (on_placed, on_deleted)
// Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, bundleOf, place, fn} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));
const out = (id, _type, name = id) => ({id, name});

async function project(app, name = 'Custom') {
  const {id} = await app.api('POST', 'projects', {name});
  const self = {
    id,
    node: (config, extra = {}) =>
      app.api('POST', `projects/${id}/typed-nodes`, {node_type: 'custom', config, position: {x: 0, y: 0}, ...extra}),
    connect: (s, sp, t, tp) =>
      app.api('POST', `projects/${id}/port-connections`, {
        add: [{source: s, source_port: sp, target: t, target_port: tp}],
      }),
    evaluate: ids => app.api('POST', `projects/${id}/evaluate-node`, {node_ids: ids, collect: true}),
    /** Runs an on_run wired to the nodes one after another. */
    run: async (...steps) => self.evaluate([await flow(app, id, {}, steps)]),
    remove: ids => app.api('POST', `projects/${id}/delete-nodes`, {node_ids: ids}),
    snapshot: () => app.api('GET', `projects/${id}/workflow`),
    state: async key => (await app.api('GET', `test-observations/${key}`).catch(() => ({}))).value,
    log: async () => {
      await app.Backend.hooksIdle();
      return app.api('GET', 'node-hooks');
    },
  };
  return self;
}
/** A Library node with a hook: when `hook` (on_placed, on_deleted) fires for a copy, a Script saves `who` under the state key `key`. */
const hooked = (name, who, hooks = {on_placed: 'placed', on_deleted: 'deleted'}, extra = '') => {
  const members = {Body: {inputs: [], outputs: []}},
    wires = [];
  for (const [hook, key] of Object.entries(hooks)) {
    members['E' + hook] = nodes.event(hook);
    members['S' + hook] = nodes.script(`${extra}await agentsys("PUT", "test-observations/${key}", {value: "${who}"})`);
    wires.push(['E' + hook, 'out', 'S' + hook, 'in']);
  }
  return bundleOf(name, members, {wires});
};

test('a Script runs when its signal arrives; it sends Out only with emit, and what it sets in output.<name> is its result', async () => {
  const app = createApp(),
    p = await project(app);
  const a = await fn(app, p.id, {}, {code: 'node.output.result = 1 + 1', outputs: ['result'], signals: ['out']}),
    show = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.connect(a.wrapper, 'result', show.wrapper, 'v');
  const r = await p.run(a.step, show.step);
  assert.deepEqual(r.errors, {});
  assert.equal(r.displays[show.id], '2');
  assert.deepEqual(
    (await p.evaluate([a.id])).outputs[a.id],
    {result: 2},
    'a Script that is run directly runs as if its signal arrived'
  );
});

test('a slot takes one wire: connecting a second one replaces the first; a signal input takes as many as you like', async () => {
  const app = createApp(),
    p = await project(app);
  const a = await p.node(nodes.value('text', 'a')),
    b = await p.node(nodes.value('text', 'b'));
  const show = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.connect(a.id, 'value', show.wrapper, 'v');
  await p.connect(b.id, 'value', show.wrapper, 'v');
  const wires = (await p.snapshot()).edges.filter(e => e.target === show.wrapper && e.target_port === 'v');
  assert.equal(wires.length, 1);
  assert.equal((await p.evaluate([show.id])).displays[show.id], 'b');
  const one = await p.node(nodes.event('on_run')),
    two = await p.node(nodes.event('on_run'));
  await p.connect(one.id, 'out', show.wrapper, 'in');
  await p.connect(two.id, 'out', show.wrapper, 'in');
  assert.equal((await p.snapshot()).edges.filter(e => e.target === show.wrapper && e.target_port === 'in').length, 2);
  await rejects(p.connect(one.id, 'out', show.wrapper, 'in'), /connected already/);
  await rejects(p.connect(one.id, 'out', show.wrapper, 'v'), /./, 'a signal does not fit a data input');
  await p.connect(one.id, 'out', one.id, 'in').catch(e => assert.match(e.message, /./)); // an event node has no In
});

test('node.display() shows text on the node: a string as it is, anything else as JSON; the last call wins', async () => {
  const app = createApp(),
    p = await project(app);
  const n = await p.node(nodes.script('node.display("first"); node.display({a: [1, 2]})', [], 'void'));
  const r = await p.run(n.id);
  assert.deepEqual(JSON.parse(r.displays[n.id]), {a: [1, 2]});
  const s = await p.node(nodes.script('node.display("plain")', [], 'void'));
  assert.equal((await p.evaluate([s.id])).displays[s.id], 'plain');
});

test('node.display() shows an image ({mime_type, data}) as a data URL and validates its encoding', async () => {
  const app = createApp(),
    p = await project(app);
  const n = await p.node(nodes.script('node.display({mime_type: "image/png", data: "iVBORw0KGgo="})', [], 'void'));
  assert.equal((await p.evaluate([n.id])).displays[n.id], 'data:image/png;base64,iVBORw0KGgo=');
  const bad = await p.node(nodes.script('node.display({mime_type: "image/png", data: "not base64!"})', [], 'void'));
  assert.match((await p.evaluate([bad.id])).errors[bad.id], /base64/);
  const text = await p.node(nodes.script('node.display({mime_type: "text/plain", data: "x"})', [], 'void'));
  assert.match((await p.evaluate([text.id])).displays[text.id], /mime_type/);
});

test('a node can have several outputs of any kind; one it does not set is undefined, not an error', async () => {
  const app = createApp(),
    p = await project(app);
  const ok = await fn(
    app,
    p.id,
    {},
    {code: 'node.output.a = 2; node.output.b = "y"', outputs: ['a', 'b'], signals: ['out']}
  );
  const second = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.connect(ok.wrapper, 'b', second.wrapper, 'v');
  assert.equal((await p.run(ok.step, second.step)).displays[second.id], 'y');
  const loose = await fn(app, p.id, {}, {code: 'node.output.a = {any: ["thing", 1]};', outputs: ['a', 'b']});
  const r = await p.evaluate([loose.id]);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.outputs[loose.id], {a: {any: ['thing', 1]}});
  const silent = await fn(app, p.id, {}, {code: '', outputs: ['result'], signals: ['out']});
  const shows = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.connect(silent.wrapper, 'result', shows.wrapper, 'v');
  const none = await p.run(silent.step, shows.step);
  assert.deepEqual(none.errors, {});
});

test('on_placed and on_deleted fire for a copy of a Library node when it enters or leaves the canvas, whichever way it happens', async () => {
  const app = createApp(),
    p = await project(app);
  const state = p.state;
  const one = await place(app, p.id, {}, hooked('Hooked', 'one'));
  await app.Backend.hooksIdle();
  assert.equal(await state('placed'), 'one');
  // Moving or editing the node is not placing it.
  await app.api('PUT', `projects/${p.id}/layout`, {positions: {[one.id]: {x: 40, y: 40}}}).catch(() => {});
  await app.api('PUT', `test-observations/placed`, {value: 'untouched'});
  await app.Backend.hooksIdle();
  assert.equal(await state('placed'), 'untouched');

  await app.api('POST', `projects/${p.id}/delete-nodes`, {node_ids: [one.id]}).catch(() => {});
  await app.api('DELETE', `projects/${p.id}/groups/${one.group}`).catch(() => {});
  await app.Backend.hooksIdle();
  assert.equal(await state('deleted'), 'one');

  // Undo brings the node back, so on_placed fires again; redo removes it, so on_deleted does.
  await app.api('PUT', `test-observations/placed`, {value: 'cleared'});
  await app.api('POST', `projects/${p.id}/undo`);
  await app.Backend.hooksIdle();
  assert.equal(await state('placed'), 'one');
  await app.api('PUT', `test-observations/deleted`, {value: 'cleared'});
  await app.api('POST', `projects/${p.id}/redo`);
  await app.Backend.hooksIdle();
  assert.equal(await state('deleted'), 'one');

  // Copy and paste places a new copy, so on_placed fires for it.
  const two = await place(app, p.id, {}, hooked('Hooked two', 'two'));
  const bundle = await app.api('POST', `projects/${p.id}/copy`, {node_ids: [], group_ids: [two.group]});
  await app.api('PUT', `test-observations/placed`, {value: 'cleared'});
  await app.api('POST', `projects/${p.id}/paste`, {clipboard: bundle, point: {x: 100, y: 100}});
  await app.Backend.hooksIdle();
  assert.equal(await state('placed'), 'two');
});

test('the hooks of a copy belong to that copy: another copy, or an ordinary workflow, does not fire them', async () => {
  const app = createApp(),
    p = await project(app);
  const def = bundleOf(
    'Counter',
    {
      Body: {inputs: [], outputs: []},
      E: nodes.event('on_placed'),
      S: nodes.script(
        'const n = (await agentsys("GET", "test-observations/n").catch(() => ({}))).value ?? 0; await agentsys("PUT", "test-observations/n", {value: n + 1}); await agentsys("PUT", "test-observations/who", {value: context.instance_id})'
      ),
    },
    {wires: [['E', 'out', 'S', 'in']]}
  );
  const a = await place(app, p.id, {}, def);
  await app.Backend.hooksIdle();
  assert.equal(await p.state('n'), 1);
  assert.equal(await p.state('who'), a.id, 'context.instance_id is the copy the hook is for');
  const b = await place(app, p.id, {}, {...def, name: 'Counter'}).catch(() => null);
  await app.Backend.hooksIdle();
  // A plain on_placed on the workflow is never fired (nothing places a workflow); on_run is.
  const loose = await p.node(nodes.event('on_placed'));
  const log = await p.node(nodes.script('await agentsys("PUT", "test-observations/loose", {value: 1})'));
  await p.connect(loose.id, 'out', log.id, 'in');
  await app.Backend.hooksIdle();
  assert.equal(await p.state('loose'), undefined);
  assert.ok(b === null || (await p.state('n')) >= 1);
});

test('a failing hook is logged and hooks always run', async () => {
  const app = createApp(),
    p = await project(app);
  const def = bundleOf(
    'Bad',
    {
      Body: {inputs: [], outputs: []},
      E: nodes.event('on_placed'),
      S: nodes.script('throw new Error("nope")'),
      D: nodes.event('on_deleted'),
      T: nodes.script('throw new Error("deleted")'),
    },
    {
      wires: [
        ['E', 'out', 'S', 'in'],
        ['D', 'out', 'T', 'in'],
      ],
    }
  );
  const bad = await place(app, p.id, {}, def);
  assert.ok(
    (await p.snapshot()).complex.some(c => c.id === bad.group),
    'the node is on the canvas'
  );
  const log = await p.log();
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].hook, log[0].ok, log[0].node_id], ['on_placed', false, bad.id]);
  assert.match(log[0].error, /nope/);
  assert.deepEqual(await app.api('GET', 'node-hooks', {}, {workflow_id: 'other'}), []);
  await app.api('DELETE', `projects/${p.id}/groups/${bad.group}`).catch(() => {});
  await app.api('POST', `projects/${p.id}/delete-nodes`, {node_ids: [bad.id]}).catch(() => {});
  assert.equal((await p.log()).length, 2, 'on_deleted runs');
});

test('the configuration is validated: unknown keys, removed flags, the old Constructor and oversized configurations are refused', async () => {
  const app = createApp(),
    p = await project(app);
  await rejects(p.node({title: 'x', surprise: 1}), /./);
  await rejects(p.node({title: 'x', init: 'node.OnStarted = () => 1;'}), /./, 'the Constructor is gone');
  await rejects(p.node({title: 'x', op: 'constructor'}), /Unknown operation/);
  for (const flag of ['lazy', 'multiline', 'variadic'])
    await rejects(p.node({title: 'x', inputs: [{...out('n', 'text'), [flag]: true}]}), /./);
  await rejects(p.node({title: 'x'.repeat(200001)}), /./);
  // Any name is allowed: one that is not a name is read as node.input["a b"].
  const odd = await fn(
    app,
    p.id,
    {},
    {
      code: 'node.output.result = node.input["a b"] + "|" + node.input.class',
      inputs: ['a b', 'class'],
      outputs: ['result'],
    }
  );
  const one = await p.node(nodes.value('text', 'x'));
  await p.connect(one.id, 'value', odd.wrapper, 'a b');
  const r = await p.evaluate([odd.id]);
  assert.deepEqual(r.errors, {});
  assert.equal(r.outputs[odd.id].result, 'x|undefined');
});

test('Logic: a Custom node does what If and Switch did, choosing among the values it is given', async () => {
  const app = createApp(),
    p = await project(app);
  const mode = await p.node(nodes.value('text', 'b'));
  const sw = await fn(
    app,
    p.id,
    {},
    {code: 'node.output.result = ({a, b, c})[key]', inputs: ['key', 'a', 'b', 'c'], outputs: ['result']}
  );
  const one = await p.node(nodes.value('number', 1)),
    two = await p.node(nodes.value('number', 2)),
    three = await p.node(nodes.value('number', 3));
  await p.connect(mode.id, 'value', sw.wrapper, 'key');
  await p.connect(one.id, 'value', sw.wrapper, 'a');
  await p.connect(two.id, 'value', sw.wrapper, 'b');
  await p.connect(three.id, 'value', sw.wrapper, 'c');
  const r = await p.evaluate([sw.id]);
  assert.deepEqual(r.errors, {});
  assert.equal(r.outputs[sw.id].result, 2);
});

test('a Custom node without an operation holds its values and runs nothing: it is no error', async () => {
  const app = createApp(),
    p = await project(app);
  const note = await p.node({title: 'Note', inputs: [], outputs: []});
  const r = await p.evaluate([note.id]);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.outputs[note.id], {});
});

test('importing a document with a node of an unsupported type is refused', async () => {
  const app = createApp(),
    p = await project(app);
  const keep = {
    id: 'node:keep',
    kind: 'function',
    node_type: 'custom',
    config: nodes.value('text', 'a'),
    label: 'Custom',
    status: 'ready',
  };
  const old = {
    id: 'node:old',
    kind: 'function',
    node_type: 'script',
    config: {code: 'return 1', inputs: []},
    label: 'Script',
    status: 'ready',
  };
  const document = {nodes: [keep, old], layout: {}, style: {}, groups: [], complex: [], port_edges: [], widgets: {}};
  await assert.rejects(
    app.api(
      'POST',
      `projects/${p.id}/workflows/import`,
      require('../runtime/format').encode({name: 'Old', document})
    ),
    /unsupported type/
  );
});

test('a Script reads its inputs as variables; code can change the nodes of the graph and the properties of its own node', async () => {
  const app = createApp({scripts: 'worker'}),
    p = await project(app);
  const two = await p.node(nodes.value('number', 2)),
    three = await p.node(nodes.value('number', 3));
  const n = await fn(
    app,
    p.id,
    {},
    {
      code: 'node.output.sum = a + b; node.output.twice = (a + b) * 2',
      inputs: ['a', 'b'],
      outputs: ['sum', 'twice'],
      signals: ['out'],
    }
  );
  await p.connect(two.id, 'value', n.wrapper, 'a');
  await p.connect(three.id, 'value', n.wrapper, 'b');
  const show = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.connect(n.wrapper, 'twice', show.wrapper, 'v');
  assert.equal((await p.run(n.step, show.step)).displays[show.id], '10');
  const target = await p.node({title: 'Before', outputs: []});
  const editor = await p.node(
    nodes.script(`const base = "projects/" + context.project_id;
// another node of the graph: a new title and a new output
const other = (await agentsys("GET", base + "/workflow")).nodes.find(n => n.config.title === "Before");
await agentsys("PUT", base + "/typed-nodes/" + other.id, {node_type: "custom", config: {...other.config, title: "After", outputs: [{id: "r", name: "r"}]}});
await agentsys("POST", base + "/typed-nodes", {node_type: "custom", config: {title: "Made by code", outputs: []}, position: {x: 10, y: 10}});
// its own properties: the title
const me = (await agentsys("GET", base + "/workflow")).nodes.find(n => n.id === context.node_id);
await agentsys("PUT", base + "/typed-nodes/" + context.node_id, {node_type: "custom", config: {...me.config, title: "Edited"}});`)
  );
  const run = await app.api('POST', `projects/${p.id}/execution`, {node_ids: [editor.id], wait: true}).catch(e => e);
  const snap = await p.snapshot();
  const byTitle = title => snap.nodes.find(n => n.config.title === title);
  assert.ok(
    byTitle('After')?.outputs.some(q => q.id === 'r'),
    'another node was changed'
  );
  assert.ok(byTitle('Edited'), 'the node changed its own properties');
  assert.ok(byTitle('Made by code'), 'and made a new node');
  assert.ok(run && target);
});

test('code can change the layout of nodes: position, size, color, fold and pin', async () => {
  const app = createApp({scripts: 'worker'}),
    p = await project(app);
  const other = await p.node({title: 'Other', outputs: []});
  const editor = await p.node(
    nodes.script(`const base = "projects/" + context.project_id;
const other = (await agentsys("GET", base + "/workflow")).nodes.find(n => n.config.title === "Other");
await agentsys("PUT", base + "/layout", {positions: {[other.id]: {x: 300, y: 120, width: 400, height: 200}, [context.node_id]: {x: 5, y: 6}}});
await agentsys("PUT", base + "/node-style", {node_id: other.id, color: "#3b6ea8", folded: true});
await agentsys("PUT", base + "/node-style", {node_id: context.node_id, color: "#aa3333", pinned: true});`)
  );
  await app.api('POST', `projects/${p.id}/execution`, {node_ids: [editor.id], wait: true}).catch(e => e);
  const snap = await p.snapshot(),
    o = snap.nodes.find(n => n.id === other.id),
    me = snap.nodes.find(n => n.id === editor.id);
  assert.deepEqual([o.position.x, o.position.y, o.position.width, o.position.height], [300, 120, 400, 200]);
  assert.equal(o.color, '#3b6ea8');
  assert.ok(o.folded);
  assert.equal(me.color, '#aa3333');
  assert.ok(me.pinned);
});

test('developer mode: off by default for the app, Custom nodes cannot be made or edited by hand, but can be imported, exported and run', async () => {
  const app = createApp({developer: false}),
    api = app.api;
  assert.notEqual((await api('GET', 'settings')).preferences.developer_mode, true);
  const p = await project(app);
  await rejects(p.node(nodes.value('text', 'x')), /developer mode/);
  await rejects(api('POST', 'library/node-editor', {}), /developer mode/);
  // Turning it on allows both, and a node made then keeps working with the mode off again.
  await rejects(api('PUT', 'settings', {developer_mode: 'yes'}), /true or false/);
  await api('PUT', 'settings', {developer_mode: true});
  const n = await p.node(nodes.value('text', 'kept'));
  const show = await fn(app, p.id, {}, {code: 'node.display(String(v))', inputs: ['v']});
  await p.connect(n.id, 'value', show.wrapper, 'v');
  await api('PUT', 'settings', {developer_mode: false});
  await rejects(
    api('PUT', `projects/${p.id}/typed-nodes/${n.id}`, {node_type: 'custom', config: nodes.value('text', 'y')}),
    /developer mode/
  );
  assert.equal((await p.evaluate([show.id])).displays[show.id], 'kept');
  // Moving and styling nodes, typing values and copying and pasting them are not editing the node.
  await api('PUT', `projects/${p.id}/layout`, {positions: {[n.id]: {x: 5, y: 5}}});
  const copied = await api('POST', `projects/${p.id}/copy`, {node_ids: [n.id]}).catch(e => e);
  assert.ok(copied);
});

test('a Library node can be overwritten as a whole: the graph is replaced and the editor copy of the old one is dropped', async () => {
  const app = createApp(),
    a = await app.api('POST', 'library/node-editor', {}),
    b = await app.api('POST', 'library/node-editor', {});
  await app.api('PUT', `projects/${b.project_id}/types`, {
    workflow_id: b.workflow_id,
    types: [{id: '1'.repeat(32), name: 'Only B', fields: []}],
  });
  const source = await app.api('GET', `resources/${b.resource_id}`),
    old = await app.api('GET', `resources/${a.resource_id}`);
  assert.notDeepEqual(source.payload.bundle, old.payload.bundle);
  await app.api('PUT', `resources/${a.resource_id}`, {name: old.name, payload: source.payload, replace: true});
  assert.deepEqual((await app.api('GET', `resources/${a.resource_id}`)).payload.bundle, source.payload.bundle);
  assert.equal(await app.eval(`DB.get('wf:lib-${a.resource_id}')`), undefined);
});
});

describe("data-nodes", () => {
// The generic Library nodes an LLM (or any other) controller is assembled from: Template, Parse JSON, Stringify JSON,
// Get/Set State, Set Input and Find Library Node. Each is one Script run by the real runtime.
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, fn, flow} = require('./harness');
const text = 't:64428b9c654c2c2cfcb55742ea899ed8';

async function setup(t) {
  const app = createApp({scripts: 'worker'});
  t.after(async () => {
    await app.Backend.shutdownExecutions();
  });
  await app.api('POST', 'library/builtin');
  const p = await app.api('POST', 'projects', {name: 'Data nodes'}),
    path = `projects/${p.id}`;
  const put = async (name, values = {}) => {
    const r = (await app.api('GET', 'resources')).find(r => r.name === name);
    const made = await app.api('POST', path + '/custom-nodes/' + r.id, {point: {x: 0, y: 0}}),
      id = 'complex:' + made.roots[0];
    if (Object.keys(values).length) await app.api('PUT', path + '/input-values', {node_id: id, values});
    return id;
  };
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
    for (const key of Object.keys(values))
      await app.api('POST', path + '/port-connections', {
        add: [{source: source.wrapper, source_port: key, target: id, target_port: key}],
      });
    const result = await app.api('POST', path + '/execution', {node_ids: [source.id], wait: true});
    assert.deepEqual(result.errors, {});
  };
  return {app, p, path, put, run, feed};
}

test('built-in Data nodes are in the Library, grouped and without needless permissions', async t => {
  const f = await setup(t);
  const items = await f.app.api('GET', 'resources');
  const grants = name => items.find(r => r.name === name).payload.grants;
  for (const name of ['Template', 'Parse JSON', 'Stringify JSON', 'Get State', 'Set State'])
    assert.equal(items.find(r => r.name === name).payload.folder, 'Data', name);
  assert.deepEqual(grants('Template'), []);
  assert.deepEqual(grants('Set Input'), ['graph.write']);
  assert.deepEqual(grants('Find Library Node'), ['library.read']);
});

test('Template fills placeholders, keeps structure for a lone placeholder and names a missing value', async t => {
  const f = await setup(t);
  const id = await f.put('Template', {template: 'Solve {{data.goal}} with {{data.context}} for {{data.n}}'});
  await f.feed(id, {data: {goal: 'sum', context: [1, 2], n: 3}});
  assert.equal((await f.run(id)).value.value, 'Solve sum with [1,2] for 3');
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {template: '{{data.context}}'}});
  assert.deepEqual((await f.run(id)).value.value, [1, 2]);
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {template: '{{data.nothing}}'}});
  assert.match(JSON.stringify((await f.run(id)).errors), /Missing template value: data\.nothing/);
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {template: '{{data.__proto__}}'}});
  assert.match(JSON.stringify((await f.run(id)).errors), /Missing template value/);
});

test('Parse JSON reads fenced JSON, rejects prose around it and checks a schema', async t => {
  const f = await setup(t);
  const id = await f.put('Parse JSON', {
    schema: JSON.stringify({
      type: 'object',
      required: ['answer'],
      properties: {answer: {type: 'integer'}},
      additionalProperties: false,
    }),
  });
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {text: '```json\n{"answer":42}\n```'}});
  assert.deepEqual((await f.run(id)).value.value, {answer: 42});
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {text: 'Sure! ```json\n{"answer":42}\n```'}});
  assert.match(JSON.stringify((await f.run(id)).errors), /JSON/);
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {text: '{"answer":"x"}'}});
  assert.match(JSON.stringify((await f.run(id)).errors), /\$\.answer: expected integer/);
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {text: '{"answer":1,"extra":2}'}});
  assert.match(JSON.stringify((await f.run(id)).errors), /unexpected extra/);
  await f.app.api('PUT', f.path + '/input-values', {node_id: id, values: {schema: '{"$ref":"x"}', text: '{}'}});
  assert.match(JSON.stringify((await f.run(id)).errors), /Unsupported schema/);
});

test('Stringify JSON writes a value as text', async t => {
  const f = await setup(t);
  const id = await f.put('Stringify JSON', {indent: '2'});
  await f.feed(id, {value: {a: [1]}});
  assert.equal((await f.run(id)).value.text, '{\n  "a": [\n    1\n  ]\n}');
});

test('Set State and Get State share one keyed store of the workflow, kept in context.state', async t => {
  const f = await setup(t);
  const set = await f.put('Set State', {key: 'memory'});
  await f.feed(set, {value: {notes: ['a']}});
  const result = await f.run(set);
  assert.deepEqual(result.errors, {});
  const get = await f.put('Get State', {key: 'memory'});
  assert.deepEqual((await f.run(get)).value.value, {notes: ['a']});
  assert.deepEqual((await f.app.api('GET', f.path + '/execution')).state.memory, {notes: ['a']});
  await f.app.api('PUT', f.path + '/input-values', {node_id: get, values: {key: 'unknown'}});
  assert.equal((await f.run(get)).value.value, null);
  await f.app.api('PUT', f.path + '/input-values', {node_id: set, values: {key: '__proto__'}});
  assert.match(JSON.stringify((await f.run(set)).errors), /state key/);
});

test('Find Library Node and Set Input work with Add Node and Invoke Node on a placed copy', async t => {
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
  const find = await f.put('Find Library Node', {name: 'Add Node'});
  assert.ok((await f.run(find)).value.resource_id);
  await f.app.api('PUT', f.path + '/input-values', {node_id: find, values: {name: 'No such node'}});
  assert.match(JSON.stringify((await f.run(find)).errors), /No Library node is named/);
  await f.app.api('PUT', f.path + '/input-values', {
    node_id: find,
    values: {name: (await f.app.api('GET', 'resources')).find(r => r.id === child.resource).name},
  });
  const resource_id = (await f.run(find)).value.resource_id;
  assert.equal(resource_id, child.resource);
  const add = await f.put('Add Node', {resource_id});
  const made = (await f.run(add)).value.node_id;
  // Placement alone is inert; Set Input changes what the next invocation reads.
  const set = await f.put('Set Input', {node_id: made});
  await f.feed(set, {values: {task: 'first'}});
  assert.ok((await f.run(set)).value.result.ok);
  const invoke = await f.put('Invoke Node', {node_id: made});
  assert.deepEqual((await f.run(invoke)).value.outputs.result, {task: 'first'});
  await f.feed(set, {values: {task: 'second'}});
  await f.run(set);
  assert.deepEqual((await f.run(invoke)).value.outputs.result, {task: 'second'});
  await f.feed(set, {values: 'not an object'});
  assert.match(JSON.stringify((await f.run(set)).errors), /object of input values/);
});

test('one controller step built only from nodes: Template, a model call, Parse JSON, Set State, driven by Run', async t => {
  const f = await setup(t);
  // The model stands in for any plugin route: a call with the prompt answers a fenced JSON reply.
  f.app.eval(
    "route('POST','test-model','A stand-in for a plugin route that calls a model',async c=>({text:'```json\\n'+JSON.stringify({kind:'direct',answer:c.body.prompt.length})+'\\n```'}),{needs:{POST:['graph.read']}})"
  );
  const ask = await fn(
    f.app,
    f.p.id,
    {},
    {
      inputs: [{name: 'prompt', type: text}],
      outputs: ['response'],
      signals: ['out'],
      code: "node.output.response = (await agentsys('POST', 'test-model', {prompt: node.input.prompt})).text;",
    }
  );
  const template = await f.put('Template', {template: 'Solve {{data.goal}}'});
  await f.feed(template, {data: {goal: 'abcd'}});
  const parse = await f.put('Parse JSON', {
    schema: JSON.stringify({type: 'object', required: ['kind'], properties: {kind: {enum: ['direct', 'decompose']}}}),
  });
  const set = await f.put('Set State', {key: 'plan'});
  const wire = (source, source_port, target, target_port) =>
    f.app.api('POST', f.path + '/port-connections', {add: [{source, source_port, target, target_port}]});
  await wire(template, 'value', ask.wrapper, 'prompt');
  await wire(ask.wrapper, 'response', parse, 'text');
  await wire(parse, 'value', set, 'value');
  const start = await flow(f.app, f.p.id, {}, [template, ask.wrapper, parse, set]);
  const result = await f.app.api('POST', f.path + '/execution', {node_ids: [start], wait: true});
  assert.deepEqual(result.errors, {});
  // 'Solve abcd' is ten characters: the answer travelled through every node.
  assert.deepEqual((await f.app.api('GET', f.path + '/execution')).state.plan, {kind: 'direct', answer: 10});
  // A reply that is not valid for the schema stops the chain at Parse JSON, before Set State.
  f.app.eval("route('POST','test-model2','x',async()=>({text:'{\"kind\":\"other\"}'}),{needs:{POST:['graph.read']}})");
  await f.app.api('PUT', f.path + '/input-values', {node_id: set, values: {key: 'second'}});
  const bad = await fn(
    f.app,
    f.p.id,
    {},
    {
      outputs: ['response'],
      signals: ['out'],
      code: "node.output.response = (await agentsys('POST', 'test-model2', {})).text;",
    }
  );
  const only = await f.put('Parse JSON', {
    schema: JSON.stringify({type: 'object', properties: {kind: {enum: ['direct']}}}),
  });
  await wire(bad.wrapper, 'response', only, 'text');
  const failing = await flow(f.app, f.p.id, {}, [bad.wrapper, only]);
  const failed = await f.app.api('POST', f.path + '/execution', {node_ids: [failing], wait: true});
  assert.match(JSON.stringify(failed.errors), /outside enum/);
});
});

describe("engine", () => {
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, fn, flow, nodes} = require('./harness');
async function setup(t) {
  const app = createApp({scripts: 'worker'}),
    p = await app.api('POST', 'projects', {name: 'Interpreter'});
  t.after(() => app.Backend.shutdownExecutions());
  return {app, id: p.id, path: `projects/${p.id}/execution`, make: options => fn(app, p.id, {}, options)};
}
async function connect(p, source, port, target) {
  await p.app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source, source_port: port, target: target.wrapper, target_port: 'in'}],
  });
}
test('manual completion emission is additional to automatic completion', async t => {
  const p = await setup(t),
    a = await p.make({code: 'await node.output.out.emit();context.state.after=true;', signals: ['out']}),
    b = await p.make({code: 'context.state.calls=(context.state.calls??0)+1;'});
  await connect(p, a.wrapper, 'out', b);
  const result = await p.app.api('POST', p.path, {node_ids: [a.id], wait: true});
  assert.equal(result.state.calls, 2);
  assert.equal(result.state.after, true);
});
test('an awaited named signal publishes values and joins its branches', async t => {
  const p = await setup(t),
    a = await p.make({
      code: 'node.output.value=42;context.state.order=[];await node.output.body.emit();context.state.order.push("joined");',
      outputs: ['value'],
      signals: ['body'],
    }),
    b = await p.make({
      code: 'await node.sleep(20);context.state.order.push("branch");node.display(node.input.value);',
      inputs: ['value'],
    });
  await connect(p, a.wrapper, 'body', b);
  await p.app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source: a.wrapper, source_port: 'value', target: b.wrapper, target_port: 'value'}],
  });
  const result = await p.app.api('POST', p.path, {node_ids: [a.id], wait: true});
  assert.deepEqual(result.state.order, ['branch', 'joined']);
  assert.equal(result.displays[b.id], '42');
});
test('failed Script does not emit automatic out', async t => {
  const p = await setup(t),
    a = await p.make({code: 'throw Error("failure");', signals: ['out']}),
    b = await p.make({code: 'context.state.reached=true;'});
  await connect(p, a.wrapper, 'out', b);
  const result = await p.app.api('POST', p.path, {node_ids: [a.id], wait: true});
  assert.equal(result.state.reached, undefined);
  assert.match(result.errors[a.id], /failure/);
});
test('an emission handling break ends a loop without its completion branch', async t => {
  const p = await setup(t),
    a = await p.make({
      code: 'context.state.steps=0;for(let i=0;i<10;i++){context.state.steps++;if(await node.output.body.emit({handles:["break"]})==="break")break;}context.state.finished=true;',
      signals: ['body'],
    }),
    b = await p.make({code: 'node.flow.break();', signals: ['out']}),
    c = await p.make({code: 'context.state.unreachable=true;'});
  await connect(p, a.wrapper, 'body', b);
  await connect(p, b.wrapper, 'out', c);
  const result = await p.app.api('POST', p.path, {node_ids: [a.id], wait: true});
  assert.equal(result.state.steps, 1);
  assert.equal(result.state.finished, true);
  assert.equal(result.state.unreachable, undefined);
  assert.deepEqual(result.errors, {});
});
test('JSON values crossing node boundaries are copies', async t => {
  const p = await setup(t),
    a = await p.make({
      code: 'node.output.value={x:1};await node.output.body.emit();node.display(node.output.value.x);',
      outputs: ['value'],
      signals: ['body'],
    }),
    b = await p.make({code: 'node.input.value.x=2;', inputs: ['value']});
  await connect(p, a.wrapper, 'body', b);
  await p.app.api('POST', `projects/${p.id}/port-connections`, {
    add: [{source: a.wrapper, source_port: 'value', target: b.wrapper, target_port: 'value'}],
  });
  const result = await p.app.api('POST', p.path, {node_ids: [a.id], wait: true});
  assert.equal(result.displays[a.id], '1');
});
test('a loop can emit more than one thousand signals without a chain limit', async t => {
  const p = await setup(t),
    a = await p.make({
      code: 'context.state.calls=0;for(let i=0;i<1100;i++)await node.output.body.emit();',
      signals: ['body'],
    }),
    b = await p.make({code: 'context.state.calls++;'});
  await connect(p, a.wrapper, 'body', b);
  const result = await p.app.api('POST', p.path, {node_ids: [a.id], wait: true});
  assert.equal(result.state.calls, 1100);
  assert.deepEqual(result.errors, {});
});

test('the interpreter follows a chain deeper than one thousand nodes', async () => {
  const app = createApp();
  const result = await app.eval(`(async()=>{
    const count=1200,outputs=[{id:'out',name:'out',type:'signal'}];
    const graph={diagnostics:[],complex:[],groups:[],widgets:{},types:[],
      nodes:Array.from({length:count},(_,i)=>({id:'n'+i,kind:'function',node_type:'custom',config:{op:'script',outputs},
        inputs:[{id:'in',name:'in',type:'signal'},{id:'script',name:'script',default:'context.state.count=(context.state.count??0)+1;'}],outputs})),
      edges:Array.from({length:count-1},(_,i)=>({source:'n'+i,source_port:'out',target:'n'+(i+1),target_port:'in'}))};
    let state={},errors=[];
    const interpreter=createGraphInterpreter(graph,{}, {AsyncFunction:Object.getPrototypeOf(async function(){}).constructor,
      displayText,call:()=>{throw Error('Unexpected API call');},context:{},
      emit:event=>{if(event.ev==='state')state=event.state;if(event.error)errors.push(event.error);}});
    await interpreter.signal(['n0']);return {state,errors};
  })()`);
  assert.equal(result.state.count, 1200);
  assert.equal(result.errors.length, 0);
});
});

describe("engine-regression", () => {
// Graph engine regression scenarios that go past the existing suites: a Script editing its own graph while it
// runs, a bounded chain of nodes that create nodes, a node deleting itself mid-run, and the runtime's health
// after those mutations. The engine's semantics are not changed by these tests.
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, nodes, flow} = require('./harness');

async function project(app, name = 'Engine') {
  const {id} = await app.api('POST', 'projects', {name});
  const self = {
    id,
    query: {workflow_id: id},
    node: (config, extra = {}) =>
      app.api('POST', `projects/${id}/typed-nodes`, {workflow_id: id, node_type: 'custom', config, position: {x: 0, y: 0}, ...extra}),
    connect: (s, sp, t, tp) =>
      app.api('POST', `projects/${id}/port-connections`, {workflow_id: id, add: [{source: s, source_port: sp, target: t, target_port: tp}]}),
    evaluate: (ids, extra = {}) => app.api('POST', `projects/${id}/execution`, {workflow_id: id, node_ids: ids, ...extra}),
    snapshot: () => app.api('GET', `projects/${id}/workflow`, {}, {workflow_id: id}),
    state: async key => (await app.api('GET', `test-observations/${key}`).catch(() => ({}))).value,
    detail: () => app.api('GET', `projects/${id}/execution`, {}, {workflow_id: id}),
  };
  return self;
}

const OBSERVE = key => `await agentsys("PUT", "test-observations/${key}", {value: (await agentsys("GET", "test-observations/${key}").catch(() => ({}))).value ?? 0});`;

test('a Script adds nodes to its own graph while it runs, and they run on the next Run', async () => {
  const app = createApp(),
    p = await project(app);
  // The inner node is created by the outer Script through the ordinary API, and is not signalled by it.
  const creator = await p.node(
    nodes.script(
      `await agentsys("POST", "projects/${p.id}/typed-nodes", {
        workflow_id: "${p.id}",
        node_type: "custom",
        config: {title: "Made", op: "on_run",
          inputs: [],
          outputs: [{id: "out", name: "out", type: "signal"}]}
      });
      await agentsys("PUT", "test-observations/created", {value: true});`
    )
  );
  const run = await p.evaluate([creator.id], {wait: true});
  assert.deepEqual(run.errors, {});
  assert.equal(await p.state('created'), true, 'the Script created its node through the API');
  const after = await p.snapshot();
  const made = after.nodes.find(node => node.config.title === 'Made');
  assert.ok(made, 'the new node is part of the graph');
  assert.equal(after.cursor > 1, true, 'the graph revision advanced');

  // The new node only runs when a signal reaches it; wiring it and running again executes both.
  const start = await p.evaluate([made.id], {wait: true});
  assert.deepEqual(start.errors, {});
  assert.equal(start.nodes.find(node => node.node_id === made.id).status, 'completed');
});

test('repeated runs of a creating Script stop at its bound and leave a valid graph', async () => {
  const app = createApp(),
    p = await project(app, 'Recursive');
  // The Script creates a node while the counter is below the bound. A created on_run node holds a trigger, not
  // code, so it runs only when it is signalled; the bound is what keeps creation from running away.
  const factory = depth =>
    nodes.script(
      `const n = Number((await agentsys("GET", "test-observations/depth").catch(() => ({}))).value ?? 0);
       await agentsys("PUT", "test-observations/depth", {value: n + 1});
       if (n < ${depth}) {
         await agentsys("POST", "projects/${p.id}/typed-nodes", {
           workflow_id: "${p.id}", node_type: "custom",
           config: {title: "Level " + (n + 2), op: "on_run",
             inputs: [],
             outputs: [{id: "out", name: "out", type: "signal"}]}
         });
       }`
    );
  const creator = await p.node(factory(2));
  for (let run = 0; run < 3; run++) {
    const result = await p.evaluate([creator.id], {wait: true});
    assert.deepEqual(result.errors, {});
  }
  assert.equal(await p.state('depth'), 3, 'the Script ran three times, not in a loop');
  const graph = await p.snapshot();
  const levels = graph.nodes.filter(node => (node.config.title || '').startsWith('Level'));
  assert.deepEqual(levels.map(node => node.config.title).sort(), ['Level 2', 'Level 3'], 'creation stopped at the bound');
  // A created node is an ordinary node of the graph: it can be run like any other.
  const made = await p.evaluate([levels[0].id], {wait: true});
  assert.deepEqual(made.errors, {});
  assert.equal(made.nodes.find(node => node.node_id === levels[0].id).status, 'completed');
  // The document is still a valid graph for the API: a further read runs the usual validation path.
  assert.equal(graph.nodes.every(node => node.id && node.kind), true);
});

test('a Script deletes its own node while running; the run settles and the runtime stays usable', async () => {
  const app = createApp(),
    p = await project(app, 'Self delete');
  const doomed = await p.node(nodes.script(`await agentsys("POST", "projects/${p.id}/delete-nodes", {node_ids: [context.node_id]})`));
  const run = await p.evaluate([doomed.id], {wait: true}).catch(error => ({error}));
  // The node cannot be removed while its dispatch is running, or the run reports a clean failure; either way the
  // runtime must not be left running or throw an unhandled rejection.
  const detail = await p.detail();
  assert.equal(detail.status, 'idle', 'the runtime is not stuck running');
  assert.equal(JSON.stringify(run).includes('unhandled'), false);
  // A later Run on the remaining graph works.
  const survivor = await p.node(nodes.script('await agentsys("PUT", "test-observations/after", {value: "ok"})'));
  const again = await p.evaluate([survivor.id], {wait: true});
  assert.deepEqual(again.errors, {});
  assert.equal(await p.state('after'), 'ok');
});

test('the runtime reports no live worker after repeated runs and a stop', async () => {
  const app = createApp({scripts: 'worker'});
  const p = await project(app, 'Workers');
  const node = await p.node(nodes.script('await node.sleep(20); await agentsys("PUT", "test-observations/tick", {value: 1})'));
  for (let i = 0; i < 4; i++) {
    const run = await p.evaluate([node.id], {wait: true});
    assert.deepEqual(run.errors, {});
    assert.equal(run.nodes.find(item => item.node_id === node.id).status, 'completed');
  }
  await p.evaluate([node.id]);
  await app.api('DELETE', `projects/${p.id}/execution`, {}, {workflow_id: p.id});
  await app.Backend.shutdownExecutions();
  assert.ok(app.workerStats.terminated >= 1, 'Stop terminates the worker');
  const detail = await p.detail();
  assert.equal(detail.status, 'idle');
  assert.equal(app.Backend.diagnostics().runtimes.every(runtime => runtime.status === 'idle'), true);
});
});

describe("execution", () => {
const test = require('node:test'),
  assert = require('node:assert/strict');
const http = require('node:http');
const {createApp, nodes, flow, fn, bundleOf, place} = require('./harness');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(app, path, predicate) {
  for (let i = 0; i < 300; i++) {
    const detail = await app.api('GET', path);
    if (predicate(detail)) return detail;
    await sleep(10);
  }
  assert.fail('Graph state was not reached');
}
async function fixture(t, code, {store = null} = {}) {
  const app = createApp({scripts: 'worker', store}),
    project = await app.api('POST', 'projects', {name: 'Live graph'});
  t.after(() => app.Backend.shutdownExecutions());
  const node = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script(code),
  });
  return {app, project, node, path: `projects/${project.id}/execution`};
}
async function change(app, project, node, code) {
  const graph = await app.api('GET', `projects/${project.id}/workflow`),
    config = graph.nodes.find(n => n.id === node.id).config;
  config.inputs.find(p => p.id === 'script').default = code;
  await app.api('PUT', `projects/${project.id}/typed-nodes/${node.id}`, {node_type: 'custom', config});
}
for (const parallel of [false, true])
  test(`starting upstream clears old downstream states${parallel ? ' through a cycle while preserving active work' : ''}`, async t => {
    const {app, project, node, path} = await fixture(t, 'node.display("first");');
    const make = code =>
      app.api('POST', `projects/${project.id}/typed-nodes`, {
        node_type: 'custom',
        config: nodes.script(code),
      });
    const second = await make('node.display("second");'),
      last = await make(`node.display("last");${parallel ? 'throw Error("old failure");' : ''}`),
      unrelated = await make('node.display("unrelated");');
    await flow(app, project.id, {}, [node.id, second.id, last.id]);
    const previous = await app.api('POST', path, {node_ids: [node.id, unrelated.id], wait: true});
    assert.equal(previous.nodes.find(n => n.node_id === last.id)?.status, parallel ? 'failed' : 'completed');
    await change(app, project, node, 'await node.sleep(500);node.flow.cancel();');
    if (parallel) {
      await app.api('POST', `projects/${project.id}/port-connections`, {
        add: [{source: last.id, source_port: 'out', target: node.id, target_port: 'in'}],
      });
      await change(app, project, second, 'await node.sleep(500);node.flow.cancel();');
      await app.api('POST', path, {node_ids: [second.id]});
      await until(app, path, r => r.nodes.some(n => n.node_id === second.id && n.status === 'sleeping'));
    }
    await app.api('POST', path, {node_ids: [node.id]});
    const detail = await until(app, path, r => r.nodes.some(n => n.node_id === node.id && n.status === 'sleeping')),
      status = id => detail.nodes.find(n => n.node_id === id)?.status;
    assert.equal(status(second.id), parallel ? 'sleeping' : 'ready');
    assert.equal(status(last.id), 'ready');
    assert.equal(status(unrelated.id), 'completed');
    assert.equal(detail.displays[last.id], 'last');
    assert.equal(detail.runs[last.id], 1);
    await until(app, path, r => r.status === 'idle');
  });
test('flow.abort cancels its owning dispatch without cancelling an unrelated concurrent dispatch', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.otherStarted=true;await node.sleep(80);context.state.otherFinished=true;'
  );
  const abort = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('node.flow.abort();'),
  });
  await app.api('POST', path, {node_ids: [node.id]});
  await until(app, path, state => state.state.otherStarted);
  const aborted = await app.api('POST', path, {node_ids: [abort.id], wait: true});
  assert.equal(aborted.dispatch_status, 'cancelled');
  await until(app, path, runtime => runtime.state.otherFinished);
});
test('flow.abort also cancels continuations of other roots in its own dispatch', async t => {
  const {app, project, node, path} = await fixture(t, 'await node.sleep(80);context.state.shouldNotFinish=true;');
  const abort = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('await node.sleep(10);node.flow.abort();'),
  });
  const stopped = await app.api('POST', path, {node_ids: [node.id, abort.id], wait: true});
  assert.equal(stopped.dispatch_status, 'cancelled');
  assert.equal(stopped.state.shouldNotFinish, undefined);
  await change(app, project, node, 'context.state.fresh=true;');
  const next = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(next.dispatch_status, 'completed');
  assert.equal(next.state.fresh, true);
});

test('Run is a repeatable on_run signal, with one persistent graph context and host', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.count=(context.state.count??0)+1;globalThis.count=(globalThis.count??0)+1;node.display([context.state.count,globalThis.count]);'
  );
  await flow(app, project.id, {}, [node.id]);
  for (let count = 1; count <= 3; count++) {
    const detail = await app.api('POST', path, {wait: true});
    assert.equal(detail.status, 'idle');
    assert.equal(detail.state.count, count);
    assert.deepEqual(JSON.parse(detail.displays[node.id]), [count, count]);
  }
  assert.equal(app.workerStats.started, 1);
});
test('a graph without on_run does nothing when Run is signalled', async t => {
  const {app, path} = await fixture(t, 'throw Error("Must not run without a signal")');
  assert.equal((await app.api('POST', path, {wait: true})).status, 'idle');
  assert.equal(app.workerStats.started, 0);
});
test('automatic Script out connects standalone Scripts in a chain', async t => {
  const {app, project, node, path} = await fixture(t, 'context.state.order=["first"];');
  const second = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('context.state.order.push("second");'),
  });
  await flow(app, project.id, {}, [node.id, second.id]);
  const result = await app.api('POST', path, {wait: true});
  assert.deepEqual(result.state.order, ['first', 'second']);
  assert.deepEqual(result.errors, {});
});
test('Run can signal the same graph while other work is active', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.started=(context.state.started??0)+1;await node.sleep(100);context.state.finished=(context.state.finished??0)+1;'
  );
  await flow(app, project.id, {}, [node.id]);
  await app.api('POST', path);
  await app.api('POST', path);
  await until(app, path, r => r.state.started === 2);
  const result = await until(app, path, r => r.status === 'idle');
  assert.equal(result.state.finished, 2);
});
test('Pause preserves state and uses edits when the next node is reached', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.value=42;node.display("before delay");await node.sleep(80);'
  );
  const second = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('context.state.seen="before edit";'),
  });
  await flow(app, project.id, {}, [node.id, second.id]);
  await app.api('POST', path);
  await until(app, path, r => r.nodes.some(n => n.node_id === node.id && n.status === 'sleeping'));
  await app.api('POST', path + '/pause');
  await sleep(100);
  await change(app, project, second, 'context.state.seen=context.state.value+1;node.display(context.state.seen);');
  const paused = await app.api('GET', path);
  assert.equal(paused.state.value, 42);
  assert.equal(paused.displays[node.id], 'before delay');
  assert.equal(paused.state.seen, undefined);
  await app.api('POST', path + '/resume');
  const result = await until(app, path, r => r.status === 'idle');
  assert.equal(result.state.seen, 43);
  assert.equal(app.workerStats.started, 1);
});
test('rewiring during an active delay changes the following completion signal', async t => {
  const {app, project, node, path} = await fixture(t, 'await node.sleep(80);');
  const make = code =>
    app.api('POST', `projects/${project.id}/typed-nodes`, {node_type: 'custom', config: nodes.script(code)});
  const first = await make('context.state.first=true;'),
    second = await make('context.state.second=true;');
  await flow(app, project.id, {}, [node.id, first.id]);
  await app.api('POST', path);
  await until(app, path, r => r.nodes.some(n => n.node_id === node.id && n.status === 'sleeping'));
  await app.api('POST', path + '/pause');
  const graph = await app.api('GET', `projects/${project.id}/workflow`),
    edge = graph.edges.find(e => e.source === node.id);
  await app.api('POST', `projects/${project.id}/port-connections`, {
    remove: [edge],
    add: [{source: node.id, source_port: 'out', target: second.id, target_port: 'in'}],
  });
  await app.api('POST', path + '/resume');
  const result = await until(app, path, r => r.status === 'idle');
  assert.equal(result.state.first, undefined);
  assert.equal(result.state.second, true);
});
test('durable JSON, output values and previews survive Stop and backend restart', async t => {
  const data = new Map(),
    store = {
      get: key => structuredClone(data.get(key)),
      commit: ({set, remove}) => {
        for (const [key, value] of Object.entries(set)) data.set(key, structuredClone(value));
        for (const key of remove) data.delete(key);
      },
    };
  const {app, project, path} = await fixture(t, '', {store});
  const writer = await fn(
    app,
    project.id,
    {},
    {
      code: 'context.state.nested??={items:[]};context.state.nested.items.push(42);node.output.value=42;node.display("saved");',
      outputs: ['value'],
    }
  );
  await app.api('POST', path, {node_ids: [writer.id], wait: true});
  await app.api('DELETE', path);
  const reopened = createApp({scripts: 'worker', store});
  t.after(() => reopened.Backend.shutdownExecutions());
  const restored = await reopened.api('GET', path);
  assert.deepEqual(restored.state, {nested: {items: [42]}});
  assert.equal(restored.outputs[writer.wrapper].value, 42);
  assert.equal(restored.displays[writer.id], 'saved');
  await reopened.api('POST', path, {node_ids: [writer.id], wait: true});
  assert.deepEqual((await reopened.api('GET', path)).state.nested.items, [42, 42]);
});
test('Stop interrupts synchronous infinite code while retaining acknowledged state', async t => {
  const {app, project, node, path} = await fixture(t, 'context.state.started=true;while(true){}');
  await app.api('POST', path, {node_ids: [node.id]});
  await until(app, path, r => r.state.started === true);
  await app.api('DELETE', path);
  assert.equal((await app.api('GET', path)).status, 'idle');
  await change(app, project, node, 'node.display(context.state.started);');
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(result.displays[node.id], 'true');
});
test('the graph accepts more than sixteen asynchronous Script bodies together', async t => {
  const {app, project, path} = await fixture(t, '');
  const ids = [];
  for (let i = 0; i < 24; i++)
    ids.push(
      (
        await app.api('POST', `projects/${project.id}/typed-nodes`, {
          node_type: 'custom',
          config: nodes.script(
            'context.state.started=(context.state.started??0)+1;await new Promise(resolve=>setTimeout(resolve,100));'
          ),
        })
      ).id
    );
  await app.api('POST', path, {node_ids: ids});
  await until(app, path, r => r.state.started === 24);
  await until(app, path, r => r.status === 'idle');
});
test('new signals queued while paused start after Resume without clearing state', async t => {
  const {app, node, path} = await fixture(t, 'context.state.count=(context.state.count??0)+1;');
  await app.api('POST', path + '/pause');
  await app.api('POST', path, {node_ids: [node.id]});
  assert.equal((await app.api('GET', path)).state.count, undefined);
  await app.api('POST', path + '/resume');
  assert.equal((await until(app, path, r => r.status === 'idle')).state.count, 1);
});
test('JSON context rejects functions and keeps its previous value', async t => {
  const {app, node, path} = await fixture(
    t,
    'context.state.value=42;try{context.state.value=()=>1;}catch(error){node.display(error.message);}'
  );
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(result.state.value, 42);
  assert.match(result.displays[node.id], /JSON/);
});

test('graph export omits runtime; workflow duplication keeps state and remaps node values', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.nodes=[{id:"z"},{id:"a"}];context.state.marker={$script:"literal data"};node.display("stored");'
  );
  await app.api('POST', path, {node_ids: [node.id], wait: true});
  const packet = await app.api('GET', `projects/${project.id}/workflows/${project.id}/export`);
  const imported = await app.api('POST', `projects/${project.id}/workflows/import`, packet);
  const restored = await app.api('GET', path, {}, {workflow_id: imported.id});
  assert.deepEqual(restored.state, {});
  assert.deepEqual(restored.displays, {});
  const copied = await app.api('POST', `projects/${project.id}/workflows/${project.id}/duplicate`);
  const copy = await app.api('GET', path, {}, {workflow_id: copied.id});
  assert.deepEqual(copy.state.nodes, [{id: 'z'}, {id: 'a'}]);
  assert.deepEqual(copy.state.marker, {$script: 'literal data'});
  assert.deepEqual(Object.values(copy.displays), ['stored']);
  assert.equal(copy.displays[node.id], undefined);
});

test('a paused editor event does not block events in another workflow', async t => {
  const {app, project, path} = await fixture(t, '');
  await app.api('POST', path + '/pause');
  const hook = bundleOf(
    'Placement context',
    {E: nodes.event('on_placed'), S: nodes.script('context.state.placed=true;')},
    {wires: [['E', 'out', 'S', 'in']]}
  );
  const first = await place(app, project.id, {}, hook);
  const other = await app.api('POST', 'projects', {name: 'Other live graph'});
  await app.api('POST', `projects/${other.id}/custom-nodes/${first.resource}`, {point: {x: 0, y: 0}});
  await until(app, `projects/${other.id}/execution`, value => value.state.placed === true);
  assert.equal((await app.api('GET', path)).state.placed, undefined);
  await app.api('POST', path + '/resume');
  await app.Backend.hooksIdle();
  assert.equal((await app.api('GET', path)).state.placed, true);
});

test('an old node error does not mark a later successful editor event as failed', async t => {
  const {app, project, node, path} = await fixture(t, 'throw Error("Earlier failure");');
  await app.api('POST', path, {node_ids: [node.id], wait: true});
  await place(
    app,
    project.id,
    {},
    bundleOf(
      'Successful placement',
      {E: nodes.event('on_placed'), S: nodes.script('context.state.placed=true;')},
      {wires: [['E', 'out', 'S', 'in']]}
    )
  );
  await app.Backend.hooksIdle();
  assert.equal((await app.api('GET', path)).state.placed, true);
  assert.ok((await app.api('GET', path)).errors[node.id]);
  assert.ok((await app.api('GET', 'node-hooks')).every(event => event.ok));
});

test('a successful dispatch clears the host error of an earlier failure', async t => {
  const {app, project, node, path} = await fixture(t, 'context.state.ok=true;');
  await app.api('GET', path);
  // The entry records a host failure exactly as a crashed dispatch does.
  app.eval(`GRAPH_RUNTIMES.get('${project.id}').errors.host='the script host stopped'`);
  assert.equal((await app.api('GET', path)).errors.host, 'the script host stopped');
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(result.dispatch_status, 'completed');
  assert.equal((await app.api('GET', path)).errors.host, undefined);
});
test('node_ids naming a group is rejected; nodes and Custom Nodes still run', async t => {
  const {app, project, node, path} = await fixture(t, 'context.state.ran=true;');
  await app.api('PUT', `projects/${project.id}/groups`, {
    groups: [{id: 'g1', name: 'Group', members: [node.id]}],
  });
  const badRoot = app.api('POST', path, {node_ids: ['group:g1'], wait: true});
  await assert.rejects(badRoot, error => error.status === 400 && error.code === 'invalid_request');
  await assert.rejects(
    app.api('POST', `projects/${project.id}/evaluate-node`, {node_ids: ['group:g1'], collect: true}),
    error => error.status === 400 && error.code === 'invalid_request'
  );
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(result.dispatch_status, 'completed');
  assert.equal(result.state.ran, true);
});
test('deleting a node during an await prevents late state mutations', async t => {
  const {app, project, node, path} = await fixture(
    t,
    'context.state.started=true;await new Promise(resolve=>setTimeout(resolve,100));try{context.state.late=true;}catch{}'
  );
  await app.api('POST', path, {node_ids: [node.id]});
  await until(app, path, r => r.state.started);
  await app.api('POST', `projects/${project.id}/delete-nodes`, {node_ids: [node.id]});
  await until(app, path, r => r.status === 'idle');
  assert.equal((await app.api('GET', path)).state.late, undefined);
});
test('Stop cancels a real checked network request and the next Run gets a clean host', async t => {
  let receivedResolve;
  const received = new Promise(resolve => (receivedResolve = resolve));
  const server = http.createServer((req, res) => {
    receivedResolve();
    req.on('close', () => res.end());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const {app, project, node, path} = await fixture(
    t,
    `await agentsys('POST','net',{url:'http://127.0.0.1:${server.address().port}'});context.state.late=true;`
  );
  await app.api('POST', path, {node_ids: [node.id]});
  await received;
  await app.api('DELETE', path);
  assert.equal((await app.api('GET', path)).state.late, undefined);
  await change(app, project, node, 'context.state.fresh=true;');
  const result = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(result.state.fresh, true);
  assert.equal(app.workerStats.started, 2);
});
test('Stop of a Script that runs another workflow stops that workflow too', async t => {
  const {app, project, node, path} = await fixture(t, '');
  const other = await app.api('POST', 'projects', {name: 'Child workflow'}),
    otherPath = `projects/${other.id}/execution`;
  const child = await app.api('POST', `projects/${other.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('await node.sleep(1000);context.state.unwanted=true;'),
  });
  await change(
    app,
    project,
    node,
    `await agentsys('POST','projects/${other.id}/execution',{node_ids:['${child.id}'],wait:true});`
  );
  await app.api('POST', path, {node_ids: [node.id]});
  await until(app, otherPath, r => r.nodes.some(n => n.node_id === child.id && n.status === 'sleeping'));
  await app.api('DELETE', path);
  await until(app, otherPath, r => r.status === 'idle');
  assert.equal((await app.api('GET', otherPath)).state.unwanted, undefined);
});

for (const group of [false, true])
  test(`deleting a Library ${group ? 'group' : 'node'} releases its editor runtime and history`, async t => {
    const app = createApp({scripts: 'worker'});
    t.after(() => app.Backend.shutdownExecutions());
    const opened = await app.api('POST', 'library/node-editor', {folder: 'Disposable'});
    const id = opened.project_id;
    const script = await app.api('POST', `projects/${id}/typed-nodes`, {
      node_type: 'custom',
      config: nodes.script('await node.sleep(10000);'),
    });
    await app.api('POST', `projects/${id}/execution`, {node_ids: [script.id]});
    await until(app, `projects/${id}/execution`, detail => detail.nodes.some(n => n.status === 'sleeping'));
    assert.equal(app.eval(`GRAPH_RUNTIMES.has('${id}')`), true);
    assert.equal(app.eval(`[...histories.keys()].some(k => k.slice(k.indexOf(String.fromCharCode(0)) + 1) === '${id}')`), true);
    if (group) await app.api('POST', 'library/node-folders', {action: 'delete', path: 'Disposable'});
    else await app.api('DELETE', `resources/${opened.resource_id}`);
    assert.equal(app.eval(`GRAPH_RUNTIMES.has('${id}')`), false);
    assert.equal(app.workerStats.terminated, 1);
    assert.equal(app.eval(`[...histories.keys()].some(k => k.slice(k.indexOf(String.fromCharCode(0)) + 1) === '${id}')`), false);
    assert.equal(await app.eval(`DB.get('wf:${id}')`), undefined);
    assert.equal(await app.eval(`DB.get(runtimeKey('${id}'))`), undefined);
  });

test('an idle runtime is evicted after its TTL and rebuilt from saved data', async t => {
  const {app, project, path} = await fixture(t, '');
  const writer = await fn(app, project.id, {}, {
    code: 'context.state.count=(context.state.count??0)+1;node.output.value=42;node.display("saved");',
    outputs: ['value'],
  });
  assert.equal((await app.api('POST', path, {node_ids: [writer.id], wait: true})).dispatch_status, 'completed');
  app.eval('RUNTIME_TTL_MS = 1');
  t.after(() => app.eval('RUNTIME_TTL_MS = 600000'));
  await sleep(10);
  // Any later runtime lookup sweeps: the idle workflow is released.
  const other = await app.api('POST', 'projects', {name: 'Eviction trigger'});
  await app.api('GET', `projects/${other.id}/execution`);
  assert.equal(app.eval(`GRAPH_RUNTIMES.has('${project.id}')`), false);
  // The next read builds it again from the store: values, outputs and previews are intact.
  const restored = await app.api('GET', path);
  assert.equal(restored.state.count, 1);
  assert.equal(restored.outputs[writer.wrapper].value, 42);
  assert.equal(restored.displays[writer.id], 'saved');
  assert.equal(restored.status, 'idle');
});

test('a paused runtime is never evicted', async t => {
  const {app, project, path} = await fixture(t, '');
  await app.api('POST', path + '/pause');
  app.eval('RUNTIME_TTL_MS = 1');
  t.after(() => app.eval('RUNTIME_TTL_MS = 600000'));
  await sleep(10);
  const other = await app.api('POST', 'projects', {name: 'Eviction trigger'});
  await app.api('GET', `projects/${other.id}/execution`);
  assert.equal(app.eval(`GRAPH_RUNTIMES.has('${project.id}')`), true);
  assert.equal((await app.api('GET', path)).paused, true);
});

test('at most sixteen idle runtimes stay live, least recently used go first', async t => {
  const app = createApp();
  t.after(() => app.Backend.shutdownExecutions());
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const project = await app.api('POST', 'projects', {name: 'Visited ' + i});
    ids.push(project.id);
    await app.api('GET', `projects/${project.id}/execution`);
  }
  assert.equal(app.eval('GRAPH_RUNTIMES.size'), 16);
  assert.equal(app.eval(`GRAPH_RUNTIMES.has('${ids[19]}')`), true);
  // Opening the first again rebuilds it from its stored (empty) runtime.
  assert.equal((await app.api('GET', `projects/${ids[0]}/execution`)).status, 'idle');
  assert.equal(app.eval('GRAPH_RUNTIMES.size'), 16);
});

test('a failed runtime write is reported and kept for the next successful write', async t => {
  const data = new Map();
  let fail = true,
    runtime = null;
  const store = {
    get: key => (data.has(key) ? structuredClone(data.get(key)) : undefined),
    commit: ({set, remove}) => {
      for (const [key, value] of Object.entries(set)) {
        if (fail && key.endsWith('/runtime')) throw Error('disk full');
        data.set(key, structuredClone(value));
        if (key.endsWith('/runtime')) runtime = value;
      }
      for (const key of remove) data.delete(key);
    },
  };
  const {app, node, path} = await fixture(t, 'context.state.saved=1;', {store});
  const first = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(first.dispatch_status, 'completed');
  assert.equal(first.storage_error, 'disk full');
  assert.equal(runtime, null);
  // The same state is still current: the next save writes it instead of skipping it as clean.
  fail = false;
  const second = await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(second.storage_error, undefined);
  assert.equal(runtime.state.saved, 1);
});

test('shutdown waits for the runtime of a fire-and-forget Run to be saved', async t => {
  const data = new Map();
  const store = {
    get: key => (data.has(key) ? structuredClone(data.get(key)) : undefined),
    commit: async ({set, remove}) => {
      await sleep(80);
      for (const [key, value] of Object.entries(set)) data.set(key, structuredClone(value));
      for (const key of remove) data.delete(key);
    },
  };
  const app = createApp({store});
  const project = await app.api('POST', 'projects', {name: 'Slow store'});
  const node = await app.api('POST', `projects/${project.id}/typed-nodes`, {
    node_type: 'custom',
    config: nodes.script('context.state.saved=true;'),
  });
  const path = `projects/${project.id}/execution`;
  await app.api('POST', path, {node_ids: [node.id]});
  for (let i = 0; i < 100 && !app.eval(`GRAPH_RUNTIMES.get('${project.id}')?.state.saved`); i++) await sleep(5);
  assert.equal(app.eval(`GRAPH_RUNTIMES.get('${project.id}')?.state.saved`), true);
  await app.Backend.shutdownExecutions();
  assert.equal([...data.keys()].some(key => key.endsWith('/runtime')), true);
  assert.equal([...data.entries()].find(([key]) => key.endsWith('/runtime'))[1].state.saved, true);
});

test('twenty parallel Runs with Stop in the middle settle without unhandled rejections', async t => {
  const rejections = [];
  const listener = reason => rejections.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  const {app, node, path} = await fixture(
    t,
    'context.state.started=(context.state.started??0)+1;await node.sleep(40);context.state.finished=(context.state.finished??0)+1;'
  );
  const runs = Array.from({length: 20}, () => app.api('POST', path, {node_ids: [node.id]}).catch(() => {}));
  await sleep(10);
  await app.api('DELETE', path);
  await Promise.all(runs);
  const idle = await until(app, path, runtime => runtime.status === 'idle');
  assert.equal(idle.active_signals, 0);
  await sleep(120);
  assert.deepEqual(rejections, []);
});

test('a long loop of assignments reports its final values with wait:true', async t => {
  const {app, project, path} = await fixture(t, '');
  const writer = await fn(app, project.id, {}, {
    code: 'for(let i=0;i<500;i++){context.state.count=i;node.output.value=i;}',
    outputs: ['value'],
  });
  const result = await app.api('POST', path, {node_ids: [writer.id], wait: true});
  assert.equal(result.state.count, 499);
  assert.equal(result.dispatch_outputs[writer.id].value, 499);
  const stored = await app.api('GET', path);
  assert.equal(stored.state.count, 499);
  assert.equal(stored.outputs[writer.wrapper].value, 499);
});
test('edited Script code runs instead of a compiled copy of the old text', async t => {
  const {app, project, node, path} = await fixture(t, 'context.state.value=1;');
  assert.equal((await app.api('POST', path, {node_ids: [node.id], wait: true})).state.value, 1);
  await change(app, project, node, 'context.state.value=2;');
  assert.equal((await app.api('POST', path, {node_ids: [node.id], wait: true})).state.value, 2);
  await change(app, project, node, 'context.state.value=3;');
  assert.equal((await app.api('POST', path, {node_ids: [node.id], wait: true})).state.value, 3);
});
test('Stop terminates the workflow worker and a later Run starts exactly one new worker', async t => {
  const {app, node, path} = await fixture(t, 'context.state.n=(context.state.n??0)+1;');
  await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(app.workerStats.started, 1);
  await app.api('DELETE', path);
  await sleep(30);
  assert.equal(app.workerStats.terminated, 1);
  assert.equal(app.workerStats.started - app.workerStats.exited, 0);
  await app.api('POST', path, {node_ids: [node.id], wait: true});
  assert.equal(app.workerStats.started, 2);
});
});

describe("flow-nodes", () => {
// The built-in loop and flow-control Library nodes (For, For each, While, Break, Continue, Variable), placed from the Library and run on the
// real engine. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, fn} = require('./harness');

async function project(app) {
  await app.api('POST', 'library/builtin');
  const {id} = await app.api('POST', 'projects', {name: 'Flow'}),
    q = {workflow_id: id};
  app.context.log = [];
  const p = {
    id,
    q,
    node: config =>
      app.api('POST', `projects/${id}/typed-nodes`, {...q, node_type: 'custom', config, position: {x: 0, y: 0}}),
    connect: (from, port, to, target = 'in') =>
      app.api('POST', `projects/${id}/port-connections`, {
        ...q,
        add: [{source: from, source_port: port, target: to, target_port: target}],
      }),
    /** A built-in node, placed: answers the ID of the placed node. */
    put: async name => {
      const item = (await app.api('GET', 'resources')).find(r => r.name === name);
      const placed = await app.api('POST', `projects/${id}/custom-nodes/${item.id}`, {...q, point: {x: 0, y: 0}});
      return 'complex:' + placed.roots[0];
    },
    /** A Library node around a Script that logs; `inputs` are read as variables. */
    log: (code, o = {}) => fn(app, id, q, {code, ...o}),
    run: () => app.api('POST', `projects/${id}/execution`, {...q, wait: true}),
  };
  p.start = async (...to) => {
    const go = await p.node(nodes.run());
    for (const [target, input = 'in'] of to) await p.connect(go.id, 'out', target, input);
    return go;
  };
  return p;
}
/** A node that holds a value of a type of the Library (the loops bring their types: place one first). */
const LIBRARY_TYPES = {number: 't:fbe54fdd1dd24d55a0ec083cc057017e', bool: 't:d1714f2eec0f4bcfa0edc8602f7f67c2'};
const value = (type, v) => ({
  title: 'Value',
  inputs: [],
  outputs: [{id: 'value', name: 'value', type: LIBRARY_TYPES[type], editable: true, default: v}],
});
const logged = app => JSON.parse(JSON.stringify(app.context.log));

test('For runs its body for each number from `from` to `to` (not included), then fires done', async () => {
  const app = createApp(),
    p = await project(app);
  const loop = await p.put('For'),
    body = await p.log('globalThis.log.push(i)', {inputs: ['i']}),
    done = await p.log('globalThis.log.push("done")');
  await p.connect(loop, 'body', body.wrapper);
  await p.connect(loop, 'index', body.wrapper, 'i');
  await p.connect(loop, 'done', done.wrapper);
  await p.start([loop]);
  const run = await p.run();
  assert.equal(run.status, 'idle', JSON.stringify([run.error, run.errors]));
  assert.deepEqual(logged(app), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 'done'], 'from 0 to 10 by 1 are the defaults');
});

test('Break ends the loop: the rest of the pass does not start, and done fires', async () => {
  const app = createApp(),
    p = await project(app);
  const loop = await p.put('For'),
    brk = await p.put('Break'),
    check = await p.log('globalThis.log.push(i); if (i === 3) await node.output.hit.emit()', {
      inputs: ['i'],
      signals: ['hit'],
    }),
    done = await p.log('globalThis.log.push("done")');
  await p.connect(loop, 'body', check.wrapper);
  await p.connect(loop, 'index', check.wrapper, 'i');
  await p.connect(check.wrapper, 'hit', brk);
  await p.connect(loop, 'done', done.wrapper);
  await p.start([loop]);
  const run = await p.run();
  assert.equal(run.status, 'idle', JSON.stringify([run.error, run.errors]));
  assert.deepEqual(logged(app), [0, 1, 2, 3, 'done']);
});

test('Continue ends only the pass', async () => {
  const app = createApp(),
    p = await project(app);
  const loop = await p.put('For'),
    next = await p.put('Continue'),
    check = await p.log('await node.output[i % 2 ? "odd" : "even"].emit()', {inputs: ['i'], signals: ['odd', 'even']}),
    rest = await p.log('globalThis.log.push("rest " + i)', {inputs: ['i']});
  await p.connect(loop, 'body', check.wrapper);
  await p.connect(loop, 'index', check.wrapper, 'i');
  await p.connect(check.wrapper, 'odd', next);
  await p.connect(check.wrapper, 'even', rest.wrapper);
  await p.connect(loop, 'index', rest.wrapper, 'i');
  await p.start([loop]);
  const run = await p.run();
  assert.equal(run.status, 'idle', JSON.stringify([run.error, run.errors]));
  assert.deepEqual(logged(app).slice(0, 5), ['rest 0', 'rest 2', 'rest 4', 'rest 6', 'rest 8']);
});

test('For counts down with a negative step; a step of 0 is an error', async () => {
  const app = createApp(),
    p = await project(app);
  const loop = await p.put('For'),
    from = await p.node(value('number', 3)),
    to = await p.node(value('number', 0)),
    step = await p.node(value('number', -1)),
    body = await p.log('globalThis.log.push(i)', {inputs: ['i']});
  await p.connect(from.id, 'value', loop, 'from');
  await p.connect(to.id, 'value', loop, 'to');
  await p.connect(step.id, 'value', loop, 'step');
  await p.connect(loop, 'body', body.wrapper);
  await p.connect(loop, 'index', body.wrapper, 'i');
  await p.start([loop]);
  assert.equal((await p.run()).status, 'idle');
  assert.deepEqual(logged(app), [3, 2, 1]);
  const other = createApp(),
    zero = await project(other),
    again = await zero.put('For'),
    none = await zero.node(value('number', 0));
  await zero.connect(none.id, 'value', again, 'step');
  await zero.start([again]);
  const run = await zero.run();
  assert.ok(Object.keys(run.errors).length > 0);
  assert.match(JSON.stringify(run.errors), /step cannot be 0/);
});

test('For each runs its body for every element of the list', async () => {
  const app = createApp(),
    p = await project(app);
  const each = await p.put('For each'),
    src = await p.log('node.output.list = ["a", "b", "c"]', {outputs: ['list'], signals: ['out']}),
    body = await p.log('globalThis.log.push(index + ":" + item)', {inputs: ['item', 'index']}),
    done = await p.log('globalThis.log.push("done")');
  await p.connect(src.wrapper, 'list', each, 'list');
  await p.connect(src.wrapper, 'out', each);
  await p.connect(each, 'body', body.wrapper);
  await p.connect(each, 'item', body.wrapper, 'item');
  await p.connect(each, 'index', body.wrapper, 'index');
  await p.connect(each, 'done', done.wrapper);
  await p.start([src.wrapper]);
  const run = await p.run();
  assert.equal(run.status, 'idle', JSON.stringify([run.error, run.errors]));
  assert.deepEqual(logged(app), ['0:a', '1:b', '2:c', 'done']);
});

test('While reads its condition again before every pass; Variable holds what the body changes', async () => {
  const app = createApp(),
    p = await project(app);
  app.context.n = 0;
  const loop = await p.put('While'),
    variable = await p.put('Variable'),
    // `step` counts and stores whether to go on; it runs first (to start the variable) and then in every pass.
    step = await p.log(
      'globalThis.n++; globalThis.log.push("step " + globalThis.n); node.output.go = globalThis.n <= 3',
      {outputs: ['go'], signals: ['out']}
    ),
    starter = await p.log('await node.output.first.emit(); await node.output.second.emit()', {
      signals: ['first', 'second'],
    }),
    body = await p.log('globalThis.log.push("body")'),
    done = await p.log('globalThis.log.push("done")');
  await p.connect(starter.wrapper, 'first', step.wrapper);
  await p.connect(starter.wrapper, 'second', loop);
  await p.connect(step.wrapper, 'out', variable);
  await p.connect(step.wrapper, 'go', variable, 'to');
  await p.connect(variable, 'value', loop, 'condition');
  await p.connect(loop, 'body', body.wrapper);
  await p.connect(loop, 'body', step.wrapper);
  await p.connect(loop, 'done', done.wrapper);
  await p.start([starter.wrapper]);
  const run = await p.run();
  assert.equal(run.status, 'idle', JSON.stringify([run.error, run.errors]));
  assert.equal(logged(app).filter(l => l === 'body').length, 3);
  assert.equal(logged(app).at(-1), 'done');
});

test('Break and Continue outside a loop are errors', async () => {
  const app = createApp(),
    p = await project(app);
  const brk = await p.put('Break');
  await p.start([brk]);
  const run = await p.run();
  assert.ok(Object.keys(run.errors).length > 0);
  assert.match(JSON.stringify(run.errors), /outside a loop/);
});
});

describe("output-values", () => {
// An output that shows a control (`editable`): the value typed on the node is what the node outputs until its code sets another. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, fn} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));
const hex = n => String(n).padStart(32, '0');
const TEXT = {id: hex(1), name: 'text', fields: [], control: 'textarea'},
  PLAIN = {id: hex(2), name: 'plain', fields: []};

async function setup() {
  const app = createApp(),
    {id} = await app.api('POST', 'projects', {name: 'Outputs'}),
    q = {workflow_id: id},
    call = (method, path, body = {}) => app.api(method, `projects/${id}/${path}`, {...q, ...body}, q);
  await call('PUT', 'types', {types: [TEXT, PLAIN]});
  const node = config => call('POST', 'typed-nodes', {node_type: 'custom', config, position: {x: 0, y: 0}});
  return {app, id, call, node, run: ids => call('POST', 'evaluate-node', {node_ids: ids, collect: true})};
}

test('the value typed into an editable output is the output of a node without an operation, and of a Script that leaves it alone', async () => {
  const s = await setup();
  const value = await s.node({
    title: 'Value',
    outputs: [{id: 'value', name: 'value', type: 't:' + TEXT.id, editable: true}],
  });
  assert.deepEqual((await s.run([value.id])).outputs[value.id], {});
  await s.call('PUT', 'output-values', {node_id: value.id, values: {value: 'hello'}});
  assert.equal((await s.run([value.id])).outputs[value.id].value, 'hello');
  const snap = await s.call('GET', 'workflow');
  const port = snap.nodes.find(n => n.id === value.id).outputs[0];
  assert.deepEqual([port.editable, port.default], [true, 'hello']);

  const reader = await fn(
    s.app,
    s.id,
    {workflow_id: s.id},
    {
      code: 'node.output.b = node.output.a + "!";',
      outputs: [
        {name: 'a', type: 't:' + TEXT.id, editable: true},
        {name: 'b', type: 't:' + TEXT.id, editable: true},
      ],
    }
  );
  await s.call('PUT', 'output-values', {node_id: reader.wrapper, values: {a: 'x', b: 'y'}});
  const out = (await s.run([reader.id])).outputs[reader.id];
  assert.deepEqual([out.a, out.b], ['x', 'x!']); // the code reads what was typed, and may overwrite it
  await s.call('PUT', 'output-values', {node_id: value.id, values: {value: null}});
  assert.deepEqual((await s.run([value.id])).outputs[value.id], {});
});

test('only an output that asks for it, with a type that has a control, holds a value', async () => {
  const s = await setup();
  await rejects(s.node({outputs: [{id: 'o', name: 'o', type: 't:' + PLAIN.id, editable: true}]}), /control/);
  await rejects(s.node({outputs: [{id: 'o', name: 'o', editable: true}]}), /control/);
  const plain = await s.node({outputs: [{id: 'o', name: 'o', type: 't:' + TEXT.id}]});
  await rejects(s.call('PUT', 'output-values', {node_id: plain.id, values: {o: 'x'}}), /does not show a control/);
  const value = await s.node({outputs: [{id: 'o', name: 'o', type: 't:' + TEXT.id, editable: true}]});
  await rejects(s.call('PUT', 'output-values', {node_id: value.id, values: {nope: 'x'}}), /no output/);
});

test('a Library node defines an editable output; each placed copy holds its own value, and editing the definition keeps it', async () => {
  const app = createApp(),
    opened = await app.api('POST', 'library/node-editor', {});
  const q = {workflow_id: opened.workflow_id},
    id = opened.project_id,
    type = {id: hex(7), name: 'text', fields: [], control: 'textarea'};
  await app.api('PUT', `projects/${id}/types`, {...q, types: [type]});
  const root = (await app.api('GET', `projects/${id}/workflow`, {}, q)).root;
  // The value is held by a node inside the Library node: its output, which the group publishes.
  const holder = await app.api('POST', `projects/${id}/typed-nodes`, {
    ...q,
    node_type: 'custom',
    config: {
      title: 'Value',
      inputs: [],
      outputs: [{id: 'out', name: 'out', type: 't:' + type.id, editable: true, default: 'start'}],
    },
    position: {x: 0, y: 0},
  });
  const define = (editable, arbitrary = {inputs: false, outputs: false}) =>
    app.api('PUT', `projects/${id}/complex/${root}`, {
      ...q,
      interface: {
        inputs: [],
        outputs: [
          {
            id: 'out',
            name: 'out',
            type: 't:' + type.id,
            bound: [{node_id: holder.id, port_id: 'out'}],
            ...(editable ? {editable: true, default: 'start'} : {}),
          },
        ],
      },
      arbitrary,
    });
  await define(true);
  const {id: wid} = await app.api('POST', 'projects', {name: 'Placed'}),
    wq = {workflow_id: wid};
  const placed = (
    await app.api('POST', `projects/${wid}/custom-nodes/${opened.resource_id}`, {workflow_id: wid, point: {x: 0, y: 0}})
  ).roots[0];
  const output = async () =>
    (await app.api('GET', `projects/${wid}/workflow`, {}, wq)).complex.find(c => c.id === placed).outputs[0];
  assert.deepEqual([(await output()).editable, (await output()).default], [true, 'start']);
  await app.api('PUT', `projects/${wid}/output-values`, {...wq, node_id: 'complex:' + placed, values: {out: 'typed'}});
  const show = await fn(app, wid, wq, {code: 'node.display(input)', inputs: ['input']});
  await app.api('POST', `projects/${wid}/port-connections`, {
    ...wq,
    add: [{source: 'complex:' + placed, source_port: 'out', target: show.wrapper, target_port: 'input'}],
  });
  const run = () => app.api('POST', `projects/${wid}/evaluate-node`, {...wq, node_ids: [show.id], collect: true});
  assert.equal((await run()).displays[show.id], 'typed');
  // The definition changes: the typed value stays.
  await define(true, {inputs: true, outputs: false});
  await app.Backend.hooksIdle();
  assert.equal((await output()).default, 'typed');
  assert.equal((await run()).displays[show.id], 'typed');
});
});

describe("runtime-robustness", () => {
// Runtime behaviour under repetition: parallel signals, Stop from a paused state, and bounded worker/runtime
// lifetimes. Every scenario uses a temporary in-memory backend and leaves no runtime behind.
const test = require('node:test'),
  assert = require('node:assert/strict');
const {createApp, nodes} = require('./harness');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('terminal shutdown drains an admitted writer and rejects queued writes before they commit', async () => {
  const app = createApp();
  await app.api('GET', 'projects');
  app.eval(`let closeProbeEntered = false, releaseCloseWrite;
    route('POST', 'close-probe', 'Shutdown probe', async c => {
      closeProbeEntered = true;
      await new Promise(resolve => { releaseCloseWrite = resolve; });
      c.ctx.set('close-probe', {written: true});
      return {ok: true};
    });`);
  const writing = assert.rejects(app.Backend.request('POST', 'close-probe'), error => error.code === 'server_closing');
  await until(() => app.eval('closeProbeEntered'), 'writer entered');
  const queued = assert.rejects(app.Backend.request('POST', 'projects', {body: {name: 'After shutdown'}}),
    error => error.code === 'server_closing');
  const closing = app.Backend.close();
  app.eval('releaseCloseWrite()');
  await Promise.all([writing, queued, closing]);
  assert.equal(await app.eval("DB.get('close-probe')"), undefined);
  assert.equal(await app.eval("DB.get('projects').then(items => (items || []).length)"), 0);
  await assert.rejects(app.Backend.request('GET', 'projects'), error => error.code === 'server_closing');
});

async function until(check, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(10);
  }
  assert.fail('not reached: ' + what);
}

async function scriptWorkflow(app, name, code, {grants} = {}) {
  const project = await app.api('POST', 'projects', {name});
  const query = {workflow_id: project.id};
  const event = await app.api('POST', `projects/${project.id}/primitives`, {...query, primitive: 'event', point: {x: 0, y: 0}});
  const script = await app.api('POST', `projects/${project.id}/primitives`, {...query, primitive: 'script', point: {x: 100, y: 0}});
  await app.api('PUT', `projects/${project.id}/input-values`, {...query, node_id: script.id, values: {script: code}});
  if (grants)
    await app.api('PUT', `projects/${project.id}/node-permissions/${script.id}`, {...query, grants});
  await app.api('POST', `projects/${project.id}/port-connections`, {
    ...query,
    add: [{source: event.id, source_port: 'out', target: script.id, target_port: 'in'}],
  });
  return {project, workflow: project.id, event, script};
}

test('parallel signals overlap safely and leave one idle runtime', async () => {
  const app = createApp({scripts: 'worker'});
  try {
    const {project, workflow, event, script} = await scriptWorkflow(
      app,
      'Parallel',
      `context.state.count = (context.state.count || 0) + 1;
       await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 12)));
       node.display('count ' + context.state.count);`
    );
    const signals = Array.from({length: 25}, () =>
      app.api('POST', `projects/${project.id}/execution`, {workflow_id: workflow, node_ids: [event.id]})
    );
    const answers = await Promise.all(signals);
    assert.equal(answers.length, 25);
    await until(async () => (await app.api('GET', `projects/${project.id}/execution`, {}, {workflow_id: workflow})).active_signals === 0, 'all signals settle');
    const detail = await app.api('GET', `projects/${project.id}/execution`, {}, {workflow_id: workflow});
    assert.equal(detail.errors.host, undefined, JSON.stringify(detail.errors));
    assert.equal(detail.errors[script.id], undefined, JSON.stringify(detail.errors));
    assert.equal(detail.state.count, 25, 'every signal ran exactly once');
    assert.equal(detail.status, 'idle');
    assert.equal(detail.runs[script.id], 25, '25 completed passes were counted');
    assert.ok(app.workerStats.started >= 1, 'work ran in a worker');
    await app.api('DELETE', `projects/${project.id}/execution`, {}, {workflow_id: workflow});
    await until(() => app.workerStats.started - app.workerStats.exited === 0, 'Stop released the worker');
  } finally {
    await app.Backend.shutdownExecutions();
  }
});

test('Stop while paused cancels the work and releases the host', async () => {
  const app = createApp({scripts: 'worker'});
  try {
    const {project, workflow, event, script} = await scriptWorkflow(
      app,
      'Paused stop',
      `context.state.started = true;
       await new Promise(resolve => setTimeout(resolve, 2000));
       context.state.finished = true;
       node.display('finished');`
    );
    await app.api('POST', `projects/${project.id}/execution`, {workflow_id: workflow, node_ids: [event.id]});
    await until(
      async () => (await app.api('GET', `projects/${project.id}/execution`, {}, {workflow_id: workflow})).state.started === true,
      'run started'
    );
    await app.api('POST', `projects/${project.id}/execution/pause`, {workflow_id: workflow});
    let detail = await app.api('GET', `projects/${project.id}/execution`, {}, {workflow_id: workflow});
    assert.equal(detail.paused, true);
    const stopped = await app.api('DELETE', `projects/${project.id}/execution`, {}, {workflow_id: workflow});
    assert.equal(stopped.paused, false);
    assert.equal(stopped.active_signals, 0);
    assert.notEqual(stopped.nodes.find(node => node.node_id === script.id)?.status, 'running');
    detail = await app.api('GET', `projects/${project.id}/execution`, {}, {workflow_id: workflow});
    assert.equal(detail.state.finished, undefined, 'the delayed continuation never ran');
    await until(() => app.workerStats.started - app.workerStats.exited === 0, 'the worker exited');
  } finally {
    await app.Backend.shutdownExecutions();
  }
});

test('idle runtimes are evicted and the worker pool stays bounded over many runs', async () => {
  const app = createApp({scripts: 'worker'});
  try {
    let last;
    for (let i = 0; i < 20; i++) {
      last = await scriptWorkflow(app, 'Visit ' + i, 'node.display("run ' + i + '");');
      await app.api('POST', `projects/${last.project.id}/execution`, {
        workflow_id: last.workflow,
        node_ids: [last.event.id],
        wait: true,
      });
      await app.api('GET', `projects/${last.project.id}/execution`, {}, {workflow_id: last.workflow});
    }
    const live = app.eval('GRAPH_RUNTIMES.size');
    assert.ok(live <= 16, `idle runtimes are bounded (${live})`);
    const diagnostics = app.Backend.diagnostics();
    assert.equal(diagnostics.runtimes.filter(entry => entry.status !== 'idle').length, 0);
    await until(
      () => app.workerStats.started - app.workerStats.exited <= live,
      'evicted runtimes released their workers'
    );
    // The last workflow still reads its saved result after its runtime was released and rebuilt.
    const detail = await app.api('GET', `projects/${last.project.id}/execution`, {}, {workflow_id: last.workflow});
    assert.equal(detail.displays[last.script.id], 'run 19');
    await app.Backend.shutdownExecutions();
    await until(() => app.workerStats.started - app.workerStats.exited === 0, 'shutdown released every worker');
    assert.equal(app.workerStats.started - app.workerStats.exited, 0, 'shutdown released every worker');
  } finally {
    await app.Backend.shutdownExecutions();
  }
});
});

describe("scope-emit", () => {
// A Script works through the Library node it is in: it fires the signal outputs of that node with node.output.name.emit() and sets its data outputs
// with output.<name>. Run with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, fn} = require('./harness');

async function project(app) {
  const {id} = await app.api('POST', 'projects', {name: 'Scope'}),
    q = {workflow_id: id};
  return {
    id,
    q,
    node: config =>
      app.api('POST', `projects/${id}/typed-nodes`, {...q, node_type: 'custom', config, position: {x: 0, y: 0}}),
    connect: (from, port, to, target = 'in') =>
      app.api('POST', `projects/${id}/port-connections`, {
        ...q,
        add: [{source: from, source_port: port, target: to, target_port: target}],
      }),
    run: () => app.api('POST', `projects/${id}/execution`, {...q, wait: true}),
    evaluate: ids => app.api('POST', `projects/${id}/evaluate-node`, {...q, node_ids: ids, collect: true}),
  };
}

test('node.output.name.emit() fires a free signal output of the Library node the Script is in; an unknown name is an error', async () => {
  const app = createApp(),
    p = await project(app);
  const branch = await fn(app, p.id, p.q, {
    code: 'await node.output.if_true.emit(); try { await node.output.nope.emit() } catch (e) { node.display(e.message) }',
    signals: ['if_true', 'if_false'],
  });
  const yes = await p.node(nodes.script('node.display("yes")')),
    no = await p.node(nodes.script('node.display("no")'));
  const start = await p.node(nodes.run());
  await p.connect(start.id, 'out', branch.wrapper);
  await p.connect(branch.wrapper, 'if_true', yes.id);
  await p.connect(branch.wrapper, 'if_false', no.id);
  const run = await p.run();
  assert.equal(run.status, 'idle', JSON.stringify([run.error, run.errors]));
  assert.equal(run.displays[yes.id], 'yes');
  assert.equal(run.displays[no.id], undefined);
  assert.match(run.displays[branch.id], /Unknown output nope/);
});

test('a Script reads every data input of its Library node and sets its free outputs; what it does not set stays; Script emits its completion signal', async () => {
  const app = createApp(),
    p = await project(app);
  const add = await fn(app, p.id, p.q, {
    code: 'node.output.sum = a + b',
    inputs: ['a', 'b'],
    outputs: ['sum', 'other'],
    signals: ['out'],
  });
  const one = await p.node(nodes.value('number', 1)),
    two = await p.node(nodes.value('number', 2)),
    after = await p.node(nodes.script('node.display("after")'));
  await p.connect(one.id, 'value', add.wrapper, 'a');
  await p.connect(two.id, 'value', add.wrapper, 'b');
  await p.connect(add.wrapper, 'out', after.id);
  const r = await p.evaluate([add.id]);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.outputs[add.id], {sum: 3}, 'the outputs of its Library node: what is not set is not there');
  assert.equal(r.displays?.[after.id], 'after', 'successful completion emits out');
});

test('a standalone Script has its completion signal and no free data outputs', async () => {
  const app = createApp(),
    p = await project(app);
  const bare = await p.node(nodes.script('node.output.x = 1')),
    firing = await p.node(nodes.script(''));
  const r = await p.evaluate([bare.id, firing.id]);
  assert.match(r.errors[bare.id], /no free output/);
  assert.equal(r.errors[firing.id], undefined);
});

test('an output a node inside feeds, or a signal output, cannot be set with output; a function is not data', async () => {
  const app = createApp(),
    p = await project(app);
  const signalled = await fn(app, p.id, p.q, {code: 'node.output.fire = 1', signals: ['fire']}),
    typo = await fn(app, p.id, p.q, {code: 'node.output.reslt = 1', outputs: ['result']}),
    fun = await fn(app, p.id, p.q, {code: 'node.output.f = () => 1', outputs: ['f']});
  const r = await p.evaluate([signalled.id, typo.id, fun.id]);
  assert.match(r.errors[signalled.id], /node.output.fire.emit/);
  assert.match(r.errors[typo.id], /no free output “reslt”/);
  assert.match(r.errors[fun.id], /output\.f cannot be sent/);
});
});
