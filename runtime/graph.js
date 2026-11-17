'use strict';

// ---- graph ----
// Read-only graph snapshot operations shared by the client and the server.
// No mutation editor, snapshot construction, interpreter or browser dependencies.

// Shared snapshot/import contracts: event names and an empty durable document.
const EVENT_OPS = new Set(['on_run', 'on_read', 'on_placed', 'on_deleted', 'on_input_connected', 'on_widget']);
const emptyDoc = () => ({
  cursor: 0,
  nodes: [],
  layout: {},
  style: {},
  groups: [],
  complex: [],
  port_edges: [],
  widgets: {},
  types: [],
  library_nodes: [],
});

/**
 * Follows Complex Node ports down to the node ports they are bound to: [[node ID, port ID], ...].
 * One unbound port stays on the wrapper; only an input may be bound to several ports. The editor
 * wraps its errors as ApiError; the interpreter uses the messages as they are. The Worker source
 * carries this function (runtime/backend.js), so it must not use anything outside its arguments.
 */
function resolvePort(nodes, nodeId, portId, direction, seen = new Set()) {
  const address = nodeId + '|' + portId;
  if (seen.has(address)) throw Error('Cyclic interface binding');
  const node = nodes.get(nodeId);
  if (!node) throw Error('Node not found: ' + nodeId);
  if (node.kind !== 'complex') return [[nodeId, portId]];
  const item = node.interface[direction].find(p => p.id === portId);
  if (!item) throw Error('Complex Node port not found: ' + portId);
  return item.bound?.length
    ? item.bound.flatMap(b => resolvePort(nodes, b.node_id, b.port_id, direction, new Set(seen).add(address)))
    : [[nodeId, portId]];
}

const Graph = {
  nodeMap(snapshot) {
    return new Map(
      [
        ...snapshot.nodes,
        ...snapshot.groups.map(g => ({...g, id: 'group:' + g.id, kind: 'group', inputs: [], outputs: []})),
        ...snapshot.complex.map(c => ({...c, id: 'complex:' + c.id, kind: 'complex'})),
      ].map(n => [n.id, n])
    );
  },
  /** Follows Complex Node ports down to the node ports they are bound to: [[node ID, port ID], ...] (an unbound port stays on the wrapper; only an input is bound to several). */
  resolveAll(nodes, nodeId, portId, direction, seen = new Set()) {
    try {
      return resolvePort(nodes, nodeId, portId, direction, seen);
    } catch (error) {
      // Graph edits report invalid bindings as bad requests; the resolver itself is shared with the interpreter.
      throw bad(error.message);
    }
  },
  /** The first port a Complex Node port is bound to (the only one of an output). */
  resolve(nodes, nodeId, portId, direction) {
    return Graph.resolveAll(nodes, nodeId, portId, direction)[0];
  },
};

/** True when `group` sits somewhere below the group `ancestor`. */
function isInside(byId, group, ancestor) {
  const seen = new Set();
  for (let g = byId.get(group.parent); g; g = byId.get(g.parent)) {
    if (seen.has(g.id)) throw bad('Groups cannot contain cycles');
    seen.add(g.id);
    if (g.id === ancestor) return true;
  }
  return false;
}

const IMAGE_DISPLAY = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
const DISPLAY_PARTS = '\u001e';

// ---- schema ----
// Node definitions and the rules about a node's configuration. A port is {id, name, type?}: the type, if it has one, is only used to decide what may be wired to what.
// Pure functions: nothing here touches a document or the browser.

/**
 * What a Custom node does besides holding values (`config.op`): the operations the engine knows. A node without one only holds the
 * values typed into its outputs. `script` runs JavaScript when a signal reaches it; the `on_*` nodes are the sources of signals
 *. Nothing else is built into the engine.
 */
const OPS = new Set(['script', 'on_run', 'on_read', 'on_placed', 'on_deleted', 'on_input_connected', 'on_widget']);
/** The types of a Script's code (text typed in as code): the same IDs in every workflow and Library node, so they are one type everywhere. */
const SCRIPT_TEXT_TYPE = '64428b9c654c2c2cfcb55742ea899ed8',
  SCRIPT_CODE_TYPE = 'a42dbde0c1e1090d6adf1640c2dda533';
