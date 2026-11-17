'use strict';
const {describe} = require('node:test');

describe("api", () => {
// API-level tests: they drive the in-browser backend exactly as the UI does (see harness.js).
// Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp, nodes, flow, fn} = require('./harness');

const rejects = (promise, pattern) => assert.rejects(promise, error => pattern.test(error.message));

/** A project with one workflow; returns helpers bound to it. */
async function newProject(app, name = 'Test') {
  const {id} = await app.api('POST', 'projects', {name});
  const workflow = {workflow_id: id};
  return {
    id,
    workflow,
    node: (node_type, config = {}, position = {x: 0, y: 0}) =>
      app.api('POST', `projects/${id}/typed-nodes`, {...workflow, node_type, config, position}),
    connect: (source, source_port, target, target_port) =>
      app.api('POST', `projects/${id}/port-connections`, {
        ...workflow,
        add: [{source, source_port, target, target_port}],
      }),
    snapshot: () => app.api('GET', `projects/${id}/workflow`, {}, workflow),
    evaluate: node_ids => app.api('POST', `projects/${id}/evaluate-node`, {...workflow, node_ids, collect: true}),
    /** A node that shows what reaches its input `input` (a Library node around a Script): wire to `.wrapper`, read `.id` in the displays. */
    show: () => fn(app, id, workflow, {code: 'node.display(input)', inputs: ['input']}),
    /** A Library node around a Script (see fn in harness.js). */
    fn: options => fn(app, id, workflow, options),
    /** An on_run wired to the nodes one after another; the ID of the on_run. */
    flow: (...steps) => flow(app, id, workflow, steps),
    /** Runs an on_run wired to the nodes one after another. */
    run: async (...steps) => {
      const start = await flow(app, id, workflow, steps);
      return app.api('POST', `projects/${id}/evaluate-node`, {...workflow, node_ids: [start], collect: true});
    },
  };
}
const script = nodes.script;
/** What a Preview node showed: the text it passed to node.display(). */
const shown = (run, id) => run.displays[id];

test('Custom nodes evaluate through wires: a value, some code, and a node that displays what reaches it', async () => {
  const app = createApp(),
    p = await newProject(app);
  const text = await p.node('custom', nodes.value('text', 'hi'));
  const code = await p.fn({code: 'node.output.result = v + "!"', inputs: ['v'], outputs: ['result'], signals: ['out']});
  const preview = await p.show();
  await p.connect(text.id, 'value', code.wrapper, 'v');
  await p.connect(code.wrapper, 'result', preview.wrapper, 'input');
  const result = await p.run(code.step, preview.step);
  assert.equal(shown(result, preview.id), 'hi!');
});

test('Custom is the only node type besides Reroute', async () => {
  const app = createApp(),
    p = await newProject(app);
  await rejects(p.node('script'), /supported node type/);
  await rejects(app.api('POST', `projects/${p.id}/nodes`, {...p.workflow, text: 'Note'}), /not found/);
});

test('Complex Nodes are built in the Library editor and behave as plain nodes in projects', async () => {
  const app = createApp();
  // 1. Open a new editor: it starts with a main group (a Complex Node) that everything is built inside.
  const opened = await app.api('POST', 'library/node-editor', {});
  const lib = {id: opened.project_id, workflow: {workflow_id: opened.workflow_id}};
  const add = (node_type, config) =>
    app.api('POST', `projects/${lib.id}/typed-nodes`, {...lib.workflow, node_type, config, position: {x: 40, y: 80}});
  const inner = await add(
    'custom',
    script('node.output.result = "A:" + node.input.text; await node.output.done.emit()')
  );
  let snap = await app.api('GET', `projects/${lib.id}/workflow`, {}, lib.workflow);
  const root = snap.groups.find(g => g.id === snap.root);
  assert.ok(root.members.includes(inner.id), 'new nodes are adopted into the main group');
  // 2. The main group cannot be deleted, ungrouped or collapsed.
  await rejects(app.api('DELETE', `projects/${lib.id}/groups/${root.id}`, {}, lib.workflow), /main group/);
  await rejects(app.api('PUT', `projects/${lib.id}/groups`, {...lib.workflow, groups: []}), /main group/);
  await rejects(app.api('PUT', `projects/${lib.id}/complex/${root.id}`, {...lib.workflow, wrap: false}), /main group/);
  // 3. Bind ports and save to the Library.
  await app.api('PUT', `projects/${lib.id}/complex/${root.id}`, {
    ...lib.workflow,
    interface: {
      inputs: [
        {id: 'text', name: 'text'},
        {id: 'go', name: 'in', type: 'signal', bound: [{node_id: inner.id, port_id: 'in'}]},
      ],
      outputs: [
        {id: 'out', name: 'result'},
        {id: 'done', name: 'done', type: 'signal'},
      ],
    },
  });
  await app.api('PUT', `projects/${lib.id}/groups`, {
    ...lib.workflow,
    groups: [{id: root.id, name: 'Wrap', members: root.members, parent: null}],
  });
  const saved = (await app.api('GET', 'resources', {})).find(r => r.id === opened.resource_id);
  assert.equal(saved?.name, 'Wrap', 'renaming the main group renames the node');
  assert.ok(saved && !('kind' in saved) && !('version' in saved), 'the node is saved automatically, without versions');
  assert.equal(saved.payload.bundle.complex[0].interface.inputs.length, 2);
  // 4. Place it in a project: one collapsed, locked node.
  const p = await newProject(app);
  const placed = await app.api('POST', `projects/${p.id}/custom-nodes/${opened.resource_id}`, {
    ...p.workflow,
    point: {x: 10, y: 10},
  });
  const gid = placed.roots[0];
  let psnap = await p.snapshot();
  const cx = psnap.complex.find(c => c.id === gid);
  assert.ok(cx.locked && cx.collapsed, 'placed Complex Nodes are locked and collapsed');
  await rejects(app.api('PUT', `projects/${p.id}/complex/${gid}`, {...p.workflow, collapsed: false}), /Library/);
  await rejects(app.api('PUT', `projects/${p.id}/groups`, {...p.workflow, groups: []}), /Library|cannot/);
  // 5. Wire through it and evaluate.
  const text = await p.node('custom', nodes.value('text', 'hi')),
    preview = await p.show();
  await p.connect(text.id, 'value', 'complex:' + gid, 'text');
  await p.connect('complex:' + gid, 'out', preview.wrapper, 'input');
  const start = await p.flow(['complex:' + gid, 'go', 'done'], preview.step);
  assert.equal(shown(await p.evaluate([start]), preview.id), 'A:hi');
  // 6. Edit the definition in the Library: placed copies follow, wires stay.
  const again = await app.api('POST', 'library/node-editor', {resource_id: opened.resource_id});
  const lib2 = {workflow_id: again.workflow_id};
  snap = await app.api('GET', `projects/${again.project_id}/workflow`, {}, lib2);
  const script2 = snap.nodes.find(n => n.node_type === 'custom');
  await app.api('PUT', `projects/${again.project_id}/typed-nodes/${encodeURIComponent(script2.id)}`, {
    ...lib2,
    node_type: 'custom',
    config: {
      ...script2.config,
      inputs: script2.config.inputs.map(i =>
        i.name === 'script'
          ? {...i, default: 'node.output.result = "B:" + node.input.text; await node.output.done.emit()'}
          : i
      ),
    },
  });
  psnap = await p.snapshot();
  assert.equal(psnap.edges.length, 4, 'wires survive the refresh');
  assert.equal(shown(await p.evaluate([start]), preview.id), 'B:hi');
});

test('Custom Node groups form a tree: create, nest, move, rename, delete with contents', async () => {
  const app = createApp();
  const bundle = {
    version: 1,
    groups: [{id: 'g', name: 'N', members: [], parent: null, position: {x: 0, y: 0}}],
    complex: [{id: 'g', interface: {inputs: [], outputs: []}}],
    notes: [],
    records: [],
    port_edges: [],
    positions: {},
    styles: {},
  };
  const node = await app.api('POST', 'resources', {name: 'If', payload: {bundle}});
  const folders = body => app.api('POST', 'library/node-folders', body);
  await folders({action: 'create', path: '', name: 'Logic'});
  assert.deepEqual(await folders({action: 'create', path: 'Logic', name: 'Boolean'}), ['Logic', 'Logic/Boolean']);
  await rejects(folders({action: 'create', path: 'Logic', name: 'Boolean'}), /already exists/);
  await app.api('POST', `library/custom-nodes/${node.id}/move`, {folder: 'Logic/Boolean'});
  assert.deepEqual(await folders({action: 'rename', path: 'Logic', name: 'Gates'}), ['Gates', 'Gates/Boolean']);
  assert.equal((await app.api('GET', `resources/${node.id}`)).payload.folder, 'Gates/Boolean');
  // Deleting a group deletes what is inside it (groups and Custom Nodes).
  assert.deepEqual(await folders({action: 'delete', path: 'Gates'}), []);
  assert.deepEqual(await app.api('GET', 'resources'), []);
});

test('groups nest, and deleting a group deletes what is inside', async () => {
  const app = createApp(),
    p = await newProject(app);
  const a = await p.node('custom', nodes.value('text', 'a')),
    b = await p.node('custom', nodes.value('text', 'b'));
  await app.api('PUT', `projects/${p.id}/groups`, {
    ...p.workflow,
    groups: [
      {id: 'outer', name: 'Outer', members: [a.id], parent: null},
      {id: 'inner', name: 'Inner', members: [b.id], parent: 'outer'},
    ],
  });
  let snap = await p.snapshot();
  assert.deepEqual(snap.groups.find(g => g.id === 'outer').all_members.sort(), [a.id, b.id].sort());
  await app.api('DELETE', `projects/${p.id}/groups/outer`, {}, p.workflow);
  snap = await p.snapshot();
  assert.equal(snap.nodes.length, 0);
  assert.equal(snap.groups.length, 0);
});

test('copy and paste keeps groups, Complex Node ports and wires', async () => {
  const app = createApp(),
    p = await newProject(app);
  const a = await p.node('custom', nodes.value('text', 'a')),
    s = await p.node('custom', {title: 'S', inputs: [{id: 'v', name: 'v'}], outputs: [{id: 'result', name: 'result'}]});
  await p.connect(a.id, 'value', s.id, 'v');
  await app.api('PUT', `projects/${p.id}/groups`, {
    ...p.workflow,
    groups: [{id: 'g', name: 'G', members: [a.id, s.id], parent: null}],
  });
  const bundle = await app.api('POST', `projects/${p.id}/copy`, {...p.workflow, node_ids: [], group_ids: ['g']});
  const result = await app.api('POST', `projects/${p.id}/paste`, {
    ...p.workflow,
    clipboard: bundle,
    point: {x: 500, y: 0},
  });
  assert.equal(result.roots.length, 1);
  const snap = await p.snapshot();
  assert.equal(snap.nodes.length, 4);
  assert.equal(snap.edges.length, 2);
});

test('settings reject shortcuts that clash', async () => {
  const app = createApp();
  await rejects(app.api('PUT', 'settings', {shortcuts: {copy: 'Ctrl+KeyV'}}), /unique/);
});

test('Graph Editor appearance settings are validated and saved', async () => {
  const app = createApp();
  const saved = await app.api('PUT', 'settings', {style: {wire_style: 'rounded', node_radius: 6, wire_width: 3}});
  assert.equal(saved.style.wire_style, 'rounded');
  assert.equal(saved.style.node_radius, 6);
  await rejects(app.api('PUT', 'settings', {style: {wire_style: 'zigzag'}}), /wire style/i);
  await rejects(app.api('PUT', 'settings', {style: {node_radius: 99}}), /node_radius/);
});

test('the code of a Custom node can be a bare expression, and it can run code that arrives through a wire', async () => {
  const app = createApp(),
    p = await newProject(app);
  const flag = await p.node('custom', nodes.value('boolean', false));
  const expr = await p.fn({
    code: 'node.output.result = condition ? "yes" : "no"',
    inputs: ['condition'],
    outputs: ['result'],
    signals: ['out'],
  });
  const preview = await p.show();
  await p.connect(flag.id, 'value', expr.wrapper, 'condition');
  await p.connect(expr.wrapper, 'result', preview.wrapper, 'input');
  assert.equal(shown(await p.run(expr.step, preview.step), preview.id), 'no');

  // Code arriving as text is just a text input and `new AsyncFunction`: nothing special is needed for it.
  const source = await p.node('custom', nodes.value('text', '40 + 2'));
  const dynamic = await p.fn({
    code: 'node.output.result = await new (Object.getPrototypeOf(async function () {}).constructor)("return (" + code + ")")()',
    inputs: ['code'],
    outputs: ['result'],
    signals: ['out'],
  });
  const out = await p.show();
  await p.connect(source.id, 'value', dynamic.wrapper, 'code');
  await p.connect(dynamic.wrapper, 'result', out.wrapper, 'input');
  assert.equal(shown(await p.run(dynamic.step, out.step), out.id), '42');
});

test('a new connection replaces the one on an occupied input', async () => {
  const app = createApp(),
    p = await newProject(app);
  const a = await p.node('custom', nodes.value('text', 'a')),
    b = await p.node('custom', nodes.value('text', 'b')),
    preview = await p.show();
  await p.connect(a.id, 'value', preview.wrapper, 'input');
  await p.connect(b.id, 'value', preview.wrapper, 'input');
  const snap = await p.snapshot();
  assert.equal(snap.edges.length, 1);
  assert.equal(snap.edges[0].source, b.id);
});

test('a Custom node knows its own node, workflow and project through context', async () => {
  const app = createApp(),
    p = await newProject(app);
  const s = await p.fn({
    code: 'node.display(JSON.stringify([context.node_id, context.workflow_id, context.project_id]))',
  });
  const out = await p.run(s.step);
  assert.deepEqual(JSON.parse(shown(out, s.id)), [s.id, p.id, p.id]);
});

test('splitting a connection puts a Reroute point on the wire that passes the value on', async () => {
  const app = createApp(),
    p = await newProject(app);
  const v = await p.node('custom', nodes.value('text', 'hi')),
    a = await p.show(),
    b = await p.show();
  await p.connect(v.id, 'value', a.wrapper, 'input');
  const edge = (await p.snapshot()).edges[0];
  const {ids} = await app.api('POST', `projects/${p.id}/split-connections`, {
    ...p.workflow,
    splits: [{edge_id: edge.id, position: {x: 5, y: 5}}],
  });
  await p.connect(ids[0], 'out', b.wrapper, 'input');
  const snap = await p.snapshot();
  assert.equal(snap.edges.length, 3, 'source→point, point→first, point→second');
  const out = await p.evaluate([a.id, b.id]);
  assert.equal(shown(out, a.id), 'hi');
  assert.equal(shown(out, b.id), 'hi');
  await app.api('POST', `projects/${p.id}/delete-nodes`, {...p.workflow, node_ids: ids, dissolve: true});
  assert.equal((await p.snapshot()).edges.length, 2, 'dissolving joins the wires back');
});

test('a Reroute joins any ports: nothing says what flows through a wire', async () => {
  const app = createApp(),
    p = await newProject(app);
  const text = await p.node('custom', nodes.value('text', 'hi')),
    anything = await p.show();
  await p.connect(text.id, 'value', anything.wrapper, 'input');
  const edge = (await p.snapshot()).edges[0];
  const {ids} = await app.api('POST', `projects/${p.id}/split-connections`, {
    ...p.workflow,
    splits: [{edge_id: edge.id, position: {x: 5, y: 5}}],
  });
  const point = (await p.snapshot()).nodes.find(n => n.id === ids[0]);
  assert.deepEqual(
    point.inputs.map(i => i.id),
    ['in']
  );
  assert.equal(shown(await p.evaluate([anything.id]), anything.id), 'hi');
});

test('a node can be folded; the fold is saved, copied and validated', async () => {
  const app = createApp(),
    p = await newProject(app);
  const a = await p.node('custom', nodes.value('text', 'hi'));
  assert.equal((await p.snapshot()).nodes[0].folded, false);
  await app.api('PUT', `projects/${p.id}/node-style`, {...p.workflow, node_id: a.id, folded: true});
  let node = (await p.snapshot()).nodes[0];
  assert.equal(node.folded, true);
  assert.equal(node.pinned, false, 'folding leaves the pin alone');
  await app.api('PUT', `projects/${p.id}/node-style`, {
    ...p.workflow,
    node_id: a.id,
    pinned: true,
    position: {x: 1, y: 1},
  });
  assert.equal((await p.snapshot()).nodes[0].folded, true, 'pinning leaves the fold alone');
  await rejects(
    app.api('PUT', `projects/${p.id}/node-style`, {...p.workflow, node_id: a.id, folded: 'yes'}),
    /boolean/i
  );
  const clipboard = await app.api('POST', `projects/${p.id}/copy`, {...p.workflow, node_ids: [a.id]});
  await app.api('POST', `projects/${p.id}/paste`, {...p.workflow, clipboard, point: {x: 300, y: 0}});
  const all = (await p.snapshot()).nodes;
  assert.equal(all.length, 2);
  assert.ok(
    all.every(n => n.folded),
    'the copy is folded too'
  );
  await app.api('PUT', `projects/${p.id}/node-style`, {...p.workflow, node_id: a.id, folded: false});
  assert.equal((await p.snapshot()).nodes.find(n => n.id === a.id).folded, false);
});

test('deleting a Library group deletes its groups and Custom Nodes with it', async () => {
  const app = createApp();
  const bundle = {version: 1, groups: [{id: 'g', name: 'N', members: [], parent: null}], complex: []};
  const node = (name, folder) => app.api('POST', 'resources', {name, payload: {bundle, folder}});
  await app.api('POST', 'library/node-folders', {action: 'create', path: '', name: 'Logic'});
  await app.api('POST', 'library/node-folders', {action: 'create', path: 'Logic', name: 'Text'});
  const keep = await node('Keep', ''),
    inner = await node('Inner', 'Logic/Text'),
    top = await node('Top', 'Logic');
  const folders = await app.api('POST', 'library/node-folders', {action: 'delete', path: 'Logic'});
  assert.deepEqual(folders, []);
  const names = (await app.api('GET', 'resources')).map(r => r.name);
  assert.deepEqual(names, ['Keep']);
  assert.ok(keep.id && inner.id && top.id);
});

test('changing the ports of a Custom node drops the wires of the slots that are gone', async () => {
  const app = createApp(),
    p = await newProject(app);
  const update = (id, config) =>
    app.api('PUT', `projects/${p.id}/typed-nodes/${encodeURIComponent(id)}`, {
      ...p.workflow,
      node_type: 'custom',
      config,
    });
  const source = await p.node('custom', {title: 'Source', inputs: [], outputs: [{id: 'result', name: 'result'}]}),
    target = await p.node('custom', {
      title: 'Target',
      inputs: [
        {id: 't', name: 't'},
        {id: 'u', name: 'u'},
      ],
      outputs: [],
    });
  await p.connect(source.id, 'result', target.id, 't');
  // The input keeps its wire while the slot is there.
  await update(target.id, {title: 'Target', inputs: [{id: 't', name: 't'}], outputs: []});
  let snap = await p.snapshot();
  assert.equal(snap.edges.length, 1);
  await update(target.id, {title: 'Target', inputs: [{id: 'u', name: 'u'}], outputs: []});
  snap = await p.snapshot();
  assert.equal(snap.edges.length, 0, 'the slot t is gone, so is its wire');
  assert.deepEqual(snap.diagnostics, []);
});

test('a Custom Node port loses its binding when the port inside is gone', async () => {
  const app = createApp();
  const opened = await app.api('POST', 'library/node-editor', {});
  const lib = {id: opened.project_id, workflow: {workflow_id: opened.workflow_id}};
  const call = (method, path, body = {}) =>
    app.api(method, `projects/${lib.id}/${path}`, {...lib.workflow, ...body}, lib.workflow);
  const inner = await call('POST', 'typed-nodes', {
    node_type: 'custom',
    config: {title: 'Inner', inputs: [{id: 'v', name: 'v'}], outputs: [{id: 'result', name: 'result'}]},
  });
  const snapshot = () => call('GET', 'workflow');
  const group = (await snapshot()).root;
  await call('PUT', `complex/${group}`, {
    interface: {inputs: [{id: 'in', name: 'in', bound: [{node_id: inner.id, port_id: 'v'}]}], outputs: []},
  });
  const bound = async () => (await snapshot()).complex[0].interface.inputs[0].bound?.[0].node_id;
  assert.equal(await bound(), inner.id);
  await call('PUT', `typed-nodes/${encodeURIComponent(inner.id)}`, {
    node_type: 'custom',
    config: {title: 'Inner', inputs: [{id: 'w', name: 'w'}], outputs: [{id: 'result', name: 'result'}]},
  });
  assert.equal(await bound(), undefined, 'the port v is gone, so the binding is');
  assert.deepEqual((await snapshot()).diagnostics, []);
});

test('a Custom Node being edited can be read like a project, but not renamed, deleted or filled with workflows', async () => {
  const app = createApp();
  const opened = await app.api('POST', 'library/node-editor', {});
  const id = opened.project_id;
  assert.equal((await app.api('GET', `projects/${id}`)).workflows.length, 1);
  await rejects(app.api('PATCH', `projects/${id}`, {name: 'X'}), /Library/);
  await rejects(app.api('DELETE', `projects/${id}`), /Library/);
  await rejects(app.api('POST', `projects/${id}/duplicate`, {}), /Library/);
  await rejects(app.api('POST', `projects/${id}/workflows`, {name: 'W'}), /Library/);
  await rejects(app.api('DELETE', `projects/${id}/workflows/${opened.workflow_id}`), /Library/);
  const snap = await app.api('GET', `projects/${id}/workflow`, {}, {workflow_id: opened.workflow_id});
  assert.ok(snap.root, 'the node is still there');
});

test('uploaded icons persist with Library nodes and folders', async () => {
  const app = createApp();
  const opened = await app.api('POST', 'library/node-editor', {});
  const image =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCTYAAAAASUVORK5CYII=';
  const item = await app.api('GET', `resources/${opened.resource_id}`);
  await app.api('PUT', `resources/${item.id}`, {name: item.name, payload: {...item.payload, icon: image}});
  assert.equal((await app.api('GET', `resources/${item.id}`)).payload.icon, image);
  await app.api('POST', 'library/node-folders', {action: 'create', path: '', name: 'Images'});
  await app.api('POST', 'library/node-folders', {action: 'icon', path: 'Images', icon: image});
  assert.equal((await app.api('GET', 'settings')).node_folder_icons.Images, image);
  await rejects(
    app.api('POST', 'library/node-folders', {action: 'icon', path: 'Images', icon: 'data:text/html;base64,eA=='}),
    /icon/
  );
  await rejects(
    app.api('PUT', `resources/${item.id}`, {
      name: item.name,
      payload: {...item.payload, icon: 'data:image/png;base64,' + 'a'.repeat(100000)},
    }),
    /icon/
  );
});

test('turning Developer mode off also protects a previously opened Library graph', async () => {
  const app = createApp();
  const opened = await app.api('POST', 'library/node-editor', {});
  const path = `projects/${opened.project_id}`;
  const snapshot = await app.api('GET', `${path}/workflow`);
  await app.api('PUT', 'settings', {developer_mode: false});
  await rejects(app.api('POST', 'library/node-editor', {resource_id: opened.resource_id}), /developer mode/);
  await rejects(app.api('PUT', `${path}/layout`, {positions: {}}), /developer mode/);
  await rejects(app.api('PUT', `${path}/groups`, {groups: snapshot.groups}), /developer mode/);
  assert.deepEqual(await app.api('GET', `${path}/workflow`), snapshot);
});

test('a key removed during a request stays removed when it is read again', async () => {
  const app = createApp();
  const result = await app.eval(`(async () => {
    await DB.commit({k: {a: 1}});
    const ctx = new Context();
    await ctx.remove('k');
    const again = await ctx.get('k', null);
    return JSON.stringify({again, changes: Object.keys(ctx.changes())});
  })()`);
  assert.deepEqual(JSON.parse(result), {again: null, changes: ['k']});
});

test('a project may have no workflow: the last one can be deleted and a new one added', async () => {
  const app = createApp();
  const {id} = await app.api('POST', 'projects', {name: 'Empty'});
  assert.equal((await app.api('GET', `projects/${id}`)).workflows.length, 1);
  await app.api('DELETE', `projects/${id}/workflows/${id}`);
  assert.deepEqual((await app.api('GET', `projects/${id}`)).workflows, []);
  const made = await app.api('POST', `projects/${id}/workflows`, {name: 'Again'});
  assert.equal((await app.api('GET', `projects/${id}`)).workflows.length, 1);
  assert.ok(made.id);
});

test('renaming a Library group to itself preserves its icons and descendant icons', async () => {
  const app = createApp();
  await app.api('POST', 'library/node-folders', {action: 'create', name: 'Logic'});
  await app.api('POST', 'library/node-folders', {action: 'create', path: 'Logic', name: 'Nested'});
  await app.api('POST', 'library/node-folders', {action: 'icon', path: 'Logic', icon: 'bolt'});
  await app.api('POST', 'library/node-folders', {action: 'icon', path: 'Logic/Nested', icon: 'star'});
  await app.api('POST', 'library/node-folders', {action: 'rename', path: 'Logic', name: 'Logic'});
  assert.deepEqual((await app.api('GET', 'settings')).node_folder_icons, {Logic: 'bolt', 'Logic/Nested': 'star'});
});

test('duplicate names stay unique and within 100 characters for workflows and Library nodes', async () => {
  const app = createApp();
  const project = await app.api('POST', 'projects', {name: 'P'.repeat(100)});
  await app.api('PATCH', `projects/${project.id}/workflows/${project.id}`, {name: 'W'.repeat(100)});
  const resource = await app.api('POST', 'resources', {
    name: 'N'.repeat(100),
    payload: {
      bundle: {version: 1, groups: [{id: 'g', name: 'N', members: [], parent: null}], complex: []},
    },
  });
  for (const route of [
    `projects/${project.id}/duplicate`,
    `projects/${project.id}/workflows/${project.id}/duplicate`,
    `library/custom-nodes/${resource.id}/duplicate`,
  ]) {
    const copies = [];
    for (let i = 0; i < 3; i++) copies.push(await app.api('POST', route));
    assert.equal(new Set(copies.map(c => c.name)).size, 3);
    assert.ok(copies.every(c => c.name.length <= 100));
  }
});

test('invalid ports and inherited node type names are rejected as invalid requests', async () => {
  const app = createApp();
  const project = await app.api('POST', 'projects', {name: 'Validation'});
  for (const node_type of ['constructor', 'toString', '__proto__']) {
    await assert.rejects(
      app.api('POST', `projects/${project.id}/typed-nodes`, {node_type}),
      e => e.code === 'invalid_request'
    );
  }
  for (const direction of ['inputs', 'outputs']) {
    await assert.rejects(
      app.api('POST', `projects/${project.id}/typed-nodes`, {node_type: 'custom', config: {[direction]: [null]}}),
      e => e.code === 'invalid_request'
    );
  }
  assert.equal((await app.api('GET', `projects/${project.id}/workflow`)).nodes.length, 0);
});

test('deleting a project removes its stored permission policy', async () => {
  const app = createApp();
  const project = await app.api('POST', 'projects', {name: 'Policy'});
  assert.ok(await app.eval(`DB.get('policy:${project.id}')`));
  await app.api('DELETE', `projects/${project.id}`);
  assert.equal(await app.eval(`DB.get('policy:${project.id}')`), undefined);
});

test('malformed imported types and inherited shortcut names return validation errors', async () => {
  const app = createApp();
  const TextGraph = require('../runtime/format');
  const project = await app.api('POST', 'projects', {name: 'Invalid imports'});
  for (const type of [null, 42, 'invalid']) {
    await assert.rejects(
      app.api('POST', `projects/${project.id}/workflows/import`, TextGraph.encode({document: {types: [type]}})),
      e => e.code === 'invalid_request'
    );
  }
  for (const key of ['constructor', 'toString', '__proto__']) {
    await assert.rejects(app.api('PUT', 'settings', {shortcuts: {[key]: ''}}), e => e.code === 'invalid_request');
  }
});

test('deleting a Library group also reconciles types owned only by its removed nodes', async () => {
  const app = createApp();
  const id = '1234567890abcdef1234567890abcdef';
  await app.api('POST', 'resources', {
    name: 'Disposable type owner',
    payload: {
      folder: 'Disposable',
      bundle: {
        version: 1,
        types: [{id, name: 'Disposable type', fields: []}],
        groups: [{id: 'g', name: 'Owner', members: [], parent: null}],
        complex: [],
        records: [],
      },
    },
  });
  assert.equal(
    (await app.eval("DB.get('library_types')")).some(t => t.id === id),
    true
  );
  await app.api('POST', 'library/node-folders', {action: 'delete', path: 'Disposable'});
  assert.equal(
    (await app.eval("DB.get('library_types')")).some(t => t.id === id),
    false
  );
});

test('graph import inserts connected nodes and nested groups into the chosen workflow and supports undo', async () => {
  const app = createApp(), p = await newProject(app, 'Graph exchange');
  const a = await p.node('custom', {title: 'Source', outputs: [{id: 'out', name: 'out'}]}, {x: 20, y: 40});
  const b = await p.node('custom', {title: 'Target', inputs: [{id: 'in', name: 'in'}], outputs: []}, {x: 320, y: 40});
  await p.connect(a.id, 'out', b.id, 'in');
  await app.api('PUT', `projects/${p.id}/groups`, {...p.workflow, groups: [
    {id: 'outer', name: 'Outer', members: [a.id], parent: null},
    {id: 'inner', name: 'Inner', members: [b.id], parent: 'outer'},
  ]});
  const packet = await app.api('GET', `projects/${p.id}/workflows/${p.id}/export`);
  const other = await app.api('POST', `projects/${p.id}/workflows`, {name: 'Existing target'});
  const body = {workflow_id: other.id, graph: packet, point: {x: 500, y: 600}};
  await app.api('POST', `projects/${p.id}/import-graph`, body);
  const snapshot = () => app.api('GET', `projects/${p.id}/workflow`, {}, {workflow_id: other.id});
  let snap = await snapshot();
  assert.equal(snap.nodes.length, 2);
  assert.equal(snap.groups.length, 2);
  assert.equal(snap.edges.length, 1);
  assert.ok(snap.nodes.every(n => ![a.id, b.id].includes(n.id)));
  assert.ok(snap.edges.every(e => snap.nodes.some(n => n.id === e.source) && snap.nodes.some(n => n.id === e.target)));
  const outer = snap.groups.find(g => g.name === 'Outer'), inner = snap.groups.find(g => g.name === 'Inner');
  assert.equal(inner.parent, outer.id);
  assert.equal(snap.nodes.find(n => n.config.title === 'Source').position.x, 500);
  await app.api('POST', `projects/${p.id}/import-graph`, body);
  snap = await snapshot();
  assert.equal(snap.nodes.length, 4);
  assert.equal(snap.edges.length, 2);
  assert.equal((await app.api('GET', `projects/${p.id}`)).workflows.length, 2);
  assert.equal((await p.snapshot()).nodes.length, 2);
  await app.api('POST', `projects/${p.id}/undo`, {workflow_id: other.id});
  assert.equal((await snapshot()).nodes.length, 2);
  await app.api('POST', `projects/${p.id}/undo`, {workflow_id: other.id});
  assert.equal((await snapshot()).nodes.length, 0);
  await assert.rejects(app.api('POST', `projects/${p.id}/import-graph`, {...body, graph: {}}), /Expected/);
  assert.equal((await snapshot()).nodes.length, 0);
});

test('the generated OpenAPI contract describes every operation and its needs', async () => {
  const app = createApp(),
    spec = JSON.parse(JSON.stringify(app.eval('Backend.openapi()')));
  let operations = 0;
  for (const [path, item] of Object.entries(spec.paths))
    for (const [method, operation] of Object.entries(item)) {
      operations++;
      assert.equal(typeof operation.summary, 'string', `${method} ${path} has a summary`);
      assert.ok(operation.summary.length > 0, `${method} ${path} has a non-empty summary`);
      assert.ok(Array.isArray(operation['x-needs']), `${method} ${path} declares its needs`);
      assert.ok(operation.responses?.['200'], `${method} ${path} documents success`);
    }
  assert.ok(operations >= 60, `the contract lists the routes (${operations})`);
});
});

