'use strict';

// ---- builtin-nodes ----
// Built-in Library graphs share one shape; recipes retain each node’s ports, code and stable IDs.
const BUILTIN_NODES = (() => {
  const types = {
    "bool": {"color": "#d666c2", "control": "checkbox", "fields": [], "id": "d1714f2eec0f4bcfa0edc8602f7f67c2", "name": "bool"},
    "text": {"color": "#669ed6", "control": "textarea", "fields": [], "id": "64428b9c654c2c2cfcb55742ea899ed8", "name": "text"},
    "script": {"alias": "t:64428b9c654c2c2cfcb55742ea899ed8", "color": "#8a6fd6", "control": "code", "fields": [], "id": "a42dbde0c1e1090d6adf1640c2dda533", "name": "script"},
    "code": {"color": "#8a6fd6", "control": "code", "fields": [], "id": "c0de0c0de0c0de0c0de0c0de0c0de0c0", "name": "code"},
    "number": {"color": "#b3d666", "control": "number", "fields": [], "id": "fbe54fdd1dd24d55a0ec083cc057017e", "name": "number"},
    "delay mode": {"id": "c10c0000000000000000000000000001", "name": "delay mode", "color": "#669ed6", "fields": [], "control": "select", "options": ["duration", "until"]},
  };
  const port = (id, name, type, fields = {}) => ({
    id, name, ...(type ? {type: type === 'signal' ? type : 't:' + types[type].id} : {}), ...fields,
  });
  const make = spec => {
    const {name, id, project, record, code, inputs, outputs} = spec;
    const style = {color: null, folded: false, pinned: false,
      ...('disabled' in spec ? {disabled: spec.disabled} : {})};
    const bind = list => list.map(p => p.bound ? {...p, bound: [{node_id: record, port_id: p.bound}]} : p);
    return {name, payload: {
      description: spec.description || '', folder: spec.folder, icon: spec.icon, grants: [],
      frame: spec.frame || {dx: 0, dy: 0, width: 300, height: 200},
      bundle: {
        version: 1, source_project: project,
        types: spec.types.map(name => JSON.parse(JSON.stringify(types[name]))),
        groups: [{...style, id, name, parent: null, members: record ? [record] : [],
          ...(spec.groupPosition ? {position: spec.groupPosition} : {})}],
        complex: [{id, arbitrary: {inputs: !!spec.arbitraryInputs, outputs: false}, collapsed: false,
          compact_height: 90, compact_width: 240, interface: {inputs: bind(inputs), outputs: bind(outputs)}}],
        records: record ? [{id: record, payload: {
          kind: 'function', label: 'Custom', node_type: 'custom', status: 'ready',
          config: {title: 'Script', op: 'script', grants: [],
            inputs: [port('in', 'in', 'signal'), port('script', 'script', spec.scriptType || 'script', {default: code})],
            outputs: [port('out', 'out', 'signal')]},
        }}] : [],
        styles: record ? {[record]: {...style}} : {}, positions: record ? {[record]: spec.position} : {},
        port_edges: [], widgets: {},
      },
    }};
  };
  return [
    {
      name: "Bool", folder: "Value", icon: "toggle",
      id: "2ac8aee4af50fa3e29732a8b06b431ac", project: "lib-79f5e0f21efdddc5a3d6169a90346d81",
      types: ["bool"],
      disabled: false,
      groupPosition: {"height": null, "width": null, "x": 0, "y": 0},
      frame: {"dx": 0, "dy": 0, "height": null, "width": null},
      inputs: [
      ],
      outputs: [
        port("pvlo07", "bool", "bool", {"editable": true}),
      ],
    },
    {
      name: "Branch", folder: "Flow", icon: "branch",
      id: "027416c36566a4fb887a16416d80937b", project: "lib-2c6bf4d64f46b66183ab5e342d9e3913",
      types: ["text", "script", "bool"],
      disabled: false,
      frame: {"dx": -96, "dy": -72, "height": 200, "width": 300},
      record: "record:3da2ba5d8b7e66b3c67547738d4fe77d", position: {"height": 195, "width": 672, "x": -72, "y": 0},
      code: "node.input.condition ? await node.output.if_true.emit() : await node.output.if_false.emit();",
      inputs: [
        port("pfxrn1", "in", "signal", {"bound": "in"}),
        port("ple3wy", "condition", "bool"),
      ],
      outputs: [
        port("pci35c", "if_true", "signal"),
        port("p2qfw0", "if_false", "signal"),
      ],
    },
    {
      name: "Break", folder: "Flow", icon: "exit",
      id: "84d10ac58626a1482a8bd601e3b4614a", project: "lib-e4c38d6d45baf080943d323dd51a2ce8",
      types: ["text", "script"],
      description: "Ends the loop that is running this pass: what the pass has not started does not start, and the loop fires `done`. Put it in the body of For, For each or While.",
      record: "record:dacd35f6cdbff5863aadb46b38bcdd07", position: {"x": 0, "y": 24},
      code: "node.flow.break();",
      inputs: [
        port("in", "in", "signal", {"bound": "in"}),
      ],
      outputs: [
      ],
    },
    {
      name: "Continue", folder: "Flow", icon: "skip",
      id: "efa3c7a4794503e2382065611e596849", project: "lib-a0bfb8e59e6c13fc8d990781f77694fe",
      types: ["text", "script"],
      description: "Ends this pass of the loop that is running it, and the loop goes on with the next pass. A pass also ends where its signal path ends, so Continue is only needed to stop other branches of the pass.",
      record: "record:d1171f869734b48a87d77629138a0551", position: {"x": 0, "y": 24},
      code: "node.flow.continue();",
      inputs: [
        port("in", "in", "signal", {"bound": "in"}),
      ],
      outputs: [
      ],
    },
    {
      name: "Delay", folder: "Flow", icon: "timer",
      id: "022962b71c5b9c2f7f573123a6a52a89", project: "lib-6e60b1bfff574883aee79ea7ffb8bafa",
      types: ["code", "number", "text", "delay mode"],
      description: "Wait for a duration or until a date, then continue.",
      disabled: false,
      frame: {"dx": -128, "dy": -44, "height": 259, "width": 760},
      record: "record:e1dfb60c60cc68149d5e40a7fb4fccb2", position: {"height": 195, "width": 504, "x": 0, "y": 0},
      code: "const ms=node.input.mode===\"until\"?Date.parse(node.input.until)-Date.now():node.input.ms;if(!Number.isFinite(ms))throw Error(\"Invalid delay\");await node.sleep(Math.max(0,ms));node.output.result=null;",
      scriptType: "code",
      inputs: [
        port("in", "in", "signal", {"bound": "in"}),
        port("mode", "mode", "delay mode", {"default": "duration"}),
        port("ms", "ms", "number", {"default": 1000}),
        port("until", "until", "text", {"default": ""}),
      ],
      outputs: [
        port("Out", "out", "signal", {"bound": "out"}),
        port("result", "result"),
      ],
    },
    {
      name: "Execute", folder: "", icon: "code",
      id: "c81741a745addb87055af0679ee76667", project: "lib-e9dba9550082d44f158add0b64ac9e2c",
      types: ["text", "script"],
      disabled: false,
      frame: {"dx": -96, "dy": -72, "height": 200, "width": 300},
      arbitraryInputs: true,
      record: "record:3ff1df0edb71bd65638eaa07344ef711", position: {"height": 195, "width": 672, "x": 0, "y": 0},
      code: "const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;\nconst run = new AsyncFunction('node', 'agentsys', 'context', 'Date', 'Math', '\"use strict\";\\n' + (node.input.script ?? ''));\nnode.output.result = await run(node, agentsys, context, Date, Math);",
      inputs: [
        port("p7jbjn", "in", "signal", {"bound": "in"}),
        port("pr97li", "script", "script"),
      ],
      outputs: [
        port("pwf67a", "out", "signal", {"bound": "out"}),
        port("pxltyf", "result"),
      ],
    },
    {
      name: "For", folder: "Flow", icon: "loop",
      id: "69781ea1e4f79836ae0ade079fbc81c3", project: "lib-39e61d57e9209611edd4f884e9e47c11",
      types: ["text", "script", "number"],
      description: "Runs `body` once for each number from `from` (included) to `to` (not included), going up or down by `step`; the number is on `index`. `done` fires when the loop ends. A Break node ends it early, a Continue node ends only the pass.",
      record: "record:be809cdefebe7110a05cf031f27def6e", position: {"x": 0, "y": 24},
      code: "const {from, to, step} = node.input;\nif (![from, to, step].every(Number.isFinite)) throw new Error('For: from, to and step are numbers');\nif (step === 0) throw new Error('For: step cannot be 0');\nfor (let i = from; step > 0 ? i < to : i > to; i += step) {\n  node.output.index = i;\n  if ((await node.output.body.emit({handles: ['break', 'continue']})) === 'break') break;\n}\nawait node.output.done.emit();",
      inputs: [
        port("in", "in", "signal", {"bound": "in"}),
        port("from", "from", "number", {"default": 0}),
        port("to", "to", "number", {"default": 10}),
        port("step", "step", "number", {"default": 1}),
      ],
      outputs: [
        port("body", "body", "signal"),
        port("done", "done", "signal"),
        port("index", "index", "number"),
      ],
    },
    {
      name: "For each", folder: "Flow", icon: "list",
      id: "8754ee968c6c7c09d4af439dfd117760", project: "lib-dda37e341b7c8328b940c532d8072fd4",
      types: ["text", "script", "number"],
      description: "Runs `body` once for each element of `list`; the element is on `item` and its position on `index`. `done` fires when the loop ends. Break and Continue work as in For.",
      record: "record:5bec4c119eb4201aeb688bfd462efda8", position: {"x": 0, "y": 24},
      code: "const list = node.input.list;\nif (!Array.isArray(list)) throw new Error('For each: list is a list');\nfor (let i = 0; i < list.length; i++) {\n  node.output.item = list[i];\n  node.output.index = i;\n  if ((await node.output.body.emit({handles: ['break', 'continue']})) === 'break') break;\n}\nawait node.output.done.emit();",
      inputs: [
        port("in", "in", "signal", {"bound": "in"}),
        port("list", "list"),
      ],
      outputs: [
        port("body", "body", "signal"),
        port("done", "done", "signal"),
        port("item", "item"),
        port("index", "index", "number"),
      ],
    },
    {
      name: "Number", folder: "Value", icon: "hash",
      id: "239147f8e5a2ccf3510fb4d152545d20", project: "lib-55b3c977733d0e92815bf6e65c13da5b",
      types: ["number"],
      disabled: false,
      groupPosition: {"x": 0, "y": 0},
      frame: {"dx": 0, "dy": 0},
      inputs: [
      ],
      outputs: [
        port("pvlo07", "number", "number", {"default": 0, "editable": true}),
      ],
    },
    {
      name: "Preview", folder: "", icon: "eye",
      id: "14a414775198fc05c37e06a1a7ccec56", project: "lib-f44a209a1c8987a5026ad7b088f7c8f5",
      types: ["text", "script"],
      disabled: false,
      frame: {"dx": -168, "dy": 24},
      record: "record:6e4208dbb04e871621658a22ae312dca", position: {"x": 168, "y": -24},
      code: "node.display(node.input.input);",
      inputs: [
        port("pcgmyd", "in", "signal", {"bound": "in"}),
        port("pezeui", "input"),
      ],
      outputs: [
      ],
    },
    {
      name: "Text", folder: "Value", icon: "text",
      id: "109f77d82ec8c26f55391e4b4d8e7e56", project: "lib-7d2c9d1c4b699b03dde7324c5fcdfbc9",
      types: ["text"],
      disabled: false,
      groupPosition: {"x": 0, "y": 0},
      frame: {"dx": 0, "dy": 0},
      inputs: [
      ],
      outputs: [
        port("pvlo07", "text", "text", {"editable": true}),
      ],
    },
    {
      name: "Variable", folder: "Flow", icon: "database",
      id: "5a4f9a9ccfa5a86b24ce9d108984cf3c", project: "lib-47c14840d8e15331fa420b9b2f757cd9",
      types: ["text", "script"],
      description: "Holds a value: signal `set` stores `to` on `value`, then `done` fires. Reading `value` gives what was stored last (nothing before the first set).",
      record: "record:8da6cc3459d5d440c80fe7ad4ffbcc7d", position: {"x": 0, "y": 24},
      code: "node.output.value = node.input.to;\nawait node.output.done.emit();",
      inputs: [
        port("in", "set", "signal", {"bound": "in"}),
        port("to", "to"),
      ],
      outputs: [
        port("done", "done", "signal"),
        port("value", "value"),
      ],
    },
    {
      name: "While", folder: "Flow", icon: "refresh",
      id: "351fd5b4d746704acc28cea4aa764960", project: "lib-3cddbb8f43a4e074e2c2ce3e8622f43e",
      types: ["text", "script", "bool", "number"],
      description: "Runs body while condition is true, reading it again before every pass. done fires when the loop ends. Break and Continue control the loop.",
      record: "record:a87b17b08cac3cb378138c3bb5c0133d", position: {"x": 0, "y": 24},
      code: "while (await node.reread('condition')) {\n  if ((await node.output.body.emit({handles: ['break', 'continue']})) === 'break') break;\n}\nawait node.output.done.emit();",
      inputs: [
        port("in", "in", "signal", {"bound": "in"}),
        port("condition", "condition", "bool", {"default": false}),
      ],
      outputs: [
        port("body", "body", "signal"),
        port("done", "done", "signal"),
      ],
    },
  ].map(make);
})();