/** The error prefix of a Script. */
const SCRIPT_PREFIX = 'Node code';
const CUSTOM_CONFIG_LIMIT = 400000;
const MAX_PORTS = 256; // per direction
/** The format of a clipboard / Custom Node bundle (see Editor.copy). Another version is not read. */
const BUNDLE_VERSION = 1;
const CUSTOM_KEYS = new Set(['title', 'inputs', 'outputs', 'op', 'widgets', 'grants']);
const COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// ----- Widgets: the controls and displays code puts on a Custom node -----
const WIDGET_KINDS = new Set([
  'text',
  'textarea',
  'number',
  'checkbox',
  'select',
  'range',
  'button',
  'label',
  'html',
  'markdown',
]);
/** Widgets that hold a value the person can change (a button's value counts its clicks; the script of an html widget may post one). */
const HAS_VALUE = new Set(['text', 'textarea', 'number', 'checkbox', 'select', 'range', 'button', 'html', 'markdown']);
const WIDGET_KEYS = new Set([
  'id',
  'kind',
  'label',
  'value',
  'options',
  'min',
  'max',
  'step',
  'placeholder',
  'rows',
  'text',
  'html',
  'height',
]);
const WIDGET_VALUE_LIMIT = 1000000;
const MAX_WIDGETS = 100; // per node
const optionValue = o => (isObject(o) ? o.value : o);
/** What a widget holds before anyone set it. */
function widgetDefault(w) {
  switch (w.kind) {
    case 'number':
    case 'range':
      return w.min ?? 0;
    case 'checkbox':
      return false;
    case 'button':
      return 0;
    case 'select':
      return w.options?.length ? optionValue(w.options[0]) : null;
    default:
      return '';
  }
}
/** The widgets of a node: [{id, kind, label?, value?, options?, min?, max?, step?, placeholder?, rows?, text?, html?, height?}]. */
function checkWidgets(list) {
  if (!Array.isArray(list) || list.length > MAX_WIDGETS) throw bad(`A node has at most ${MAX_WIDGETS} widgets`);
  const ids = new Set();
  for (const w of list) {
    if (!isObject(w) || Object.keys(w).some(k => !WIDGET_KEYS.has(k)))
      throw bad('A widget has an id, a kind and the fields of its kind');
    if (typeof w.id !== 'string' || !w.id || w.id.length > 80 || ids.has(w.id))
      throw bad('Give each widget a unique ID');
    ids.add(w.id);
    if (!WIDGET_KINDS.has(w.kind)) throw bad(`Unknown widget kind “${w.kind}” (use ${[...WIDGET_KINDS].join(', ')})`);
    if ('label' in w && (typeof w.label !== 'string' || w.label.length > 500))
      throw bad('A widget label is text of at most 500 characters');
    for (const k of ['min', 'max', 'step', 'rows', 'height'])
      if (k in w && !(typeof w[k] === 'number' && Number.isFinite(w[k]))) throw bad(`Widget ${k} is a number`);
    for (const k of ['placeholder', 'text', 'html'])
      if (k in w && typeof w[k] !== 'string') throw bad(`Widget ${k} is text`);
    if ('options' in w && (!Array.isArray(w.options) || w.options.length > 500))
      throw bad('Widget options are a list of at most 500');
    if ('value' in w && JSON.stringify(w.value ?? null).length > WIDGET_VALUE_LIMIT)
      throw bad('The widget value is too large');
  }
  if (JSON.stringify(list).length > 4 * WIDGET_VALUE_LIMIT) throw bad('The widgets are too large');
}

const DEFINITIONS = {
  // A Custom node: its ports are listed in its configuration, what it does is `op` (none: it holds values).
  custom: {
    label: 'Custom',
    category: 'Custom',
    inputs: [],
    outputs: [],
    defaults: {
      title: '',
      inputs: [],
      outputs: [{id: 'result', name: 'result'}],
    },
  },
  // A point on a wire: passes its input on. Made by splitting a connection; not offered in menus.
  reroute: {
    label: 'Reroute',
    category: 'Hidden',
    inputs: [{id: 'in', name: 'in'}],
    outputs: [{id: 'out', name: 'out'}],
    defaults: {},
  },
};

const key = (node, port) => node + '|' + port;

/** The ports inside a group that a slot of its interface is bound to: [{node_id, port_id}], at least one, no port twice. */
const validBound = list =>
  Array.isArray(list) &&
  list.length > 0 &&
  list.length <= MAX_PORTS &&
  list.every(
    b => isObject(b) && Object.keys(b).length === 2 && typeof b.node_id === 'string' && typeof b.port_id === 'string'
  ) &&
  new Set(list.map(b => b.node_id + '|' + b.port_id)).size === list.length;

/** Signal ports come first, in their own order; data ports follow. */
const signalsFirst = ports => {
  const signals = [],
    data = [];
  for (const p of ports) (p.type === 'signal' ? signals : data).push(p);
  return signals.concat(data);
};
/** Checks a list of ports. Signal ports are moved to the front; names keep their declared spelling. */
function checkPorts(items, {custom = false, types = NO_TYPES} = {}) {
  if (!Array.isArray(items) || items.length > MAX_PORTS || items.some(item => !isObject(item)))
    throw bad(`Use at most ${MAX_PORTS} ports per direction`);
  items.splice(0, items.length, ...signalsFirst(items));
  const ids = new Set(),
    names = new Set(),
    allowed = new Set(['id', 'name', 'type', 'bound', 'extra', 'default', 'editable']);
  for (const item of items) {
    if (
      !isObject(item) ||
      Object.keys(item).some(k => !allowed.has(k)) ||
      typeof item.id !== 'string' ||
      !item.id.length ||
      item.id.length > 80 ||
      ids.has(item.id) ||
      names.has(item.name) ||
      typeof item.name !== 'string' ||
      item.name.length > 200 ||
      ('type' in item && (typeof item.type !== 'string' || !item.type || !types.shape(item.type))) ||
      ('extra' in item && typeof item.extra !== 'boolean') ||
      ('editable' in item && typeof item.editable !== 'boolean') ||
      ('bound' in item && !validBound(item.bound))
    )
      throw bad('Give each port a unique ID and a name (a type, if it has one, must be a type of the workflow)');
    if ('default' in item) {
      const control = types.control(item.type);
      if (!control || !fitsControl(item.default, control))
        throw bad(`The default of “${item.name}” must be a value its type can hold (a type with a control)`);
    }
    // `editable` (outputs): the node shows the control of the type, and what is typed there is the value of the output (`default`).
    if (item.editable && !types.control(item.type))
      throw bad(`“${item.name}” can show a control only if its type has one`);
    if (custom && /[:|]/.test(item.id)) throw bad('A port ID cannot contain “:” or “|”');
    ids.add(item.id);
    names.add(item.name);
  }
  if (JSON.stringify(items).length > 100000) throw bad('Port configuration is too large');
}
function ensureAcyclic(adjacency) {
  const degrees = new Map();
  for (const [node, targets] of adjacency) {
    if (!degrees.has(node)) degrees.set(node, 0);
    for (const t of targets) degrees.set(t, (degrees.get(t) || 0) + 1);
  }
  const ready = [...degrees].filter(([, d]) => !d).map(([n]) => n);
  let count = 0;
  while (ready.length) {
    count++;
    for (const target of adjacency.get(ready.pop()) || []) {
      degrees.set(target, degrees.get(target) - 1);
      if (degrees.get(target) === 0) ready.push(target);
    }
  }
  if (count !== degrees.size) throw bad('Connection creates a cycle');
}