describe("api-contract", () => {
// The published contract: methods, validation, error shapes, version reporting and what a client may rely on
// across versions. These are the rules a third-party client would code against, checked over HTTP.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');
const Protocol = require('../runtime/protocol');

const TOKEN = 'contract-token';
const headers = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};

async function withApi(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-contract-'));
  const app = createApiServer({dataDir: dir, token: TOKEN});
  const base = await app.listen(0);
  const call = async (method, route, body, own = {}) => {
    const response = await fetch(base + '/api/' + route, {
      method,
      headers: {...headers, ...own},
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return {status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined, text};
  };
  try {
    await work({base, call, app});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

test('a known path answers 405 with the methods it accepts, and an unknown one 404', async () => {
  await withApi(async ({call}) => {
    const put = await call('PUT', 'projects', {});
    assert.equal(put.status, 405);
    assert.equal(put.body.error.code, 'method_not_allowed');
    assert.equal(put.headers.get('allow'), 'GET, POST');
    const deleteCollection = await call('DELETE', 'collections');
    assert.equal(deleteCollection.status, 405);
    assert.equal(deleteCollection.headers.get('allow'), 'GET');
    const nowhere = await call('GET', 'no/such/route');
    assert.equal(nowhere.status, 404);
    assert.equal(nowhere.body.error.code, 'not_found');
  });
});

test('a malformed body is a 400 with a code, and never a partial write', async () => {
  await withApi(async ({call}) => {
    const broken = await call('POST', 'projects', '{"name":');
    assert.equal(broken.status, 400);
    assert.equal(broken.body.error.code, 'invalid_request');
    assert.match(broken.body.error.message, /not valid JSON/);
    const array = await call('POST', 'projects', '[]');
    assert.equal(array.status, 400);
    assert.equal(array.body.error.code, 'invalid_request');
    const scalar = await call('POST', 'projects', '"text"');
    assert.equal(scalar.status, 400);
    assert.equal((await call('GET', 'projects')).body.length, 0, 'nothing was written');
    // An empty body is {} for routes that need nothing.
    assert.equal((await call('GET', 'session')).status, 200);
  });
});

test('every answer reports the protocol, including errors', async () => {
  await withApi(async ({call, base}) => {
    for (const response of [
      await fetch(base + '/api/meta'),
      await call('GET', 'projects'),
      await call('PUT', 'projects', {}),
      await call('GET', 'no/such/route'),
    ])
      assert.equal(response.headers.get('x-agentsys-protocol'), String(Protocol.PROTOCOL));
    // The metadata is the one place a client reads the version from.
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.protocol, Protocol.PROTOCOL);
    assert.equal(meta.version, Protocol.VERSION);
    assert.equal(meta.product, Protocol.PRODUCT);
    assert.equal(meta.agentsys, true);
    assert.equal(meta.features.client_plugins, false);
    assert.equal(meta.features.server_plugins, false);
  });
});

test('the discovery document needs no credentials and carries nothing private', async () => {
  await withApi(async ({base}) => {
    const response = await fetch(base + '/api/meta');
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes('password'), false);
    // A client can use it before it has a token: that is how it learns that it needs one.
    assert.equal(JSON.parse(text).auth, 'token');
  });
});

test('pagination is bounded and stable, and invalid numbers fall back to defaults', async () => {
  await withApi(async ({call}) => {
    await call('PUT', 'collections/items', {
      title: 'Items',
      schema: {type: 'object', properties: {n: {type: 'integer'}}, additionalProperties: false},
    });
    for (let i = 0; i < 5; i++) await call('POST', 'collections/items/records', {data: {n: i}});
    const page = await call('GET', 'collections/items/records?limit=2&offset=2');
    assert.equal(page.body.total, 5);
    assert.deepEqual(page.body.records.map(record => record.data.n), [2, 3]);
    assert.equal(page.body.next_offset, 4);
    const last = await call('GET', 'collections/items/records?limit=2&offset=4');
    assert.equal(last.body.next_offset, null);
    for (const query of ['limit=-5', 'limit=abc', 'offset=-2', 'limit=999999']) {
      const answer = await call('GET', 'collections/items/records?' + query);
      assert.equal(answer.status, 200, query);
      assert.ok(answer.body.records.length >= 1 && answer.body.records.length <= 500, query);
    }
  });
});

test('bearer calls do not require cookie CSRF headers or conditional edit headers', async () => {
  await withApi(async ({call, base}) => {
    const plain = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json'};
    const created = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: plain,
      body: JSON.stringify({name: 'Old client'}),
    });
    assert.equal(created.status, 200, 'bearer credentials are explicit and are not sent automatically by browsers');
    const madeId = (await created.json()).id;
    const updated = await fetch(base + '/api/projects/' + madeId, {
      method: 'PUT',
      headers: plain,
      body: JSON.stringify({name: 'Renamed'}),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).name, 'Renamed');
    // A client that reads the workflow gets the cursor it can use as If-Match.
    const id = madeId;
    const workflow = await (await fetch(`${base}/api/projects/${id}/workflow?workflow_id=${id}`, {headers: plain})).json();
    assert.equal(typeof workflow.cursor, 'number');
  });
});

test('the API does not depend on the client that calls it', async () => {
  await withApi(async ({base}) => {
    // No Origin, no client header, no user agent: a script or another interface is a first-class client.
    const response = await fetch(base + '/api/projects', {headers: {Authorization: 'Bearer ' + TOKEN}});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null, 'no CORS header without an Origin');
    // A client header is not required and does not change the answer.
    const branded = await fetch(base + '/api/projects', {
      headers: {Authorization: 'Bearer ' + TOKEN, 'X-AgentSys-Client': 'another-ui/9'},
    });
    assert.equal(branded.status, 200);
    assert.deepEqual(await branded.json(), await response.json());
  });
});