// ---- graph-nodes ----
// Ordinary Library graphs. Every operation goes through the same checked API as the canvas.
// The payload of a Library node that is one Script: `{name, inputs, outputs, grants, code, description, folder, icon}`.
// `inputs`/`outputs` are port names or {id, name, type?}. Used by the built-in Graph nodes and by plugins.
function scriptNodePayload({
  name,
  inputs = [],
  outputs = [],
  grants = [],
  code,
  description = '',
  folder = '',
  icon = 'code',
}) {
  const text = 't:64428b9c654c2c2cfcb55742ea899ed8',
    script = 't:a42dbde0c1e1090d6adf1640c2dda533',
    signal = id => ({id, name: id, type: 'signal'}),
    key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    group = 'script-' + key,
    id = 'record:' + group;
  return {
    folder,
    icon,
    description,
    grants,
    bundle: {
      version: 1,
      source_project: 'lib-builtin.' + key,
      types: [
        {id: text.slice(2), name: 'text', color: '#669ed6', fields: [], control: 'textarea'},
        {id: script.slice(2), name: 'script', color: '#8a6fd6', fields: [], control: 'code'},
      ],
      records: [
        {
          id,
          payload: {
            kind: 'function',
            node_type: 'custom',
            label: 'Custom',
            status: 'ready',
            config: {
              title: name,
              op: 'script',
              inputs: [signal('in'), {id: 'script', name: 'script', type: script, default: code}],
              outputs: [signal('out')],
            },
          },
        },
      ],
      groups: [{id: group, name, parent: null, members: [id]}],
      complex: [
        {
          id: group,
          collapsed: true,
          compact_width: 280,
          compact_height: 200,
          arbitrary: {inputs: false, outputs: false},
          interface: {
            inputs: [
              {...signal('in'), bound: [{node_id: id, port_id: 'in'}]},
              ...inputs.map(p => (typeof p === 'string' ? {id: p, name: p, type: text} : p)),
            ],
            outputs: [
              {...signal('out'), bound: [{node_id: id, port_id: 'out'}]},
              ...outputs.map(p => (typeof p === 'string' ? {id: p, name: p} : p)),
            ],
          },
        },
      ],
      port_edges: [],
      positions: {[id]: {x: 0, y: 0}},
      styles: {},
      widgets: {},
    },
  };
}
(() => {
  const text = 't:64428b9c654c2c2cfcb55742ea899ed8';
  function add(name, inputs, outputs, grants, body, description, folder = 'Graph') {
    BUILTIN_NODES.push({
      name,
      payload: scriptNodePayload({
        name,
        inputs,
        outputs,
        grants,
        description,
        folder,
        code: body.toString().slice(body.toString().indexOf('{') + 1, -1),
      }),
    });
  }
  add(
    'Add Node',
    ['resource_id', 'primitive', {id: 'point', name: 'point'}, {id: 'values', name: 'values'}, 'group_id'],
    ['node_id', 'result'],
    ['graph.read', 'graph.write'],
    async function () {
      node.output.node_id = undefined;
      node.output.result = undefined;
      if (Boolean(node.input.resource_id) === Boolean(node.input.primitive))
        throw Error('Choose a Library resource or a native primitive');
      const path = `projects/${context.project_id}`;
      const graph = await agentsys('GET', path + '/workflow');
      const group = node.input.group_id;
      // Without a point the node goes below everything placed so far, so generated nodes do not pile up on one spot.
      const taken = [...graph.nodes, ...graph.complex].map(n => n.position).filter(Boolean);
      const point = node.input.point ?? {x: 0, y: taken.length ? Math.max(...taken.map(q => q.y)) + 240 : 0};
      if (group && !graph.groups.some(g => g.id === group)) throw Error('Group not found');
      const made = node.input.resource_id
        ? await agentsys('POST', path + '/custom-nodes/' + encodeURIComponent(node.input.resource_id), {point})
        : await agentsys('POST', path + '/primitives', {primitive: node.input.primitive, point});
      const id =
        made.id ??
        (made.roots?.length === 1 ? 'complex:' + made.roots[0] : made.ids?.length === 1 ? made.ids[0] : null);
      if (!id) throw Error('Placement must create one node');
      node.output.node_id = id;
      node.output.result = {ok: false, node_id: id};
      // Each new instance has its own checked input defaults. Structured values use ordinary data wires.
      if (node.input.values) await agentsys('PUT', path + '/input-values', {node_id: id, values: node.input.values});
      if (group) {
        const current = await agentsys('GET', path + '/workflow');
        const groups = current.groups.map(({id, name, parent, members, position}) => ({
          id,
          name,
          parent,
          members,
          position,
        }));
        if (id.startsWith('complex:')) groups.find(g => g.id === id.slice(8)).parent = group;
        else groups.find(g => g.id === group).members.push(id);
        await agentsys('PUT', path + '/groups', {groups, if_cursor: current.cursor});
      }
      node.output.node_id = id;
      node.output.result = {ok: true, node_id: id};
    },
    'Place one existing Library node or native primitive; return its actual ID. Without a point it goes below everything placed so far. Inputs retain normal type checks.'
  );
  add(
    'Remove Node',
    ['node_id'],
    ['result'],
    ['graph.write'],
    async function () {
      const id = node.input.node_id;
      if (typeof id !== 'string' || !id) throw Error('Give a node ID');
      const result = id.startsWith('complex:')
        ? await agentsys('DELETE', `projects/${context.project_id}/groups/${encodeURIComponent(id.slice(8))}`)
        : await agentsys('POST', `projects/${context.project_id}/delete-nodes`, {node_ids: [id]});
      node.output.result = {ok: true, ...result};
    },
    'Delete a node through the checked canvas API.'
  );
  add(
    'Connect',
    ['source', 'source_port', 'target', 'target_port', {id: 'connections', name: 'connections'}],
    ['result'],
    ['graph.write'],
    async function () {
      try {
        const add = node.input.connections ?? [
          {
            source: node.input.source,
            source_port: node.input.source_port,
            target: node.input.target,
            target_port: node.input.target_port,
          },
        ];
        const result = await agentsys('POST', `projects/${context.project_id}/port-connections`, {add});
        node.output.result = {ok: true, ...result};
      } catch (error) {
        if (error.control || error.code === 'permission_denied' || error.code === 'execution_cancelled') throw error;
        node.output.result = {ok: false, error: {code: error.code ?? 'invalid_connection', message: error.message}};
      }
    },
    'Connect compatible ports; return {ok, error?}. Permissions and graph validation are unchanged.'
  );
  add(
    'Get Nodes',
    [],
    ['nodes', 'groups'],
    ['graph.read'],
    async function () {
      const graph = await agentsys('GET', `projects/${context.project_id}/workflow`);
      node.output.nodes = [...graph.nodes, ...graph.complex.map(c => ({...c, id: 'complex:' + c.id, kind: 'complex'}))];
      node.output.groups = graph.groups;
    },
    'Inspect current nodes, ports, groups and metadata through the canvas snapshot API.'
  );
  add(
    'Invoke Node',
    ['node_id', {id: 'input_port', name: 'input_port', type: text, default: 'in'}],
    ['outputs'],
    ['run.start'],
    async function () {
      const result = await agentsys('POST', `projects/${context.project_id}/execution`, {
        node_ids: [node.input.node_id],
        input_port: node.input.input_port,
        wait: true,
      });
      if (result.dispatch_status !== 'completed')
        throw Error(Object.values(result.errors ?? {})[0] ?? 'Invocation ' + result.dispatch_status);
      node.output.outputs = result.dispatch_outputs[node.input.node_id] ?? {};
    },
    'Signal one native input, await its signal wave and return this dispatch’s outputs. Use separate instances for concurrent calls.'
  );
  add(
    'Set Input',
    ['node_id', {id: 'values', name: 'values'}],
    ['result'],
    ['graph.write'],
    async function () {
      node.output.result = undefined;
      const values = node.input.values;
      if (typeof node.input.node_id !== 'string' || !node.input.node_id) throw Error('Give a node ID');
      if (!values || typeof values !== 'object' || Array.isArray(values))
        throw Error('values is an object of input values');
      await agentsys('PUT', `projects/${context.project_id}/input-values`, {node_id: node.input.node_id, values});
      node.output.result = {ok: true, node_id: node.input.node_id};
    },
    'Set the values of inputs of a placed node, by input name. Takes effect for the next invocation.'
  );
  add(
    'Find Library Node',
    ['name'],
    ['resource_id'],
    ['library.read'],
    async function () {
      node.output.resource_id = undefined;
      const items = await agentsys('GET', 'resources');
      const found = items.find(item => item.name === node.input.name);
      if (!found) throw Error('No Library node is named ' + node.input.name);
      node.output.resource_id = found.id;
    },
    'The ID of the Library node with this name, for Add Node.'
  );
  add(
    'Template',
    ['template', {id: 'data', name: 'data'}],
    [{id: 'value', name: 'value'}],
    [],
    async function () {
      const lookup = path =>
        path
          .trim()
          .split('.')
          .reduce(
            (value, key) => {
              if (
                ['__proto__', 'prototype', 'constructor'].includes(key) ||
                value == null ||
                !Object.hasOwn(Object(value), key)
              )
                throw Error('Missing template value: ' + path);
              return value[key];
            },
            {data: node.input.data}
          );
      const template = String(node.input.template ?? '{{data}}');
      const whole = template.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
      node.output.value = whole
        ? lookup(whole[1])
        : template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path) => {
            const value = lookup(path);
            return typeof value === 'string' ? value : JSON.stringify(value);
          });
    },
    'Fill {{data.path}} placeholders of a text with values of data. A text that is one placeholder gives the value itself.',
    'Data'
  );
  add(
    'Parse JSON',
    ['text', 'schema'],
    [{id: 'value', name: 'value'}],
    [],
    async function () {
      node.output.value = undefined;
      // Models often wrap JSON in one markdown code fence; accept exactly that and nothing else.
      const text = String(node.input.text ?? '')
        .trim()
        .replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i, '$1');
      const value = JSON.parse(text);
      if (node.input.schema) {
        const schema = JSON.parse(node.input.schema);
        const check = (value, rule, path) => {
          const supported = ['type', 'required', 'properties', 'items', 'enum', 'additionalProperties'];
          if (
            !rule ||
            typeof rule !== 'object' ||
            Array.isArray(rule) ||
            Object.keys(rule).some(k => !supported.includes(k))
          )
            throw Error('Unsupported schema at ' + path);
          const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
          if (rule.type && !(rule.type === 'integer' ? Number.isInteger(value) : rule.type === kind))
            throw Error(path + ': expected ' + rule.type);
          if (rule.enum && !rule.enum.some(item => JSON.stringify(item) === JSON.stringify(value)))
            throw Error(path + ': value is outside enum');
          if (kind === 'object') {
            for (const key of rule.required ?? [])
              if (!Object.hasOwn(value, key)) throw Error(path + ': missing ' + key);
            for (const [key, item] of Object.entries(value)) {
              if (rule.properties?.[key]) check(item, rule.properties[key], path + '.' + key);
              else if (rule.additionalProperties === false) throw Error(path + ': unexpected ' + key);
            }
          }
          if (kind === 'array' && rule.items) value.forEach((item, i) => check(item, rule.items, path + '[' + i + ']'));
        };
        check(value, schema, '$');
      }
      node.output.value = value;
    },
    'Read JSON from text, also when it is wrapped in a markdown code fence. With a schema (type, required, properties, items, enum, additionalProperties) it checks the shape and fails with the path of the mismatch.',
    'Data'
  );
  add(
    'Stringify JSON',
    [{id: 'value', name: 'value'}, 'indent'],
    ['text'],
    [],
    async function () {
      const indent = Number(node.input.indent) || 0;
      node.output.text = JSON.stringify(node.input.value ?? null, null, Math.min(Math.max(indent, 0), 8));
    },
    'Write a value as JSON text.',
    'Data'
  );
  add(
    'Get State',
    ['key'],
    [{id: 'value', name: 'value'}],
    [],
    async function () {
      const key = String(node.input.key ?? '');
      node.output.value = Object.hasOwn(context.state, key) ? context.state[key] : null;
    },
    'Read a key of the workflow\u2019s shared state (context.state). The state is kept across runs and restarts.',
    'Data'
  );
  add(
    'Set State',
    ['key', {id: 'value', name: 'value'}],
    [],
    [],
    async function () {
      const key = String(node.input.key ?? '');
      if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Give a state key');
      context.state[key] = node.input.value;
    },
    'Write a key of the workflow\u2019s shared state (context.state).',
    'Data'
  );
})();