/** The configuration of a Custom node: only the known fields, an operation the engine knows (or none), valid ports. */
function validateCustomConfig(config, types = NO_TYPES) {
  if (typeof checkManifest === 'function') checkManifest(config);
  const unknown = Object.keys(config).find(k => !CUSTOM_KEYS.has(k));
  if (unknown) throw bad(`Unknown Custom node field “${unknown}”`);
  if (typeof config.title !== 'string' || config.title.length > 200)
    throw bad('The title is text of at most 200 characters');
  if ('op' in config && !OPS.has(config.op)) throw bad(`Unknown operation “${config.op}” (use ${[...OPS].join(', ')})`);
  checkPorts(config.inputs, {custom: true, types});
  checkPorts(config.outputs, {custom: true, types});
  // A Script has nothing to configure but its code: it reads the inputs and writes the outputs of the Library node it is in.
  if (config.op === 'script') {
    const [start, code] = config.inputs;
    if (
      config.inputs.length !== 2 ||
      start.id !== 'in' ||
      start.type !== 'signal' ||
      code.id !== 'script' ||
      code.type === 'signal' ||
      config.outputs.length !== 1 ||
      config.outputs[0].id !== 'out' ||
      config.outputs[0].name !== 'out' ||
      config.outputs[0].type !== 'signal'
    )
      throw bad('A Script has signal input in, code input script and signal output out');
  }
  if (config.widgets !== undefined) checkWidgets(config.widgets);
  if (JSON.stringify(config).length > CUSTOM_CONFIG_LIMIT) throw bad('Node configuration is too large');
}

/** The values of a node's widgets by widget ID. */
const widgetValues = list => Object.fromEntries((list || []).map(w => [w.id, w.value]));

/** True when the node does something when a signal reaches it (a Script) or fires one (an event node); the others are read, not run. */
const isRunning = node =>
  node.node_type === 'custom' && (node.config?.op === 'script' || EVENT_OPS.has(node.config?.op));
/** A node that takes no part in a run: disabled itself, or inside a group that is. */
const isOff = node => !!(node.disabled || node.muted);
/** The nodes a Run fires: the on_run nodes that are on. */
const isRunStart = node => node.node_type === 'custom' && node.config?.op === 'on_run' && !isOff(node);

function schema(node) {
  if (node.node_type === 'custom') {
    const config = node.config || {};
    return {inputs: (config.inputs || []).map(p => ({...p})), outputs: (config.outputs || []).map(p => ({...p}))};
  }
  if (Object.hasOwn(DEFINITIONS, node.node_type)) return DEFINITIONS[node.node_type];
  if (node.kind === 'complex') return {inputs: node.interface?.inputs || [], outputs: node.interface?.outputs || []};
  return {inputs: [], outputs: []};
}

// ---- types ----
// User-defined types. A type is told by its ID. The types a workflow can use are the Library's (the types its Custom Nodes define, kept once, the same
// everywhere) and its own (`doc.types`, only in this workflow). While a workflow is open the two are one list, a Library type marked `library`.
// The built-in types are `any` and `signal`; there is no `text` or `number` until somebody defines one.
//
// A port's `type` is optional. Without one the port is of type `any`, which fits everything. Otherwise it is a type expression:
//   any           the built-in type: anything (the same as no type)
//   signal        the built-in type of a signal: it carries no data and fits only another signal
//   t:<id>        a type: a name, a color and named fields (it may have none: then it is just a named kind)
// A type may be an alias of another (`alias: 't:<id>'`, no fields of its own): it means exactly what the other type means, so the two
// are interchangeable on wires, and it only brings its own name, color and control (Script is Text typed in as code).
// Compatibility is structural for types with fields: a type fits another when it has every field of the other (and the field
// types fit), so two types with the same fields are interchangeable. A type with no fields is a named kind: it fits itself and the
// ports of type any.
// Types only decide what may be wired to what. The engine never looks at them, and values are not checked while a graph runs.

const TYPE_REF = /^t:([0-9a-f]{32})$/;
const TYPE_REFS = /t:([0-9a-f]{32})/g;
const MAX_TYPES = 256,
  MAX_FIELDS = 32,
  MAX_TYPE_DEFS_SIZE = 400000;
const ANY = Object.freeze({kind: 'any'});
const SIGNAL = Object.freeze({kind: 'signal'});
/** Whether a type expression is the built-in signal type. */
const isSignal = type => type === 'signal';
/** How a type is typed in on a free slot: a small field of its kind. `select` is an enum: one of the type's `options`. */
const CONTROLS = ['text', 'textarea', 'code', 'number', 'checkbox', 'select'];
const MAX_OPTIONS = 64,
  MAX_OPTION = 80,
  MAX_TEXT = 10000;