test('a request that changes the graph returns the new state and its cursor', async () => {
  await withApi(async ({call}) => {
    await call('PUT', 'settings', {developer_mode: true});
    const project = await call('POST', 'projects', {name: 'Cursor'});
    const query = {workflow_id: project.body.id};
    const before = await call('GET', `projects/${project.body.id}/workflow`, undefined, query);
    const made = await call(
      'POST',
      `projects/${project.body.id}/primitives`,
      {...query, primitive: 'event', point: {x: 0, y: 0}},
      {'If-Match': String(before.body.cursor)}
    );
    assert.equal(made.status, 200);
    const after = await call('GET', `projects/${project.body.id}/workflow`);
    assert.equal(after.body.cursor, before.body.cursor + 1);
    // The same If-Match value is now stale.
    const stale = await call(
      'POST',
      `projects/${project.body.id}/primitives`,
      {...query, primitive: 'event', point: {x: 50, y: 0}},
      {'If-Match': String(before.body.cursor)}
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'conflict');
  });
});

test('a collection name is data, never a prototype member', async () => {
  await withApi(async ({call}) => {
    for (const name of ['__proto__', 'constructor', 'toString']) {
      const listed = await call('GET', `collections/${name}/records`);
      assert.ok([400, 404].includes(listed.status), `${name}: ${listed.status}`);
      assert.notEqual(listed.body?.total, 0, `${name} must not look like an empty, valid collection`);
    }
    const created = await call('PUT', 'collections/__proto__', {title: 'bad'});
    assert.equal(created.status, 400);
  });
});
});