// ---- routes-builtin ----
// The built-in Library: nodes that come with the app (builtin-nodes.js). They are ordinary Library nodes once added: a person can edit,
// move or delete them. A node is added only if the Library has no node of that name and the person has not deleted it before
// (`builtin` remembers which were added); "restore" adds the missing ones again. The editor asks for this at start.

const BUILTIN = 'builtin';
const builtinId = name =>
  'builtin.' +
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

route(
  'GET POST',
  'library/builtin',
  'List the built-in nodes, or add the ones the Library lacks',
  async c => {
    const items = await c.ctx.get('resources', []),
      state = await c.ctx.get(BUILTIN, {added: []}),
      added = new Set(state.added),
      restore = c.method === 'POST' && c.body.restore === true,
      made = [];
    if (c.method === 'GET')
      return BUILTIN_NODES.map(n => ({
        name: n.name,
        folder: n.payload.folder || '',
        installed: items.some(r => r.name === n.name),
      }));
    for (const node of BUILTIN_NODES) {
      const id = builtinId(node.name);
      if (items.some(r => r.name === node.name)) {
        added.add(id);
        continue;
      }
      if (added.has(id) && !restore) continue; // the person deleted it
      saveResource(c, items, null, node.name, clone(node.payload), id);
      added.add(id);
      made.push(node.name);
    }
    state.added = [...added].sort();
    c.ctx.set(BUILTIN, state);
    return {added: made, total: BUILTIN_NODES.length};
  },
  {body: {restore: false}}
);