/** The part of a type definition that says how it is typed in (what mergeTypes and syncType carry along with the fields). */
const controlOf = t => ({
  ...(t.control ? {control: t.control} : {}),
  ...(t.options ? {options: [...t.options]} : {}),
  ...(t.alias ? {alias: t.alias} : {}),
});
/** The type IDs a definition is made of: those of its fields and the one it is an alias of. */
const refsOf = t => [...t.fields.flatMap(f => typeRefs(f.type)), ...typeRefs(t.alias)];
/** Whether `value` is something the control of a type can hold. */
function fitsControl(value, {control, options}) {
  if (control === 'text' || control === 'textarea' || control === 'code')
    return typeof value === 'string' && value.length <= MAX_TEXT;
  if (control === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (control === 'checkbox') return typeof value === 'boolean';
  if (control === 'select') return typeof value === 'string' && (options || []).includes(value);
  return false;
}

/** The types of one document, resolved on demand: `shape(expression)` is what a type expression means (null when it means nothing). */
class TypeTable {
  constructor(list) {
    this.defs = new Map((list || []).map(t => [t.id, t]));
    this.known = new Map();
  }
  /** `{kind: 'any'}` or `{kind: 'type', name, fields: [{name, type: shape}]}`. */
  shape(expression, stack = []) {
    if (expression == null || expression === 'any') return ANY;
    if (expression === 'signal') return SIGNAL;
    if (typeof expression !== 'string') return null;
    const cached = this.known.get(expression);
    if (cached) return cached;
    let shape = null;
    const id = TYPE_REF.exec(expression)?.[1],
      def = id && this.defs.get(id);
    // A type that contains itself (however deep) means nothing: the stack finds the loop.
    if (def?.alias && !stack.includes(id)) {
      shape = this.shape(def.alias, [...stack, id]); // an alias is what it stands for
    } else if (def && !stack.includes(id)) {
      const fields = [];
      for (const field of def.fields || []) {
        const type = this.shape(field.type, [...stack, id]);
        if (!type) break;
        fields.push({name: field.name, type});
      }
      if (fields.length === (def.fields || []).length) shape = {kind: 'type', name: def.name, fields};
    }
    if (shape) this.known.set(expression, shape);
    return shape;
  }
  /** How the type is typed in on a slot: `{control, options?}`, or null (any, an unknown type, or a type without a control). */
  control(expression, depth = 0) {
    const id = typeof expression === 'string' && TYPE_REF.exec(expression)?.[1],
      def = id && this.defs.get(id);
    if (def?.control) return {control: def.control, ...(def.options ? {options: def.options} : {})};
    // An alias without a control of its own is typed in like the type it stands for.
    return def?.alias && depth < MAX_TYPES ? this.control(def.alias, depth + 1) : null;
  }
  /** What a person reads: `Person`, `any`; an unknown type shows as “unknown type”. */
  label(expression) {
    if (typeof expression !== 'string') return 'any';
    return expression.replace(TYPE_REFS, (_, id) => this.defs.get(id)?.name ?? 'unknown type');
  }
}
const NO_TYPES = new TypeTable([]);

/** Whether a value of the shape `from` can go where `to` is expected. */
function shapeFits(from, to) {
  if (from.kind === 'signal' || to.kind === 'signal') return from.kind === to.kind;
  if (from.kind === 'any' || to.kind === 'any') return true;
  if (!to.fields.length) return from.name === to.name;
  return to.fields.every(f => from.fields.some(g => g.name === f.name && shapeFits(g.type, f.type)));
}
/** Whether a type expression means `any` (no type, or `any` itself). */
const isAny = type => type == null || type === 'any';
/** Whether an output of type `a` may be wired to an input of type `b` (each a type expression, or none: `any`). */
function compatible(a, b, types = NO_TYPES) {
  if (isSignal(a) || isSignal(b)) return isSignal(a) && isSignal(b); // a signal is not data: it does not fit any, and any does not fit it
  if (a === b || isAny(a) || isAny(b)) return true;
  const from = types.shape(a),
    to = types.shape(b);
  return !!from && !!to && shapeFits(from, to);
}

/** A type of the Library as the type of a workflow: the same definition, marked `library`. */
const libraryType = t => ({...clone(t), library: true});
/** What the Library keeps of a type: its definition without the mark. */
const plainType = ({library, ...t}) => clone(t);
/** The types a workflow stores: its own, not the Library's. */
const ownTypes = list => (list || []).filter(t => !t.library);

/**
 * The types a workflow works with: the Library's and its own. A type of its own that means the same as a Library type (same name, same
 * fields and control) is that type, and one that a Library type shadows (same ID) or that has the name of another type is given
 * another name. Answers {types, absorbed: {dropped type ID -> Library type ID} for the caller to rename the ports with, changed}.
 */
function unifyTypes(library, own) {
  const out = library.map(t => ({...t, library: true})),
    absorbed = new Map(),
    libIds = new Set(library.map(t => t.id));
  let rest = ownTypes(own).map(t => ({...t})),
    changed = false;
  const shape = (t, map) =>
    JSON.stringify([
      (t.fields || []).map(f => ({name: f.name, type: renameTypeRefs(f.type, map)})),
      controlOf({...t, alias: t.alias && renameTypeRefs(t.alias, map)}),
    ]);
  for (let more = true; more; ) {
    more = false;
    for (const x of rest) {
      const twin = library.find(
        y => y.name.toLowerCase() === x.name.toLowerCase() && shape(y, new Map()) === shape(x, absorbed)
      );
      if (!twin && !libIds.has(x.id)) continue;
      if (twin) absorbed.set(x.id, twin.id);
      rest = rest.filter(y => y !== x);
      changed = more = true;
      break;
    }
  }
  const taken = new Set(out.map(t => t.name.toLowerCase()));
  for (const t of rest) {
    let name = t.name;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${t.name.slice(0, 50)} (${n})`;
    if (name !== t.name) changed = true;
    taken.add(name.toLowerCase());
    t.name = name;
  }
  return {types: [...out, ...rest], absorbed, changed};
}

/** The ids of the document types a type expression mentions. */
const typeRefs = expression => [...String(expression ?? '').matchAll(TYPE_REFS)].map(m => m[1]);
/** The expression with the document types it mentions replaced as `map` (old id -> new id) says. */
const renameTypeRefs = (expression, map) =>
  String(expression ?? '').replace(TYPE_REFS, (whole, id) => (map.has(id) ? 't:' + map.get(id) : whole));

/** Checks a list of type definitions: unique ids and names, fields with known types, no type that contains itself. */
function checkTypes(list) {
  if (!Array.isArray(list) || list.length > MAX_TYPES) throw bad(`Use at most ${MAX_TYPES} types`);
  const ids = new Set(),
    names = new Set();
  for (const t of list) {
    if (
      !isObject(t) ||
      Object.keys(t).some(
        k => !['id', 'name', 'color', 'fields', 'library', 'control', 'options', 'alias'].includes(k)
      ) ||
      typeof t.id !== 'string' ||
      !/^[0-9a-f]{32}$/.test(t.id) ||
      ids.has(t.id) ||
      typeof t.name !== 'string' ||
      !t.name.trim() ||
      t.name.length > 60 ||
      t.name !== t.name.trim() ||
      names.has(t.name.toLowerCase()) ||
      (t.color != null && !(typeof t.color === 'string' && COLOR.test(t.color))) ||
      ('library' in t && t.library !== true)
    )
      throw bad('Give each type a unique ID and a unique name of 1 to 60 characters');
    if ('alias' in t && !(typeof t.alias === 'string' && TYPE_REF.test(t.alias)))
      throw bad(`The alias of ${t.name} is another type of the document`);
    if (t.alias && (t.fields || []).length) throw bad(`${t.name} is an alias: it has no fields of its own`);
    if ('control' in t && !CONTROLS.includes(t.control))
      throw bad(`The control of ${t.name} is one of ${CONTROLS.join(', ')}`);
    if (t.control && (t.fields || []).length)
      throw bad(`${t.name} has fields: only a type without fields can have a control`);
    if (t.control === 'select') {
      if (!Array.isArray(t.options) || !t.options.length || t.options.length > MAX_OPTIONS)
        throw bad(`${t.name} needs 1 to ${MAX_OPTIONS} options`);
      if (t.options.some((o, i) => typeof o !== 'string' || !o || o.length > MAX_OPTION || t.options.indexOf(o) !== i))
        throw bad(`The options of ${t.name} are different texts of 1 to ${MAX_OPTION} characters`);
    } else if ('options' in t) throw bad('Only a type with the select control has options');
    ids.add(t.id);
    names.add(t.name.toLowerCase());
    if (!Array.isArray(t.fields) || t.fields.length > MAX_FIELDS)
      throw bad(`A type has at most ${MAX_FIELDS} fields: ${t.name}`);
    const fields = new Set();
    for (const f of t.fields) {
      if (
        !isObject(f) ||
        Object.keys(f).some(k => !['name', 'type'].includes(k)) ||
        typeof f.name !== 'string' ||
        !f.name.trim() ||
        f.name.length > 60 ||
        fields.has(f.name) ||
        typeof f.type !== 'string'
      )
        throw bad(`Give each field of ${t.name} a unique name and a type (any for anything)`);
      fields.add(f.name);
    }
  }
  if (JSON.stringify(list).length > MAX_TYPE_DEFS_SIZE) throw bad('The types are too large');
  const table = new TypeTable(list);
  for (const t of list)
    if (!table.shape('t:' + t.id)) throw bad(`The type ${t.name} is made of an unknown type, or contains itself`);
}

// ---- snapshot ----
// Turns a stored workflow document into the "snapshot" the canvas draws: nodes with their ports, wires,
// groups, Complex Nodes and a list of problems (diagnostics). Read-only: it never changes the document.

/** Attach port lists to nodes and Complex Nodes and return the canvas edge list. */
function annotate(nodes, groups, complexes, stored, schemaOf) {
  const all = new Map(nodes.map(n => [n.id, n]));
  for (const group of groups) all.set('group:' + group.id, {id: 'group:' + group.id, kind: 'group', name: group.name});
  for (const cx of complexes) all.set('complex:' + cx.id, {...cx, id: 'complex:' + cx.id, kind: 'complex'});
  const complexById = new Map(complexes.map(cx => ['complex:' + cx.id, cx]));
  const edges = [];
  for (const e of stored)
    if (all.has(e.source) && all.has(e.target)) edges.push({...e, id: 'port:' + e.id, kind: 'data'});
  const binding = (nid, pid, direction) => {
    const node = all.get(nid);
    return node?.kind === 'complex' ? node.interface[direction].find(p => p.id === pid) : undefined;
  };
  const occupied = {inputs: new Set(), outputs: new Set()};
  for (const edge of edges)
    for (const [direction, side] of [
      ['inputs', 'target'],
      ['outputs', 'source'],
    ]) {
      occupied[direction].add(key(edge[side], edge[side + '_port']));
      if (!complexById.has(edge[side])) continue;
      for (const b of binding(edge[side], edge[side + '_port'], direction)?.bound ?? [])
        occupied[direction].add(key(b.node_id, b.port_id));
    }
  // Inner Complex Nodes first, so a wire on a bound port marks every wrapper above it as connected.
  for (const cx of [...complexes].sort((a, b) => b.depth - a.depth))
    for (const direction of ['inputs', 'outputs'])
      for (const p of cx.interface[direction])
        if ((p.bound ?? []).some(b => occupied[direction].has(key(b.node_id, b.port_id))))
          occupied[direction].add(key('complex:' + cx.id, p.id));
  const exposed = new Set(
    complexes.flatMap(c => c.interface.inputs.flatMap(p => (p.bound ?? []).map(b => key(b.node_id, b.port_id))))
  );
  for (const node of all.values()) {
    const spec = schemaOf(node),
      inputs = signalsFirst(spec.inputs.map(p => ({...p})));
    node.inputs = inputs;
    node.outputs = signalsFirst(spec.outputs.map(p => ({...p})));
    // A slot fed by a wire, or exposed on a group's interface (its value then comes from outside), is connected.
    for (const p of inputs) p.connected = occupied.inputs.has(key(node.id, p.id)) || exposed.has(key(node.id, p.id));
    for (const p of node.outputs) p.connected = occupied.outputs.has(key(node.id, p.id));
    if (node.kind === 'complex') {
      const cx = complexById.get(node.id);
      Object.assign(cx, {inputs, outputs: node.outputs});
    }
  }
  typeReroutes(all, edges);
  return edges;
}

/** A Reroute passes values through, so it takes the type of what feeds it (or, unfed, of what it feeds). */
function typeReroutes(nodes, edges) {
  let reroutes = false;
  for (const node of nodes.values())
    if (node.node_type === 'reroute') {
      reroutes = true;
      break;
    }
  if (!reroutes) return;
  const portType = (nodeId, portId, direction) =>
    nodes.get(nodeId)?.[direction]?.find(p => p.id === portId)?.type || '';
  // The wires of each node, in the order they are stored (the first one with a known type decides).
  const feeding = new Map(),
    fed = new Map();
  for (const e of edges) {
    if (!feeding.has(e.target)) feeding.set(e.target, []);
    feeding.get(e.target).push(e);
    if (!fed.has(e.source)) fed.set(e.source, []);
    fed.get(e.source).push(e);
  }
  const typeOf = (id, seen) => {
    if (seen.has(id)) return '';
    seen.add(id);
    const through = (nodeId, portId, direction) =>
      nodes.get(nodeId).node_type === 'reroute' ? typeOf(nodeId, seen) : portType(nodeId, portId, direction);
    for (const e of feeding.get(id) || []) {
      const type = through(e.source, e.source_port, 'outputs');
      if (!isAny(type)) return type;
    }
    for (const e of fed.get(id) || []) {
      const type = through(e.target, e.target_port, 'inputs');
      if (!isAny(type)) return type;
    }
    return '';
  };
  const types = new Map();
  for (const node of nodes.values()) if (node.node_type === 'reroute') types.set(node.id, typeOf(node.id, new Set()));
  for (const [id, type] of types) {
    const node = nodes.get(id);
    for (const p of [...node.inputs, ...node.outputs]) if (type) p.type = type;
  }
}

/** What is wrong with one port `b` ({node_id, port_id}) that the interface port `p` is bound to (none: a fitting port inside the group). */
function bindingFault(cx, nodes, b, p, direction, types) {
  const member = nodes.get(b.node_id),
    bound = (member?.[direction] || []).find(item => item.id === b.port_id);
  if (!bound || !cx.members.includes(member.id)) return 'Complex Node binding is not a port inside its group: ';
  return (direction === 'inputs' ? compatible(p.type, bound.type, types) : compatible(bound.type, p.type, types))
    ? ''
    : 'Complex Node binding types do not match: ';
}
/** What is wrong with what an interface port is bound to (none: it is unbound, or bound to fitting ports inside the group; only an input may have several). */
function bindingProblem(cx, nodes, p, direction, types) {
  const list = p.bound ?? [];
  if (direction === 'outputs' && list.length > 1) return 'Complex Node binding of an output takes one port inside: ';
  for (const b of list) {
    const fault = bindingFault(cx, nodes, b, p, direction, types);
    if (fault) return fault;
  }
  return '';
}

function diagnostics(snapshot, schemaOf = schema) {
  const nodes = new Map(snapshot.nodes.map(n => [n.id, n]));
  for (const c of snapshot.complex) nodes.set('complex:' + c.id, {...c, id: 'complex:' + c.id, kind: 'complex'});
  const types = new TypeTable(snapshot.types);
  const issues = [];
  const report = (message, node_id, port_id = null, direction = null, edge_id = null) =>
    issues.push({message, node_id, port_id, direction, edge_id});
  for (const [nid, node] of nodes) {
    if (node.refresh_error) report(node.refresh_error, nid);
    if (node.node_type === 'custom') {
      const declared = node.config?.inputs || [],
        names = declared.map(p => p.name);
      for (const p of declared)
        if (names.filter(n => n === p.name).length > 1)
          report('Custom node input names must be unique', nid, p.id, 'inputs');
      const outputs = (node.config?.outputs || []).map(p => p.name);
      for (const p of node.config?.outputs || [])
        if (outputs.filter(n => n === p.name).length > 1)
          report('Custom node output names must be unique', nid, p.id, 'outputs');
    }
    for (const direction of ['inputs', 'outputs'])
      for (const p of schemaOf(node)[direction]) {
        if (!p.name.trim()) report('Name this slot', nid, p.id, direction);
        if (!types.shape(p.type)) report('Unknown type of ' + p.name, nid, p.id, direction);
        const problem = node.kind === 'complex' && bindingProblem(node, nodes, p, direction, types);
        if (problem) report(problem + p.name, nid, p.id, direction);
      }
  }
  /** The ports a wire end lands on once Complex Nodes are looked through (an input bound to several ports lands on all of them). */
  const endpoints = (nid, pid, direction, seen = new Set()) => {
    const address = nid + '|' + pid;
    if (seen.has(address)) throw bad('Cyclic interface binding');
    const list = (nodes.get(nid)?.interface?.[direction] || []).find(p => p.id === pid)?.bound ?? [];
    return list.length
      ? list.flatMap(b => endpoints(b.node_id, b.port_id, direction, new Set(seen).add(address)))
      : [[nid, pid]];
  };
  const adjacency = new Map(),
    occupied = new Map(),
    resolved = [];
  for (const edge of snapshot.edges) {
    const source = nodes.get(edge.source),
      target = nodes.get(edge.target);
    const output = source?.outputs?.find(p => p.id === edge.source_port),
      input = target?.inputs?.find(p => p.id === edge.target_port);
    if (!output || !input || !compatible(output.type, input.type, types))
      report('A saved connection has incompatible ports', edge.target, edge.target_port, 'inputs', edge.id);
    // A signal is not a dependency: a signal input takes any number of wires, and signals may go in circles.
    if (isSignal(output?.type)) continue;
    const a = endpoints(edge.source, edge.source_port, 'outputs')[0][0];
    for (const b of endpoints(edge.target, edge.target_port, 'inputs')) {
      const bk = key(...b);
      if (occupied.has(bk))
        for (const item of [occupied.get(bk), edge])
          report('Each input accepts only one connection', item.target, item.target_port, 'inputs', item.id);
      occupied.set(bk, edge);
      if (!adjacency.has(a)) adjacency.set(a, []);
      adjacency.get(a).push(b[0]);
      resolved.push([a, b[0], edge]);
    }
  }
  // Iterative strongly connected components (Kosaraju) avoid recursion limits on large graphs.
  const reverse = new Map(),
    order = [],
    seen = new Set();
  for (const [a, targets] of adjacency)
    for (const b of targets) {
      if (!reverse.has(b)) reverse.set(b, []);
      reverse.get(b).push(a);
    }
  for (const root of adjacency.keys()) {
    const stack = [[root, false]];
    while (stack.length) {
      const [nid, finished] = stack.pop();
      if (finished) order.push(nid);
      else if (!seen.has(nid)) {
        seen.add(nid);
        stack.push([nid, true]);
        for (const t of adjacency.get(nid) || []) stack.push([t, false]);
      }
    }
  }
  const components = new Map(),
    assigned = new Set();
  for (const root of order.reverse()) {
    if (assigned.has(root)) continue;
    const component = new Set(),
      stack = [root];
    while (stack.length) {
      const nid = stack.pop();
      if (assigned.has(nid)) continue;
      assigned.add(nid);
      component.add(nid);
      stack.push(...(reverse.get(nid) || []));
    }
    for (const nid of component) components.set(nid, component);
  }
  for (const [a, b, edge] of resolved)
    if (components.get(a)?.has(b) && (a === b || components.get(a).size > 1))
      report('Graph contains a cycle', edge.target, edge.target_port, 'inputs', edge.id);
  return issues.sort(
    (x, y) =>
      Number(!x.message.startsWith('Complex Node binding')) - Number(!y.message.startsWith('Complex Node binding'))
  );
}

/** Fills in children, depth and the nodes of every group, including those of the groups inside it. */
function groupTree(groups) {
  const byId = new Map(groups.map(g => [g.id, g])),
    children = new Map();
  for (const g of groups) {
    const list = children.get(g.parent) ?? [];
    list.push(g.id);
    children.set(g.parent, list);
  }
  for (const g of groups) g.children = children.get(g.id) ?? [];
  const visit = (g, trail = new Set()) => {
    if (g.all_members) return g;
    trail.add(g.id);
    g.depth = g.parent && byId.has(g.parent) && !trail.has(g.parent) ? visit(byId.get(g.parent), trail).depth + 1 : 0;
    g.all_members = [...g.members];
    return g;
  };
  for (const g of groups) visit(g);
  for (const g of [...groups].sort((a, b) => b.depth - a.depth)) {
    const parent = byId.get(g.parent);
    if (parent) parent.all_members.push(...g.all_members);
  }
  return groups;
}

/** `structure`: only the nodes, groups and Complex Nodes, with no ports, wires or diagnostics (cheap; enough where only what exists, where it sits or how it is styled matters). */
function buildSnapshot(project, workflow, doc, structure = false) {
  // Shallow copies: the document of a request is its own, and nothing edits a node's config in place.
  const nodes = doc.nodes.map(n => ({...n}));
  for (const node of nodes) {
    if (doc.layout[node.id]) node.position = {...doc.layout[node.id]};
    const style = doc.style[node.id] || {};
    node.pinned = !!style.pinned;
    node.folded = !!style.folded;
    node.disabled = !!style.disabled;
    node.color = style.color ?? null;
  }
  const ids = new Set(nodes.map(n => n.id));
  const groups = doc.groups.map(g => ({
    ...g,
    members: g.members.filter(id => ids.has(id)),
    parent: g.parent ?? null,
  }));
  for (const group of groups) {
    const k = 'group:' + group.id,
      style = doc.style[k] || {};
    if (doc.layout[k]) group.position = {...doc.layout[k]};
    group.pinned = !!style.pinned;
    group.folded = !!style.folded;
    group.disabled = !!style.disabled;
    group.color = style.color ?? null;
  }
  groupTree(groups);
  // A group that is disabled switches off everything inside it: `muted` marks what is off only because of a group around it.
  const mutedNodes = new Set(groups.filter(g => g.disabled).flatMap(g => g.all_members));
  for (const node of nodes) node.muted = mutedNodes.has(node.id);
  const groupById = new Map(groups.map(g => [g.id, g]));
  for (const group of groups) {
    group.muted = false;
    const ancestors = new Set();
    for (let up = groupById.get(group.parent); up; up = groupById.get(up.parent)) {
      if (ancestors.has(up.id)) throw bad('Groups cannot contain cycles');
      ancestors.add(up.id);
      if (up.disabled) group.muted = true;
    }
  }
  const byId = new Map(groups.map(g => [g.id, g]));
  const wrapped = new Set(doc.complex.map(c => c.id).filter(id => byId.has(id)));
  // The Complex Nodes nested in each one, in group order: one walk up the parents instead of a
  // scan of every group for every Complex Node.
  const innerOf = new Map();
  for (const g of groups)
    if (wrapped.has(g.id)) {
      const trail = new Set();
      for (let up = byId.get(g.parent); up && !trail.has(up.id); up = byId.get(up.parent)) {
        trail.add(up.id);
        if (!wrapped.has(up.id)) continue;
        const list = innerOf.get(up.id) ?? [];
        list.push('complex:' + g.id);
        innerOf.set(up.id, list);
      }
    }
  const complexes = doc.complex
    .filter(c => byId.has(c.id))
    .map(c => {
      const g = byId.get(c.id),
        inner = innerOf.get(g.id) ?? [];
      // Linked Library instances keep their definition ownership. Inline compositions
      // belong to this workflow and can be opened and edited with the existing controls.
      const locked = !!c.source;
      return {
        id: c.id,
        group_id: c.id,
        name: g.name,
        depth: g.depth,
        color: g.color,
        pinned: g.pinned,
        folded: g.folded,
        disabled: g.disabled,
        muted: g.muted,
        position: doc.layout['complex:' + c.id],
        locked,
        source: c.source ?? null,
        grants: c.source && c.grants ? [...c.grants] : null,
        ...(c.refresh_error ? {refresh_error: c.refresh_error} : {}),
        // The nodes inside that have widgets: a node placed from the Library shows them on itself.
        widget_nodes: c.source ? g.all_members.filter(id => doc.widgets?.[id]?.length) : [],
        arbitrary: {inputs: !!c.arbitrary?.inputs, outputs: !!c.arbitrary?.outputs},
        interface: {inputs: [], outputs: [], ...clone(c.interface)},
        collapsed: locked || !!c.collapsed,
        compact_width: c.compact_width ?? 240,
        compact_height: c.compact_height ?? 90,
        members: [...g.all_members, ...inner],
      };
    });
  for (const g of groups) g.has_complex = wrapped.has(g.id);
  const types = doc.types ?? [];
  // schema() copies port lists: ask once per node, for ports and diagnostics alike.
  const schemas = new Map();
  const schemaOf = node => {
    let found = schemas.get(node.id);
    if (!found) {
      found = schema(node);
      schemas.set(node.id, found);
    }
    return found;
  };
  const edges = structure ? [] : annotate(nodes, groups, complexes, doc.port_edges, schemaOf);
  const snapshot = {
    project_id: project.id,
    workflow_id: workflow.id,
    workflow_name: workflow.name,
    cursor: doc.cursor,
    nodes,
    edges,
    groups: groups.filter(g => g.members.length || g.children.length || g.position),
    complex: complexes,
    widgets: clone(doc.widgets ?? {}),
    types: clone(types),
    library_nodes: clone(doc.library_nodes ?? []),
    root: doc.root ?? null,
  };
  snapshot.diagnostics = structure ? [] : diagnostics(snapshot, schemaOf);
  return snapshot;
}

// ---- documents ----
// The stored shape of a workflow document, and copying one with fresh ids.
//
// A document holds: nodes (function nodes: Custom and Reroute), layout, style, groups, complex, port_edges, widgets
// (the widgets code put on nodes: {node ID: [{id, kind, label, value, ...}]}), types (see model/types.js),
// and library_nodes (the Library resource IDs included in this workflow's Add menu; empty by default).
// A group is only a visual frame around nodes (and other groups). A Complex Node wraps one group: it adds ports
// bound to ports inside the group and is shown as one node. README.md describes the server architecture.

const stateOf = doc => ({
  nodes: doc.nodes,
  layout: doc.layout,
  style: doc.style,
  groups: doc.groups,
  complex: doc.complex,
  port_edges: doc.port_edges,
  widgets: doc.widgets,
  types: doc.types ?? [],
  library_nodes: doc.library_nodes ?? [],
});

/** What the interpreter can observe of a document: everything but where nodes sit and how they are coloured, pinned or folded. */
const semanticKey = state =>
  JSON.stringify([
    state.nodes,
    state.groups,
    state.complex,
    state.port_edges,
    state.widgets,
    state.types ?? [],
    state.library_nodes ?? [],
    Object.entries(state.style ?? {})
      .filter(([, style]) => style?.disabled)
      .map(([id]) => id)
      .sort(),
  ]);

/** Copies a workflow document with fresh IDs (used for duplicated workflows and projects). */
function duplicateDocument(doc, mapped = () => {}) {
  const map = new Map();
  const fresh = () => 'record:' + uid();
  for (const n of doc.nodes) map.set(n.id, fresh());
  const groupMap = new Map(doc.groups.map(g => [g.id, uid()]));
  for (const [old, neu] of groupMap) {
    map.set('group:' + old, 'group:' + neu);
    map.set('complex:' + old, 'complex:' + neu);
  }
  const m = id => map.get(id) ?? id;
  const copy = emptyDoc();
  copy.types = clone(doc.types ?? []);
  copy.library_nodes = clone(doc.library_nodes ?? []);
  copy.nodes = doc.nodes.map(n => ({...clone(n), id: m(n.id)}));
  copy.layout = Object.fromEntries(
    Object.entries(doc.layout)
      .filter(([k]) => map.has(k))
      .map(([k, v]) => [m(k), clone(v)])
  );
  copy.style = Object.fromEntries(
    Object.entries(doc.style)
      .filter(([k]) => map.has(k))
      .map(([k, v]) => [m(k), clone(v)])
  );
  copy.groups = doc.groups.map(g => ({
    ...clone(g),
    id: groupMap.get(g.id),
    members: g.members.filter(i => map.has(i)).map(m),
    parent: g.parent ? (groupMap.get(g.parent) ?? null) : null,
  }));
  copy.complex = doc.complex
    .filter(c => groupMap.has(c.id))
    .map(c => {
      const iface = clone(c.interface || {inputs: [], outputs: []});
      for (const p of [...(iface.inputs || []), ...(iface.outputs || [])])
        if (p.bound) p.bound = p.bound.map(b => ({...b, node_id: m(b.node_id)}));
      return {...clone(c), id: groupMap.get(c.id), interface: iface};
    });
  copy.port_edges = doc.port_edges
    .filter(e => map.has(e.source) && map.has(e.target))
    .map(e => ({...e, id: uid(), source: m(e.source), target: m(e.target)}));
  for (const [nid, list] of Object.entries(doc.widgets)) if (map.has(nid)) copy.widgets[m(nid)] = clone(list);
  mapped(map);
  return copy;
}