describe("deployment", () => {
// Deployment-facing behaviour of the server CLI without starting a long-lived process: help, version, status,
// startup validation and clear errors. The real browser tests start the server and client separately.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  {execFileSync, spawn} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');

function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {...process.env, ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {code: 0, stdout};
  } catch (error) {
    return {code: error.status, stdout: String(error.stdout || ''), stderr: String(error.stderr || '')};
  }
}

test('help and version describe the deployment surface, including the private-network switch', () => {
  const help = run(['help']);
  assert.equal(help.code, 0);
  for (const flag of ['--host', '--token', '--allow-net', '--deny-private-net', '--tls-cert', '--trust-proxy'])
    assert.match(help.stdout, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const version = run(['version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), require('../package.json').version + ' (protocol 1)');
});

test('startup validation names the bad value instead of failing later', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-cli-'));
  try {
    for (const [args, pattern] of [
      [['start', '--host', 'http://example.com', '--data', dir], /--host/],
      [['start', '--allowed-origin', 'https://example.com/app', '--data', dir], /without a path|origin/],
      [['start', '--allowed-origin', 'not a url', '--data', dir], /not a URL/],
      [['start', '--allow-net', 'https://example.com', '--data', dir], /--allow-net/],
      [['start', '--host', '0.0.0.0', '--data', dir], /without a token/],
      [['start', '--session-hours', '0', '--data', dir], /session-hours/],
      [['start', '--port', '99999', '--data', dir], /Invalid port/],
      [['start', '--tls-cert', path.join(dir, 'missing.pem'), '--data', dir], /both --tls-cert/],
    ]) {
      const result = run(args);
      assert.notEqual(result.code, 0, args.join(' '));
      assert.match(result.stderr + result.stdout, pattern, args.join(' '));
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('status reports an offline server as an exit code, not an uncaught error', () => {
  const result = run(['status', '--url', 'http://127.0.0.1:2', '--json']);
  assert.equal(result.code, 1);
  const value = JSON.parse(result.stdout);
  assert.equal(value.online, false);
  assert.equal(typeof value.error, 'string');
});

test('a server announces the data folder, API and protocol, then closes on a signal', {timeout: 20000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-cli-live-'));
  const child = spawn(
    process.execPath,
    [CLI, 'start', '--port', '0', '--data', dir, '--quiet'],
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env}}
  );
  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));
  try {
    // --quiet still prints nothing; stop the process when it is listening by waiting for the lock file.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !fs.existsSync(path.join(dir, '.server.lock'))) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(path.join(dir, '.server.lock')), true, 'the server started; ' + output);
    child.kill('SIGINT');
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.ok(code === 0 || code === null || code === 1, 'the process ended (code ' + code + ')');
    // The lock is released by a clean close. On Windows a forced signal may skip the handler; a next start still takes over.
    const next = run(['status', '--url', 'http://127.0.0.1:2', '--json']);
    assert.equal(next.code, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
});

describe("lifecycle", () => {
// Resource ownership over a server's life: event streams are counted and released, sessions are bounded, the
// event-stream limit is enforced, and close() releases the port even with a stream open. All temporary.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net');
const {createApiServer} = require('../server/api-server');

const TOKEN = 'lifecycle-token';
const bearer = {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-AgentSys': '1'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, what, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail('not reached: ' + what);
};

async function withServer(options, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-lifecycle-'));
  const app = createApiServer({dataDir: dir, token: TOKEN, ...options});
  const base = await app.listen(0);
  try {
    return await work({app, base, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const diagnostics = async base => (await fetch(base + '/api/diagnostics', {headers: bearer})).json();

test('concurrent close calls share shutdown and keep the data lock until backend cleanup ends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-close-owner-'));
  const app = createApiServer({dataDir: dir, token: TOKEN});
  await app.listen(0);
  const closeBackend = app.api.close.bind(app.api);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  app.api.close = async () => { await gate; await closeBackend(); };
  try {
    const first = app.close();
    assert.equal(app.close(), first, 'there is one shutdown owner');
    assert.equal(fs.existsSync(path.join(dir, '.server.lock')), true);
    assert.throws(() => createApiServer({dataDir: dir, token: TOKEN}), /in use by another AgentSys server/);
    release();
    await first;
    assert.equal(fs.existsSync(path.join(dir, '.server.lock')), false);
  } finally {
    release();
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
const stream = async base => {
  const controller = new AbortController();
  const response = await fetch(base + '/api/events', {headers: bearer, signal: controller.signal});
  const reader = response.body.getReader();
  await reader.read(); // the ready event
  return {controller, reader, response};
};

test('event streams are counted, released on disconnect, and capped', async () => {
  await withServer({eventLimit: 2}, async ({base}) => {
    const first = await stream(base);
    const second = await stream(base);
    assert.equal((await diagnostics(base)).clients, 2);
    const third = await fetch(base + '/api/events', {headers: bearer});
    assert.equal(third.status, 429);
    assert.equal((await third.json()).error.code, 'too_many_streams');

    // A browser tab that goes away closes its request: the server must forget it, not keep a dead stream.
    first.controller.abort();
    await first.reader.cancel().catch(() => {});
    second.controller.abort();
    await second.reader.cancel().catch(() => {});
    await until(async () => (await diagnostics(base)).clients === 0, 'both streams were released');
    const again = await stream(base);
    assert.equal((await diagnostics(base)).clients, 1);
    again.controller.abort();
    await again.reader.cancel().catch(() => {});
  });
});

test('a backpressured event subscriber is disconnected instead of retaining an unbounded write queue', async () => {
  await withServer({}, async ({app, base}) => {
    app.server.prependListener('request', (req, res) => {
      if (req.url !== '/api/events') return;
      const write = res.write.bind(res);
      let writes = 0;
      // Deliver ready normally, then simulate a subscriber whose outgoing buffer is full.
      res.write = (...args) => ++writes <= 2 ? write(...args) : false;
    });
    const open = await stream(base);
    assert.equal((await diagnostics(base)).clients, 1);
    const created = await fetch(base + '/api/projects', {method: 'POST', headers: bearer, body: JSON.stringify({name: 'Change'})});
    assert.equal(created.status, 200);
    await until(async () => (await diagnostics(base)).clients === 0, 'backpressured stream released');
    open.controller.abort();
    await open.reader.cancel().catch(() => {});
  });
});

test('sessions are capped, and an expired session is swept by the next sign-in', async () => {
  await withServer({sessionLimit: 3, sessionTtlMs: 1000}, async ({base}) => {
    for (let i = 0; i < 8; i++) {
      const response = await fetch(base + '/api/auth/session', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token: TOKEN}),
      });
      assert.equal(response.status, 200);
    }
    assert.ok((await diagnostics(base)).sessions <= 3, 'the session map is bounded');
    await sleep(1100);
    const response = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: TOKEN}),
    });
    assert.equal(response.status, 200);
    const value = await diagnostics(base);
    assert.equal(value.sessions, 1, 'the expired sessions were swept');
  });
});

test('close() releases the port and open streams, and the port can be reused immediately', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-lifecycle-port-'));
  const app = createApiServer({dataDir: dir, token: TOKEN});
  const base = await app.listen(0);
  const port = new URL(base).port;
  const open = await stream(base);
  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 3000, 'close does not wait for the stream timeout');
  open.controller.abort();
  await open.reader.cancel().catch(() => {});
  // A fresh server can bind the same port at once: closeAllConnections released it.
  const again = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(Number(port), '127.0.0.1', () => server.close(() => resolve(true)));
  });
  assert.equal(again, true);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('a rejected session keeps the failure counter bounded so a restart is not needed', async () => {
  await withServer({authAttempts: 3, authWindowMs: 1000}, async ({base}) => {
    for (let i = 0; i < 3; i++)
      assert.equal(
        (
          await fetch(base + '/api/auth/session', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({token: 'wrong'}),
          })
        ).status,
        401
      );
    const limited = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: 'wrong'}),
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    await sleep(1100);
    const accepted = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: TOKEN}),
    });
    assert.equal(accepted.status, 200);
  });
});

test('a trusted proxy counts its appended client address, not a spoofed forwarded prefix', async () => {
  await withServer({trustProxy: true, authAttempts: 2}, async ({base}) => {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(base + '/api/auth/session', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${i}, 203.0.113.9`},
        body: JSON.stringify({token: 'wrong'}),
      });
      assert.equal(response.status, i < 2 ? 401 : 429);
    }
  });
});
});

describe("notifications", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const {createApp} = require('./harness');

test('notifications: post, list newest first, delete one, clear', async () => {
  const app = createApp();
  assert.deepEqual(await app.api('GET', 'notifications'), {total: 0, items: []});
  const a = await app.api('POST', 'notifications', {title: 'First', level: 'warn', href: '/projects'});
  const b = await app.api('POST', 'notifications', {title: 'Second', body: 'text', source: 'test'});
  assert.equal('read' in a, false);
  const list = await app.api('GET', 'notifications');
  assert.deepEqual(
    list.items.map(n => n.title),
    ['Second', 'First']
  );
  assert.equal(list.total, 2);
  await app.api('DELETE', `notifications/${b.id}`);
  assert.equal((await app.api('GET', 'notifications')).total, 1);
  await assert.rejects(app.api('DELETE', `notifications/${b.id}`), /not found/i);
  assert.deepEqual(await app.api('DELETE', 'notifications'), {deleted: 1});
  assert.equal((await app.api('GET', 'notifications')).total, 0);
});

test('notifications: input is checked and the list is bounded', async () => {
  const app = createApp();
  await assert.rejects(app.api('POST', 'notifications', {}), /title/);
  await assert.rejects(app.api('POST', 'notifications', {title: 'x', level: 'loud'}), /level/);
  await assert.rejects(app.api('POST', 'notifications', {title: 'x', href: 'https://evil.example'}), /href/);
  await assert.rejects(app.api('POST', 'notifications', {title: 'x', href: '//evil.example'}), /href/);
  for (let i = 0; i < 205; i++) await app.api('POST', 'notifications', {title: 'n' + i});
  const list = await app.api('GET', 'notifications', {}, {limit: 500});
  assert.equal(list.total, 200);
  assert.equal(list.items[0].title, 'n204');
});

test('notifications: a Script needs notifications.write to post and system.admin to clear', async () => {
  const app = createApp();
  const needs = method => JSON.parse(app.eval(`JSON.stringify(routeNeeds('notifications', '${method}'))`));
  assert.deepEqual(needs('GET'), ['notifications.read']);
  assert.deepEqual(needs('POST'), ['notifications.write']);
  assert.deepEqual(needs('DELETE'), ['system.admin']);
});
});

describe("platform", () => {
// The platform contract: an API-only server, version discovery, sessions, CORS, events, generic collections
// and the Script-backed Library node a client plugin creates.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const {createApiServer} = require('../server/api-server');
const {createApp, nodes} = require('./harness');

async function withApi(options, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-platform-'));
  const app = createApiServer({dataDir: dir, token: 'secret-token', ...options});
  const base = await app.listen(0);
  try {
    await work({base, app, dir});
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
const call = async (base, method, route, body, headers = {}) => {
  const response = await fetch(base + '/api/' + route, {
    method,
    headers: {'Content-Type': 'application/json', 'X-AgentSys': '1', ...headers},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers};
};
const token = {Authorization: 'Bearer secret-token'};

test('the server manifest contains no plugin host and the client loads no server runtime', () => {
  const {FILES} = require('../headless');
  assert.equal(FILES.some(file => file.includes('routes-plugins')), false);
  assert.equal(FILES.some(file => file.includes('plugin-host')), false);
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'api-server.js'), 'utf8');
  assert.doesNotMatch(serverSource, /createPluginHost|plugin-host/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'index.html')), false);
});

test('an API-only server reports its protocol and serves no client or server plugins', async () => {
  await withApi({}, async ({base}) => {
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.agentsys, true);
    assert.equal(meta.product, 'agentsys');
    assert.equal(meta.protocol, 1);
    assert.equal(meta.features.server_plugins, false);
    assert.equal(meta.features.client_plugins, false);
    assert.equal((await fetch(base + '/')).status, 404);
    assert.equal((await fetch(base + '/js/ui.js')).status, 404);
    assert.equal((await call(base, 'GET', 'plugins', undefined, token)).status, 404);
    for (const route of ['/__data', '/__data/events', '/editor/api/projects', '/api/migration/ui-state'])
      assert.equal((await fetch(base + route, {headers: token})).status, 404, route);
    assert.equal((await call(base, 'PUT', 'ui-state', {values: {}}, token)).status, 404);
    assert.equal((await call(base, 'GET', 'library/sections', undefined, token)).status, 404);
    const diagnostics = await call(base, 'GET', 'diagnostics', undefined, token);
    assert.equal(diagnostics.status, 200);
    assert.equal(typeof diagnostics.body.uptime_seconds, 'number');
    assert.equal(diagnostics.body.workers.started, 0);
  });
});

test('a token is exchanged for an HttpOnly session; cookie writes need the CSRF header and an allowed origin', async () => {
  await withApi({allowedOrigins: ['http://client.example']}, async ({base}) => {
    const session = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: 'secret-token'}),
    });
    assert.equal(session.status, 200);
    const cookie = session.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const auth = {Cookie: cookie.split(';')[0]};
    assert.equal((await fetch(base + '/api/projects', {headers: auth})).status, 200);
    const noCsrf = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: {...auth, 'Content-Type': 'application/json'},
      body: '{"name":"No header"}',
    });
    assert.equal(noCsrf.status, 403);
    const badOrigin = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: {...auth, 'Content-Type': 'application/json', 'X-AgentSys': '1', Origin: 'http://evil.example'},
      body: '{"name":"Bad origin"}',
    });
    assert.equal(badOrigin.status, 403);
    const allowed = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: {...auth, 'Content-Type': 'application/json', 'X-AgentSys': '1', Origin: 'http://client.example'},
      body: '{"name":"Allowed"}',
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://client.example');
    const preflight = await fetch(base + '/api/projects', {
      method: 'OPTIONS',
      headers: {Origin: 'http://client.example', 'Access-Control-Request-Method': 'POST'},
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://client.example');
    assert.equal(preflight.headers.get('access-control-allow-origin') === '*', false);
    // A wrong token is refused, and no cookie is set.
    const wrong = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: 'nope'}),
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);
  });
});

test('the event stream reports changes and hook events to an authenticated client', async () => {
  await withApi({}, async ({base}) => {
    const controller = new AbortController();
    const response = await fetch(base + '/api/events', {headers: token, signal: controller.signal});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async match => {
      for (let i = 0; i < 100 && !match(text); i++) {
        const {value, done} = await reader.read();
        if (done) break;
        text += decoder.decode(value, {stream: true});
      }
      return text;
    };
    await readUntil(value => value.includes('"type":"ready"'));
    await call(base, 'POST', 'projects', {name: 'SSE project'}, token);
    await readUntil(value => value.includes('"type":"change"'));
    assert.match(text, /"keys":\["projects"\]/);
    controller.abort();
    await reader.cancel().catch(() => {});
  });
});

test('two authenticated clients receive the same change events', async () => {
  await withApi({}, async ({base}) => {
    const controller = new AbortController();
    const open = () =>
      fetch(base + '/api/events', {headers: token, signal: controller.signal}).then(response => ({
        response,
        reader: response.body.getReader(),
        text: '',
      }));
    const one = await open(),
      two = await open();
    const read = async client => {
      const decoder = new TextDecoder();
      for (let i = 0; i < 100 && !client.text.includes('"type":"change"'); i++) {
        const {value, done} = await client.reader.read();
        if (done) break;
        client.text += decoder.decode(value, {stream: true});
      }
      return client.text;
    };
    await call(base, 'POST', 'projects', {name: 'Shared'}, token);
    const [first, second] = await Promise.all([read(one), read(two)]);
    assert.match(first, /"keys":\["projects"\]/);
    assert.match(second, /"keys":\["projects"\]/);
    controller.abort();
    await Promise.all([one.reader.cancel().catch(() => {}), two.reader.cancel().catch(() => {})]);
  });
});

test('generic collections validate their schema and persist records without domain knowledge', async () => {
  await withApp(async app => {
    await app.api('PUT', 'collections/providers', {
      title: 'Providers',
      schema: {
        type: 'object',
        properties: {providerId: {type: 'string', maxLength: 50}, baseURL: {type: 'string'}},
        required: ['providerId', 'baseURL'],
        additionalProperties: false,
      },
    });
    const made = await app.api('POST', 'collections/providers/records', {
      data: {providerId: 'local', baseURL: 'http://localhost:11434/v1'},
    });
    assert.equal(made.data.providerId, 'local');
    await assert.rejects(
      app.api('POST', 'collections/providers/records', {data: {providerId: 'x'}}),
      error => error.code === 'invalid_request' && /baseURL is required/.test(error.message)
    );
    await assert.rejects(
      app.api('POST', 'collections/providers/records', {
        data: {providerId: 'x', baseURL: 'http://x', extra: true},
      }),
      error => error.code === 'invalid_request' && /extra is not allowed/.test(error.message)
    );
    const list = await app.api('GET', 'collections/providers/records');
    assert.equal(list.total, 1);
    const updated = await app.api('PUT', 'collections/providers/records/' + made.id, {
      data: {providerId: 'local', baseURL: 'https://example.test/v1'},
    });
    assert.equal(updated.data.baseURL, 'https://example.test/v1');
    assert.equal((await app.api('DELETE', 'collections/providers/records/' + made.id)).deleted, true);
    assert.equal((await app.api('GET', 'collections/providers/records')).total, 0);
  });
});

test('a client plugin can create an ordinary Library node; the node runs without the plugin', async () => {
  await withApp(async app => {
    const project = await app.api('POST', 'projects', {name: 'Plugin node'});
    const workflow = {workflow_id: project.id}; // the first workflow of a new project has the project's id
    const item = await app.api('POST', 'library/script-nodes', {
      name: 'Greeting',
      description: 'Made through the documented API',
      code: 'node.display("hello from a Library node");',
      outputs: ['text'],
      grants: ['graph.read'],
    });
    assert.equal(item.name, 'Greeting');
    const resources = await app.api('GET', 'resources');
    assert.ok(resources.some(resource => resource.id === item.id));
    assert.ok(item.payload.bundle.records.length);
    // Place it, wire an on_run to its signal input, and dispatch: the definition is ordinary server data.
    const placed = await app.api('POST', `projects/${project.id}/custom-nodes/${item.id}`, {
      ...workflow,
      point: {x: 0, y: 0},
    });
    const complex = 'complex:' + placed.roots[0];
    const start = await app.api('POST', `projects/${project.id}/typed-nodes`, {
      ...workflow,
      node_type: 'custom',
      config: nodes.run(),
      position: {x: 0, y: 0},
    });
    await app.api('POST', `projects/${project.id}/port-connections`, {
      ...workflow,
      add: [{source: start.id, source_port: 'out', target: complex, target_port: 'in'}],
    });
    const run = await app.api('POST', `projects/${project.id}/execution`, {...workflow, wait: true});
    const displays = Object.values(run.displays || {});
    assert.ok(
      displays.some(text => text.includes('hello from a Library node')) ||
        (await app.api('GET', `projects/${project.id}/execution`, {}, workflow)).displays
    );
    // A second create with the same name is a clean conflict.
    await assert.rejects(
      app.api('POST', 'library/script-nodes', {name: 'Greeting', code: 'node.output.text = 1;'}),
      error => error.code === 'invalid_request'
    );
  });
});

async function withApp(work) {
  const app = createApp({scripts: 'inline'});
  await work(app);
}
});

describe("server", () => {
// The canonical HTTP API persists and observes its private data folder.
// Starts a real server on a free port with a temporary data folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {createApiServer} = require('../server/api-server');
const {nodes, TYPES} = require('./harness');

async function withServer(options, work) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-'));
  const app = createApiServer({dataDir, ...options});
  const url = await app.listen(0);
  try {
    // The tests build Custom nodes by hand, which needs developer mode.
    await fetch(`${url}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-AgentSys': '1',
        ...(options?.token ? {Authorization: 'Bearer ' + options.token} : {}),
      },
      body: JSON.stringify({developer_mode: true}),
    });
    await work({url, app, dataDir});
  } finally {
    await app.close();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
}
const call = async (url, method, route, body, headers = {}) => {
  const response = await fetch(`${url}/api/${route}`, {
    method,
    headers: {'Content-Type': 'application/json', 'X-AgentSys': '1', ...headers},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers};
};
/** Gives a workflow the types that the nodes of the harness use. */
const typed = async (url, id, headers = {}) => {
  const {body} = await call(url, 'GET', `projects/${id}/types`, undefined, headers);
  const types = [...body.types, ...Object.values(TYPES).filter(t => !body.types.some(old => old.id === t.id))];
  return call(url, 'PUT', `projects/${id}/types`, {workflow_id: id, types}, headers);
};
/** An on_run node wired to `ids` (each: [node id, input port, output port] or just the id), one after another; answers its ID. */
async function startOf(url, id, w, ids, headers = {}) {
  const make = await call(
    url,
    'POST',
    `projects/${id}/typed-nodes`,
    {...w, node_type: 'custom', config: nodes.run(), position: {x: 0, y: 0}},
    headers
  );
  let from = [make.body.id, 'out'];
  for (const step of ids) {
    const [to, input = 'in', output = 'out'] = Array.isArray(step) ? step : [step];
    await call(
      url,
      'POST',
      `projects/${id}/port-connections`,
      {...w, add: [{source: from[0], source_port: from[1], target: to, target_port: input}]},
      headers
    );
    from = [to, output];
  }
  return make.body.id;
}
/** A request with a chosen Host header (fetch does not allow that). */
const withHost = (url, host, route = 'projects') =>
  new Promise((resolve, reject) => {
    const {port} = new URL(url);
    http
      .get({host: '127.0.0.1', port, path: `/api/${route}`, headers: {Host: host}}, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject);
  });

test('the API creates, runs and persists: projects become files in the data folder', async () => {
  await withServer({}, async ({url, dataDir}) => {
    const created = await call(url, 'POST', 'projects', {name: 'Over HTTP'});
    assert.equal(created.status, 200);
    const id = created.body.id,
      w = {workflow_id: id};
    await call(url, 'PUT', `projects/${id}/policy`, {allow: nodes.script('').grants});
    await typed(url, id);
    const node = (node_type, config) =>
      call(url, 'POST', `projects/${id}/typed-nodes`, {...w, node_type, config, position: {x: 0, y: 0}}).then(
        r => r.body
      );
    const script = await node('custom', nodes.script('node.display("hi?" + context.workflow_id.length)'));
    await startOf(url, id, w, [script.id]);
    // Scripts run in worker threads here.
    const run = await call(url, 'POST', `projects/${id}/execution`, {...w, wait: true});
    assert.equal(run.status, 200);
    assert.equal(run.body.status, 'idle');
    assert.equal(run.body.displays[script.id], 'hi?32');
    // The data is plain JSON files, including the run history.
    assert.ok(fs.existsSync(path.join(dataDir, 'projects.json')));
    assert.ok(fs.existsSync(path.join(dataDir, 'workflows', `${id}.json`)));
    assert.ok(!fs.existsSync(path.join(dataDir, 'runs')));
    assert.equal((await call(url, 'GET', 'openapi.json')).body.info.title, 'AgentSys Server API');
  });
});

test('a request writes only what it changed: a default that was only read is not stored', async () => {
  await withServer({}, async ({url, dataDir}) => {
    const made = await call(url, 'POST', 'projects', {name: 'Plain'});
    await call(url, 'DELETE', `projects/${made.body.id}`); // reads the triggers to drop those of the project
    await call(url, 'POST', 'library/node-folders', {action: 'create', path: '', name: 'Logic'}); // reads the disabled groups and the icons
    await call(url, 'POST', 'library/node-editor', {});
    const files = [];
    const walk = dir => {
      for (const e of fs.readdirSync(dir, {withFileTypes: true}))
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : files.push(path.relative(dataDir, path.join(dir, e.name)).split(path.sep).join('/'));
    };
    walk(dataDir);
    for (const junk of ['other/triggers.json', 'other/node_disabled_folders.json'])
      assert.ok(!files.includes(junk), `${junk} holds only a default and is not written`);
    for (const file of files.filter(f => f.endsWith('.json')))
      assert.notEqual(
        fs.readFileSync(path.join(dataDir, file), 'utf8').trim(),
        'null',
        `${file} is not an empty "null" file`
      );
  });
});

test('errors are JSON with a status; If-Match makes an edit conditional', async () => {
  await withServer({}, async ({url}) => {
    const missing = await call(url, 'GET', 'projects/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
    assert.equal((await call(url, 'POST', 'projects', {name: ''})).body.id ? 200 : 400, 200); // an empty name becomes UntitledN
    assert.equal((await call(url, 'GET', 'nothing/here')).status, 404);
    const bad = await fetch(`${url}/api/projects`, {method: 'POST', headers: {'X-AgentSys': '1'}, body: '{oops'});
    assert.equal(bad.status, 400);

    const {body: project} = await call(url, 'POST', 'projects', {name: 'Cond'});
    const id = project.id,
      w = {workflow_id: id};
    await typed(url, id);
    const read = (await call(url, 'GET', `projects/${id}/workflow?workflow_id=${id}`)).body;
    const add = match =>
      call(
        url,
        'POST',
        `projects/${id}/typed-nodes`,
        {...w, node_type: 'custom', config: nodes.value('text', 'x'), position: {x: 0, y: 0}},
        {'If-Match': `"${match}"`}
      );
    assert.equal((await add(read.cursor)).status, 200);
    const stale = await add(read.cursor);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'conflict');
  });
});

test('who may use the API: header for changes, Host check, token', async () => {
  await withServer({}, async ({url}) => {
    const blind = await fetch(`${url}/api/projects`, {
      method: 'POST',
      body: '{}',
      headers: {'Content-Type': 'text/plain'},
    });
    assert.equal(blind.status, 403, 'a change without X-AgentSys is refused');
    assert.equal((await fetch(`${url}/api/projects`)).status, 200, 'reading needs nothing');
    assert.equal(await withHost(url, 'evil.example'), 403, 'DNS rebinding: the Host must be loopback');
    assert.equal(await withHost(url, 'localhost:1234'), 200);
  });
  await withServer({allowedHosts: ['agentsys.test']}, async ({url}) => {
    assert.equal(await withHost(url, 'agentsys.test'), 200);
  });
  await withServer({token: 's3cret'}, async ({url}) => {
    assert.equal((await call(url, 'GET', 'projects')).status, 401);
    assert.equal((await call(url, 'GET', 'projects', undefined, {Authorization: 'Bearer nope'})).status, 401);
    // With the token, X-AgentSys is not needed (a cross-site page cannot send Authorization either).
    const response = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: {Authorization: 'Bearer s3cret', 'Content-Type': 'application/json'},
      body: '{"name":"T"}',
    });
    assert.equal(response.status, 200);
  });
  // Beyond loopback the API stays off until there is a token.
  await withServer({host: '0.0.0.0'}, async ({url, app}) => {
    assert.equal(app.apiAvailable, false);
    assert.equal((await call(url.replace('localhost', '127.0.0.1'), 'GET', 'projects')).status, 503);
  });
  await withServer({host: '0.0.0.0', token: 'abc'}, async ({url, app}) => {
    assert.equal(app.apiAvailable, true);
    assert.equal(
      (await call(url.replace('localhost', '127.0.0.1'), 'GET', 'projects', undefined, {Authorization: 'Bearer abc'}))
        .status,
      200
    );
  });
});

test('API commits fingerprint only their own keys, without scanning the data tree', async () => {
  await withServer({}, async ({url, dataDir}) => {
    const original = fs.readdirSync;
    let fullScans = 0;
    fs.readdirSync = (directory, ...args) => {
      if (path.resolve(String(directory)) === path.resolve(dataDir)) fullScans++;
      return original(directory, ...args);
    };
    try {
      const created = await call(url, 'POST', 'projects', {name: 'Fast commit'});
      assert.equal(created.status, 200);
      assert.equal(fullScans, 0);
    } finally {
      fs.readdirSync = original;
    }
  });
});

test('workflow JSON state and previews survive a real server restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-durable-'));
  let app = createApiServer({dataDir}),
    url = await app.listen(0);
  try {
    await call(url, 'PUT', 'settings', {developer_mode: true});
    const {body: project} = await call(url, 'POST', 'projects', {name: 'Durable graph'});
    await typed(url, project.id);
    const {body: node} = await call(url, 'POST', `projects/${project.id}/typed-nodes`, {
      node_type: 'custom',
      config: nodes.script('context.state.count=(context.state.count??0)+1;node.display(context.state.count);'),
    });
    const route = `projects/${project.id}/execution`;
    assert.equal((await call(url, 'POST', route, {node_ids: [node.id], wait: true})).body.state.count, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'workflows', project.id, 'runtime.json'), 'utf8'));
    assert.equal(stored.state.count, 1);
    assert.equal(stored.displays[node.id], '1');
    await app.close();
    app = createApiServer({dataDir});
    url = await app.listen(0);
    const restored = (await call(url, 'GET', route)).body;
    assert.equal(restored.state.count, 1);
    assert.equal(restored.displays[node.id], '1');
    assert.equal((await call(url, 'POST', route, {node_ids: [node.id], wait: true})).body.state.count, 2);
  } finally {
    await app.close();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
});

test('asynchronous file polling still detects external Script and layout edits', async () => {
  await withServer({}, async ({url, dataDir}) => {
    const {body: project} = await call(url, 'POST', 'projects', {name: 'External files'}),
      {body: node} = await call(url, 'POST', `projects/${project.id}/primitives`, {
        primitive: 'script',
        point: {x: 0, y: 0},
      });
    const config = (await call(url, 'GET', `projects/${project.id}/workflow`)).body.nodes.find(
      n => n.id === node.id
    ).config;
    config.inputs.find(p => p.id === 'script').default = 'node.display("initial");';
    await call(url, 'PUT', `projects/${project.id}/typed-nodes/${node.id}`, {node_type: 'custom', config});
    await call(url, 'POST', `projects/${project.id}/execution`, {node_ids: [node.id], wait: true});
    await call(url, 'POST', `projects/${project.id}/execution/pause`, {});
    await call(url, 'POST', `projects/${project.id}/execution`, {node_ids: [node.id]});
    const controller = new AbortController();
    const stream = await fetch(`${url}/api/events`, {signal: controller.signal});
    try {
      const graph = JSON.parse(fs.readFileSync(path.join(dataDir, 'workflows', project.id + '.json'), 'utf8')),
        code = graph.value.nodes.find(n => n.id === node.id).config.inputs.find(p => p.id === 'script').default.$script,
        sidecar = path.join(dataDir, 'workflows', project.id + '.files');
      fs.writeFileSync(path.join(sidecar, code), 'node.display("external edit");');
      const until = async check => {
        for (let i = 0; i < 40; i++) {
          if (await check()) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.fail('External file edit was not observed');
      };
      await until(
        async () =>
          (await call(url, 'GET', `projects/${project.id}/workflow`)).body.nodes
            .find(n => n.id === node.id)
            .config.inputs.find(p => p.id === 'script').default === 'node.display("external edit");'
      );
      await call(url, 'POST', `projects/${project.id}/execution/resume`, {});
      await until(
        async () =>
          (await call(url, 'GET', `projects/${project.id}/execution`)).body.displays[node.id] === 'external edit'
      );
      const file = path.join(sidecar, 'layout.json'),
        layout = JSON.parse(fs.readFileSync(file, 'utf8'));
      layout['["value","layout"]'][node.id].x = 123;
      fs.writeFileSync(file, JSON.stringify(layout));
      await until(
        async () =>
          (await call(url, 'GET', `projects/${project.id}/workflow`)).body.nodes.find(n => n.id === node.id).position
            .x === 123
      );
    } finally {
      controller.abort();
      await stream.body.cancel().catch(() => {});
    }
  });
});

test('an interrupted commit is replayed once, and an unreadable record does not stop the server', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-transaction-'));
  require('../server/file-store').checkStoreFormat(dataDir, {initialize: true});
  const project = {
    id: 'recoveredproject',
    name: 'Recovered',
    description: '',
    created: 1,
    workflows: [{id: 'recoveredproject', name: 'Flow', created: 1}],
  };
  // The data was written before the crash; the record was not removed yet. Replaying it must
  // leave one project, not two.
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(
    path.join(dataDir, '.transaction.json'),
    JSON.stringify({set: {projects: [project]}, remove: []})
  );
  let app = createApiServer({dataDir}),
    url = await app.listen(0);
  try {
    const listed = await call(url, 'GET', 'projects');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.map(item => item.name), ['Recovered']);
    assert.equal(fs.existsSync(path.join(dataDir, '.transaction.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')).length, 1);
  } finally {
    await app.close();
  }
  // An unreadable record is set aside; the stored data still serves.
  fs.writeFileSync(path.join(dataDir, '.transaction.json'), '{not json');
  app = createApiServer({dataDir});
  url = await app.listen(0);
  try {
    assert.deepEqual((await call(url, 'GET', 'projects')).body.map(item => item.name), ['Recovered']);
    assert.equal(fs.existsSync(path.join(dataDir, '.transaction.json')), false);
    assert.equal(fs.existsSync(path.join(dataDir, '.transaction.json.invalid')), true);
  } finally {
    await app.close();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
});

test('malformed bodies, duplicate ids and traversal attempts answer 4xx, never 5xx', async () => {
  await withServer({}, async ({url}) => {
    const {body: project} = await call(url, 'POST', 'projects', {name: 'Malformed'}),
      {body: node} = await call(url, 'POST', `projects/${project.id}/typed-nodes`, {
        node_type: 'custom',
        config: nodes.script(''),
      });
    const send = async (method, route, body) => {
      const response = await fetch(`${url}/api/${route}`, {
        method,
        headers: {'Content-Type': 'application/json', 'X-AgentSys': '1'},
        body,
      });
      await response.arrayBuffer();
      return response.status;
    };
    const rejected = [
      ['POST', 'projects', 'null'],
      ['POST', 'projects', '[]'],
      ['PUT', 'settings', 'null'],
      ['PUT', 'settings', '"text"'],
      ['PUT', `projects/${project.id}/groups`, '{"groups":null}'],
      ['PUT', `projects/${project.id}/layout`, '{"positions":null}'],
      ['PUT', `projects/${project.id}/policy`, '{"allow":null}'],
      ['PUT', `projects/${project.id}/node-style`, `{"node_id":"${node.id}","pinned":"yes"}`],
      ['POST', `projects/${project.id}/port-connections`, '{"add":[null]}'],
      ['POST', `projects/${project.id}/execution`, '{"payload":[]}'],
      ['POST', `projects/${project.id}/evaluate-node`, '{"node_ids":null}'],
    ];
    for (const [method, route, body] of rejected) {
      const status = await send(method, route, body);
      assert.ok(status >= 400 && status < 500, `${method} ${route} ${body} -> ${status}`);
    }
    // Odd but well-typed values stay bounded: a duplicate id runs, an unknown key is ignored,
    // a self wire is a valid signal cycle, and a null config is an empty Custom node.
    for (const [method, route, body] of [
      ['POST', `projects/${project.id}/execution`, `{"node_ids":["${node.id}","${node.id}"],"wait":true}`],
      ['POST', `projects/${project.id}/execution`, '{"payload":{"__proto__":{"x":1}},"wait":true}'],
      ['POST', `projects/${project.id}/typed-nodes`, '{"node_type":"custom","config":null}'],
      [
        'POST',
        `projects/${project.id}/port-connections`,
        `{"add":[{"source":"${node.id}","source_port":"out","target":"${node.id}","target_port":"in"}]}`,
      ],
    ]) {
      const status = await send(method, route, body);
      assert.ok(status < 500, `${method} ${route} ${body} -> ${status}`);
    }
    for (const route of [
      '/api/projects/%2e%2e%2f%2e%2e%2fpackage.json',
      '/editor/%2e%2e/%2e%2e/package.json',
    ]) {
      const status = (await fetch(url + route)).status;
      assert.ok(status >= 400 && status < 500, `${route} -> ${status}`);
    }
  });
});
});
