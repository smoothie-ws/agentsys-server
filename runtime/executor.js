'use strict';

// ---- evaluate ----
// The current graph is indexed for port lookup. Nodes are interpreted on demand; the graph stays live.
function createGraphView(document, {context = {}} = {}) {
  const key = (node, port) => node + '|' + port;
  const isSignal = type => type === 'signal',
    isOff = node => !!(node?.disabled || node?.muted);
  const EVENT_OPS = new Set(['on_run', 'on_read', 'on_placed', 'on_deleted', 'on_input_connected', 'on_widget']);
  const isRunning = node =>
    node.node_type === 'custom' && (node.config?.op === 'script' || EVENT_OPS.has(node.config?.op));
  const SCRIPT_PREFIX = 'Node code';
  const widgetValues = list => Object.fromEntries((list ?? []).map(w => [w.id, w.value]));
  const Editor = {
    nodeMap: s =>
      new Map(
        [...s.nodes, ...s.complex.map(c => ({...c, id: 'complex:' + c.id, kind: 'complex'}))].map(n => [n.id, n])
      ),
    resolveAll: (nodes, id, port, direction, seen = new Set()) => resolvePort(nodes, id, port, direction, seen),
    resolve: (nodes, id, port, direction) => resolvePort(nodes, id, port, direction)[0],
  };
  class TypeTable {
    constructor(list) {
      this.list = list;
    }
    control(ref, seen = new Set()) {
      if (!ref || seen.has(ref)) return null;
      seen.add(ref);
      const item = this.list.find(t => 't:' + t.id === ref);
      return item?.control ? item : item?.alias ? this.control(item.alias, seen) : null;
    }
  }

  const evalLabel = node =>
    (node.node_type === 'custom' && node.config?.title) || node.label || node.name || node.node_type;

  /** The first problem of every node: the document's diagnostics, then those a Complex Node passes on to its members. */
  function firstIssues(document) {
    const issues = new Map();
    for (const {node_id, message} of document.diagnostics) if (!issues.has(node_id)) issues.set(node_id, message);
    for (const cx of document.complex) {
      const own = 'complex:' + cx.id;
      if (issues.has(own))
        for (const member of cx.members) if (!issues.has(member)) issues.set(member, issues.get(own));
    }
    return issues;
  }

  /**
   * Where every input gets its value from. Wires are followed through Complex Nodes, so a wrapper costs nothing at run time:
   *  incoming    target key -> [node, port] the wire starts at (the outermost Complex Node port that publishes it)
   *  fallback    target key -> the default of an input nothing is wired to (the outermost one that has a default wins)
   */
  function wireGraph(document, nodes) {
    const incoming = new Map(),
      fallback = new Map(),
      signals = []; // [{source, target}]: a signal wire, from the output the wire starts at to the input it ends at
    for (const node of nodes.values())
      if (node.node_type === 'custom')
        for (const p of node.inputs || []) if ('default' in p) fallback.set(key(node.id, p.id), p.default);
    for (const cx of [...document.complex].sort((a, b) => b.depth - a.depth))
      for (const p of cx.interface.inputs)
        if ('default' in p) {
          try {
            for (const target of Editor.resolveAll(nodes, 'complex:' + cx.id, p.id, 'inputs'))
              fallback.set(key(...target), p.default);
          } catch {}
        }
    // Complex Nodes, inner ones first. A wire is looked up in them by the port it is bound to, so each wire only meets
    // the wrappers that publish it, not all of them.
    const wrappers = [...document.complex]
      .sort((a, b) => b.depth - a.depth)
      .map(cx => {
        const bound = ports => {
          const byTarget = new Map();
          for (const p of ports) {
            const b = p.bound?.[0];
            if (b && !byTarget.has(key(b.node_id, b.port_id))) byTarget.set(key(b.node_id, b.port_id), p);
          }
          return byTarget;
        };
        return {
          id: 'complex:' + cx.id,
          members: new Set(cx.members),
          outputs: bound(cx.interface.outputs),
        };
      });
    /** Port key -> the wrappers (by position) that publish the port on their interface, as `outputs` or `inputs`. */
    const publishing = side => {
      const index = new Map();
      wrappers.forEach((wrapper, i) => {
        for (const k of wrapper[side].keys()) {
          if (!index.has(k)) index.set(k, []);
          index.get(k).push(i);
        }
      });
      return index;
    };
    const outputsAt = publishing('outputs');
    /** The first wrapper at or after position `from` that publishes the output `source` without containing `inside`. */
    const publisher = (source, from, inside) =>
      outputsAt.get(key(...source))?.find(i => i >= from && !wrappers[i].members.has(inside));
    for (const edge of document.edges) {
      let targets;
      try {
        targets = Editor.resolveAll(nodes, edge.target, edge.target_port, 'inputs');
        Editor.resolve(nodes, edge.source, edge.source_port, 'outputs');
      } catch {
        continue;
      }
      // An input bound to several ports inside a group feeds all of them.
      for (const target of targets) {
        const targetKey = key(...target);
        // Where the wire starts: each wrapper, inner to outer, that publishes it as an output and lacks the target.
        let source = [edge.source, edge.source_port];
        for (let i = publisher(source, 0, target[0]); i !== undefined; i = publisher(source, i + 1, target[0]))
          source = [wrappers[i].id, wrappers[i].outputs.get(key(...source)).id];
        if (isSignal(nodes.get(target[0])?.inputs?.find(p => p.id === target[1])?.type)) signals.push({source, target});
        else incoming.set(targetKey, source);
      }
    }
    return {incoming, fallback, signals};
  }

  /**
   * Where each Custom node lives: the placed Library node (a group copy) that is the closest around it. That copy is the node's unit
   * (its scope). Event nodes belong to their unit and a Script runs in its scope (`context`).
   * Answers node ID -> {group: the group ID of the copy, instance_id: 'complex:<group>', widgets: the IDs of the nodes with widgets in it, inputs: its free inputs}.
   */
  function instanceScopes(document) {
    const scopes = new Map();
    const composites = [...document.complex].sort((a, b) => b.depth - a.depth);
    // One pass over the groups: the closest copy around each node, its data interface, and the
    // placed nodes that grant it permissions (deepest first, as before).
    const closest = new Map(),
      placedAround = new Map(),
      shared = new Map();
    for (const c of composites) {
      shared.set(c.id, {
        group: c.id,
        instance_id: 'complex:' + c.id,
        widgets: c.members.filter(m => !m.startsWith('complex:') && document.widgets?.[m]?.length),
        // What a Script of the copy reads: every data input of the node. What it writes: the data outputs no node inside feeds. What it fires
        // with emit(name): the signal outputs no node inside feeds.
        inputs: c.interface.inputs.filter(p => !isSignal(p.type)),
        outputs: c.interface.outputs.filter(p => !isSignal(p.type) && !p.bound?.length),
        signals: c.interface.outputs.filter(p => isSignal(p.type) && !p.bound?.length),
      });
      for (const member of c.members) {
        if (!closest.has(member)) closest.set(member, c.id);
        if (c.source) {
          const placed = placedAround.get(member) ?? [];
          placed.push(c);
          placedAround.set(member, placed);
        }
      }
    }
    for (const node of document.nodes) {
      const group = closest.get(node.id);
      if (!group) continue;
      const placed = placedAround.get(node.id) ?? [];
      scopes.set(node.id, {
        ...shared.get(group),
        resource_id: placed[0]?.source.resource_id ?? null,
        // The permissions of every placed node around it, the closest first: it can do only what all of them allow.
        grant_chain: placed.map(cx => cx.grants ?? []),
      });
    }
    return scopes;
  }

  /** The current description of a Custom node: what it is (`op`), its data inputs (and the signal ones), its outputs and where its signals go. */
  function describeCustom(
    node,
    inputs,
    {context, scope = null, outputs = null, scopeSignals = {}, targets = {}, event = null}
  ) {
    const config = node.config || {},
      op = config.op ?? null;
    return {
      id: node.id,
      label: evalLabel(node),
      kind: 'custom',
      op,
      running: isRunning(node),
      prefix: SCRIPT_PREFIX,
      inputs,
      scope,
      signals: {
        ...scopeSignals,
        ...Object.fromEntries(
          (config.outputs ?? []).filter(p => isSignal(p.type)).map(p => [p.name, targets[p.id] ?? []])
        ),
      },
      outputs: [
        ...(outputs ?? (config.outputs || [])),
        ...(config.op === 'script' ? (config.outputs ?? []).filter(p => isSignal(p.type)) : []),
      ].map(p => ({
        id: p.id,
        name: p.name,
        ...(isSignal(p.type) ? {signal: true} : {}),
      })),
      // What was typed into the controls of outputs (see `editable`): the node starts with it as its output.
      preset: Object.fromEntries((config.outputs || []).filter(p => 'default' in p).map(p => [p.name, p.default])),
      targets,
      event,
      context,
      grants: config.grants ?? [],
    };
  }

  const nodes = Editor.nodeMap(document),
    {incoming, fallback, signals} = wireGraph(document, nodes),
    issues = firstIssues(document),
    widgets = document.widgets ?? {},
    scopes = instanceScopes(document),
    // The Library node copies that have a Script: their free data outputs are written by it, and kept as the results of the copy.
    scripted = new Set(
      document.nodes
        .filter(n => n.node_type === 'custom' && n.config?.op === 'script' && scopes.has(n.id))
        .map(n => scopes.get(n.id).instance_id)
    ),
    types = new TypeTable(document.types);
  /** Where the value of the output `source` ([node, port]) comes from once Complex Nodes are looked through. */
  const refOf = source => {
    let [nid, port] = source;
    for (;;) {
      const node = nodes.get(nid);
      if (isOff(node)) return {off: true}; // a node that is disabled gives nothing
      if (issues.has(nid)) return {err: issues.get(nid)};
      if (node.kind !== 'complex') return {n: nid, p: port};
      const [inside, inner] = Editor.resolve(nodes, nid, port, 'outputs');
      if (inside === nid) {
        if (scripted.has(nid)) return {n: nid, p: port}; // written by a Script of the copy
        // An output of the Complex Node itself that nothing inside feeds: if it is `editable`, what is typed there is its value.
        const item = node.interface.outputs.find(p => p.id === port);
        if (!item?.editable) return null;
        if ('default' in item) return {value: item.default};
        const control = types.control(item.type)?.control;
        return control === 'checkbox'
          ? {value: false}
          : ['text', 'textarea', 'code'].includes(control)
            ? {value: ''}
            : null;
      }
      [nid, port] = [inside, inner];
    }
  };
  // Where the signal of each output goes: the nodes (a Reroute passes it on) that are on and have no problem.
  const fires = new Map();
  for (const {source, target} of signals) {
    const from = refOf(source),
      to = nodes.get(target[0]);
    if (!to || isOff(to) || issues.has(to.id)) continue;
    // A signal output of a Library node copy that nothing inside feeds is fired by a Script of the copy (emit): it is keyed as itself.
    const free =
      !from?.n &&
      nodes.get(source[0])?.kind === 'complex' &&
      !nodes.get(source[0]).interface.outputs.find(p => p.id === source[1])?.bound?.length;
    if (!from?.n && !free) continue;
    const k = free ? key(source[0], source[1]) : key(from.n, from.p);
    if (!fires.has(k)) fires.set(k, []);
    if (!fires.get(k).includes(to.id)) fires.get(k).push(to.id);
  }
  const reach = (list, seen = new Set()) =>
    list.flatMap(id => {
      if (nodes.get(id)?.node_type !== 'reroute') return [id];
      if (seen.has(id)) return [];
      seen.add(id);
      return reach(fires.get(key(id, 'out')) ?? [], seen);
    });
  const targetsOf = node => {
    const out = {};
    for (const p of node.config?.outputs || [])
      if (isSignal(p.type)) out[p.id] = [...new Set(reach(fires.get(key(node.id, p.id)) ?? []))];
    return out;
  };
  // The on_read nodes of each Library node copy: a node of the copy that is needed brings them (and what their signals reach) along.
  const readers = new Map();
  for (const n of nodes.values())
    if (n.node_type === 'custom' && n.config?.op === 'on_read' && !isOff(n) && !issues.has(n.id) && scopes.has(n.id)) {
      const k = scopes.get(n.id).instance_id;
      readers.set(k, [...(readers.get(k) ?? []), n.id]);
    }
  const describe = nid => {
    const node = nodes.get(nid);
    if (!node || isOff(node)) return null;
    if (issues.has(nid)) return {id: nid, error: issues.get(nid)};
    const custom = node.node_type === 'custom';
    const entry = (owner, p) => {
      if (isSignal(p.type)) return {id: p.id, name: p.name, signal: true};
      const wire = incoming.get(key(owner, p.id)),
        found = wire ? refOf(wire) : null,
        off = !!found?.off,
        literal = !!found && 'value' in found;
      if (literal) return {id: p.id, name: p.name, ref: null, has: true, fallback: found.value};
      const ref = off ? null : found;

      // A wire from a node that is switched off counts as no wire: the default of the input applies.
      const has = (!wire || off) && fallback.has(key(owner, p.id));
      return {id: p.id, name: p.name, ref, has, ...(has ? {fallback: fallback.get(key(owner, p.id))} : {})};
    };
    // A Library node copy that a Script writes to: it keeps what the Scripts put in its free outputs (a running node of its own).
    if (node.kind === 'complex') {
      // Reading the copy brings its on_read nodes (and what their signals reach) along.

      const free = (
        scopes.get(nid)?.outputs ?? node.interface.outputs.filter(p => !isSignal(p.type) && !p.bound?.length)
      ).map(p => ({id: p.id, name: p.name, ...('default' in p ? {default: p.default} : {})}));
      return {
        id: nid,
        label: evalLabel(node),
        kind: 'custom',
        op: 'scope',
        running: true,
        prefix: SCRIPT_PREFIX,
        inputs: [],
        outputs: free.map(({id, name}) => ({id, name})),
        preset: Object.fromEntries(free.filter(p => 'default' in p).map(p => [p.name, p.default])),
        targets: {},
        event: null,
        context: {...context, node_id: nid, instance_id: nid, widgets: {}},
      };
    }
    const inputs = (node.inputs || []).map(p => ({
      ...entry(nid, p),
      ...(custom && node.config?.op === 'script' && p.id === 'script' ? {code: true} : {}),
    }));
    if (custom) {
      const targets = targetsOf(node);

      const scope = scopes.get(nid);

      const script = node.config?.op === 'script';
      // A Script reads every data input of the Library node it is in (the value that arrives there), whatever it is bound to inside.
      if (script)
        for (const p of scope?.inputs ?? []) {
          let target = [scope.instance_id, p.id];
          try {
            target = Editor.resolve(nodes, scope.instance_id, p.id, 'inputs');
          } catch {}
          inputs.push({...entry(target[0], {...p, id: target[1]}), id: 'wrapper:' + p.id, wrapper: true});
        }
      const scopeSignals = Object.fromEntries(
        (scope?.signals ?? []).map(p => [p.name, [...new Set(reach(fires.get(key(scope.instance_id, p.id)) ?? []))]])
      );

      return describeCustom(node, inputs, {
        scope: script ? (scope?.instance_id ?? null) : null,
        outputs: script ? (scope?.outputs ?? []) : null,
        scopeSignals,
        targets,
        event: EVENT_OPS.has(node.config?.op) ? {} : null,
        context: {
          ...context,
          node_id: nid,
          instance_id: scope?.instance_id ?? null,
          resource_id: scope?.resource_id ?? null,
          grant_chain: scope?.grant_chain ?? null,
          // The widgets of the Library node (its nodes' together), or the node's own if it is not part of one.
          widgets: Object.assign(
            {},
            ...(scope ? scope.widgets : []).map(id => widgetValues(widgets[id])),
            widgetValues(widgets[nid])
          ),
        },
      });
    }
    const kind = node.node_type === 'reroute' ? 'reroute' : 'plain';
    return {id: nid, label: evalLabel(node), kind, inputs, outputs: [], targets: {}, context: {}};
  };

  return {
    get: describe,
    values: () => [...nodes.keys()].map(describe).filter(Boolean),
    raw: document,
    issues,
    scopes,
    readers,
    inputTargets: (id, port) => {
      const node = nodes.get(id);
      const inputs = node?.kind === 'complex' ? node.interface.inputs : node?.inputs;
      if (!inputs?.some(p => p.id === port && isSignal(p.type))) throw Error('Signal input not found: ' + port);
      if (isOff(node) || issues.has(id)) throw Error(issues.get(id) ?? 'Node is disabled');
      const targets = [...new Set(Editor.resolveAll(nodes, id, port, 'inputs').map(([target]) => target))];
      for (const target of targets) {
        const executable = describe(target);
        if (executable?.error) throw Error(executable.error);
        if (!executable?.running || executable.op === 'scope')
          throw Error('Signal input has no enabled executable target: ' + port);
      }
      return targets;
    },
    outputRefs: id => {
      const node = nodes.get(id);
      return (node?.kind === 'complex' ? node.interface.outputs : (node?.outputs ?? []))
        .filter(p => !isSignal(p.type))
        .map(p => ({id: p.id, ref: refOf([id, p.id])}));
    },
  };
}

function checkRoots(roots, nodes) {
  if (!Array.isArray(roots) || roots.some(id => typeof id !== 'string' || !nodes.has(id)))
    throw bad('node_ids must name nodes of this workflow');
  // A group organizes the canvas; it is not a node that can run or be read. Naming one used to
  // answer an empty, successful result.
  if (roots.some(id => nodes.get(id).kind === 'group'))
    throw bad('node_ids must name nodes or Custom Nodes, not groups');
}

// ---- executor ----
// A persistent interpreter for the live graph. Shared values survive signal dispatches.
function createGraphInterpreter(document, saved, env) {
  const {AsyncFunction, displayText, emit, call, gate} = env;
  let view = createGraphView(document, {context: env.context});
  const generations = new Map(),
    readScope = ctx => Object.assign(new Map(), {ctx});
  const nodes = {get: id => view.get(id)};
  let sequence = 0;
  const nextKey = () => 'i' + ++sequence;
  const latest = new Map(); // node id -> Map(port id -> {v: value} | {j: json text of an object}): what a running node left last
  const versions = new Map(), // node id -> how many times its latest result has changed
    signatures = new Map(), // node id -> its latest result as text, to see whether a new one is different
    dependencyCache = new Map(), // read scope -> [ids of the running nodes outside it that it reads]
    states = new Map(), // read scope -> {seen: Map(node id -> version read), at, done, promise, error}
    readNodes = new Map(); // read scope -> ids of its on_read nodes
  let tick = 0,
    stateRevision = 0;
  const scopeOf = node => node?.context?.instance_id ?? null;
  for (const n of view.values())
    if (n.op === 'on_read' && scopeOf(n)) readNodes.set(scopeOf(n), [...(readNodes.get(scopeOf(n)) ?? []), n.id]);
  const SCOPE = 'scope:';
  // Compiled Script code is reusable: the function has no captured state, only its text matters.
  // A bounded LRU keeps loops and repeated signals from compiling the same body again and again.
  const compiledFunctions = new Map();
  let compiledBytes = 0;
  const MAX_COMPILED = 100,
    MAX_COMPILED_BYTES = 8 * 1024 * 1024;
  const compile = code => {
    const text = code ?? '';
    const cached = compiledFunctions.get(text);
    if (cached) {
      compiledFunctions.delete(text);
      compiledFunctions.set(text, cached);
      return cached;
    }
    const fn = new AsyncFunction('node', 'agentsys', 'context', 'Date', 'Math', '"use strict";\n' + text);
    compiledFunctions.set(text, fn);
    compiledBytes += text.length * 2;
    while (compiledFunctions.size > MAX_COMPILED || compiledBytes > MAX_COMPILED_BYTES) {
      const oldest = compiledFunctions.keys().next().value;
      compiledFunctions.delete(oldest);
      compiledBytes -= oldest.length * 2;
    }
    return fn;
  };
  // State and value notifications are coalesced on a microtask: a loop of assignments sends its
  // last values once. The latest values themselves are updated synchronously (see `keep` and
  // `watchState`), so reads and dependencies never observe the deferred notification.
  const queuedEvents = new Map();
  const sentSinceFlush = new Set();
  let flushScheduled = false;
  const flushEvents = () => {
    flushScheduled = false;
    sentSinceFlush.clear();
    if (!queuedEvents.size) return;
    const events = [...queuedEvents.values()];
    queuedEvents.clear();
    for (const make of events) emit(make());
  };
  // The first notification of a key in a turn goes out at once (a long synchronous block must not
  // hide acknowledged state); later ones replace each other and only the last is sent.
  const publish = (key, make) => {
    if (!sentSinceFlush.has(key)) {
      sentSinceFlush.add(key);
      emit(make());
      return;
    }
    queuedEvents.set(key, () => {
      sentSinceFlush.delete(key);
      return make();
    });
    if (!flushScheduled) {
      flushScheduled = true;
      Promise.resolve().then(flushEvents);
    }
  };

  // ----- Flow control -----

  /** A wave is what one emit() started: the signal and everything it caused. Waves form a tree like a call stack (`parent` is the wave of
   *  the emit that started the Script that emitted). A cancelled wave (and every wave below it) starts nothing new; what already runs finishes.
   *  `handles` are the control signals ("break", "continue") that the emit which opened the wave answers; `control` says which one arrived;
   *  `failFast`: the first failure inside the wave cancels it. */
  const newWave = (parent, {handles = [], failFast = false} = {}) => ({
    parent,
    cancelled: false,
    control: null,
    handles: new Set(handles),
    failFast,
  });
  const cancelledWave = wave => {
    for (let w = wave; w; w = w.parent) if (w.cancelled) return true;
    return false;
  };
  /** What node.flow.break() & co throw to end the code of the Script that called them: not a failure of the node. */
  const control = what => Object.assign(new Error(`node.flow.${what}()`), {control: what});

  /** Pause gates new invocations and continuations. */
  const enter = async () => {
    while (gate?.paused) await new Promise(resolve => gate.waiters.push(resolve));
  };
  const unwrap = entry => (entry === undefined ? undefined : 'j' in entry ? JSON.parse(entry.j) : entry.v);
  /** What a node left for one port, as an entry that every reader copies out for itself (so nobody sees another's changes). */
  const entryOf = (value, text) =>
    typeof value === 'string' || typeof value === 'boolean'
      ? {v: value}
      : value === null
        ? {v: null}
        : typeof value === 'number'
          ? Number.isFinite(value)
            ? {v: value}
            : {v: JSON.parse(text)}
          : {j: text};
  const copyOf = value => (value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value);
  /** An error that is the node's own message as it is: it does not get the "Node code:" prefix of an error in code. */
  const plain = message => Object.assign(new Error(message), {plain: true});
  const EMPTY = new Map();
  const state = copyOf(saved.state ?? {});
  const stateCopy = value =>
    JSON.parse(
      JSON.stringify(value, function (_, item) {
        if (item === undefined && Array.isArray(this)) return null;
        if (
          ['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) ||
          (typeof item === 'number' && !Number.isFinite(item))
        )
          throw plain('context.state accepts JSON values only');
        return item;
      })
    );
  /** A JSON primitive is already a value of its own; only objects and invalid values need the serializer. */
  const stateValue = value =>
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
      ? value
      : stateCopy(value);
  const watchState = (value, guard, proxies = new WeakMap()) => {
    if (value === null || typeof value !== 'object') return value;
    if (proxies.has(value)) return proxies.get(value);
    const changed = () => {
      stateRevision++;
      tick++;
      // The copy is taken when the notification is sent: a loop of assignments produces one.
      publish('state', () => ({ev: 'state', state: stateCopy(state)}));
    };
    const proxy = new Proxy(value, {
      get: (target, name) => watchState(Reflect.get(target, name), guard, proxies),
      set(target, name, value) {
        guard();
        if (typeof name !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(name))
          throw plain('Invalid state key');
        Reflect.set(target, name, stateValue(value));
        changed();
        return true;
      },
      deleteProperty(target, name) {
        guard();
        Reflect.deleteProperty(target, name);
        changed();
        return true;
      },
      defineProperty() {
        throw plain('Use assignment to change context.state');
      },
      setPrototypeOf() {
        throw plain('context.state accepts JSON values only');
      },
    });
    proxies.set(value, proxy);
    return proxy;
  };
  for (const [id, values] of Object.entries(saved.outputs ?? {}))
    keep(id, {
      map: new Map(Object.entries(values).map(([port, value]) => [port, entryOf(value, JSON.stringify(value))])),
    });
  // A Library node copy that Scripts write to starts with what was typed into its outputs.
  for (const n of view.values())
    if (n.op === 'scope' && !latest.has(n.id)) {
      const map = new Map();
      for (const p of n.outputs) {
        const t = Object.hasOwn(n.preset, p.name) ? JSON.stringify(n.preset[p.name]) : undefined;
        if (t !== undefined) map.set(p.id, entryOf(n.preset[p.name], t));
      }
      keep(n.id, {
        map,
      });
    }

  // ----- Reading data -----
  /** The entry a ref points at (undefined: nothing). `scope` remembers the pure nodes read so far in this read; `path` the ones being read. */
  async function entryAt(ref, scope, path) {
    if (!ref) return undefined;
    if (ref.err) throw new Error(ref.err);
    return (await outputsOf(ref.n, scope, path)).get(ref.p);
  }
  /** The outputs of a node: the latest of a running one, the value of a pure one (computed once in a read). */
  function outputsOf(id, scope, path) {
    const node = nodes.get(id),
      home = scopeOf(node);
    if (!node) return Promise.reject(plain(Object.fromEntries(view.issues)?.[id] ?? 'Node not found: ' + id));
    if (node.error) return Promise.reject(plain(node.error));
    if (node.running) {
      const give = () => latest.get(id) ?? EMPTY;
      // The outputs of a read scope are brought up to date first (unless the reader is inside it).
      return readNodes.has(home) && !path.has(SCOPE + home)
        ? freshen(home, path, scope.ctx).then(give)
        : Promise.resolve(give());
    }
    if (path.has(id)) return Promise.reject(new Error('Graph contains a cycle'));
    if (!scope.has(id)) {
      const promise = Promise.resolve().then(() => compute(node, scope, new Set(path).add(id)));
      scope.set(id, promise);
    }
    return scope.get(id);
  }
  /** The entry an input gives: what is wired to it, else its default (none: undefined). */
  async function inputEntry(p, scope, path) {
    if (p.ref) return entryAt(p.ref, scope, path);
    if (!p.has || p.fallback === undefined) return undefined;
    const text = JSON.stringify(p.fallback);
    return text === undefined ? undefined : entryOf(copyOf(p.fallback), text);
  }
  /** A node that is computed when read: a Reroute (passes its input on) or a node that holds the values typed into its outputs. */
  async function compute(node, scope, path) {
    const result = new Map();
    if (node.kind === 'reroute') {
      const entry = node.inputs[0] && (await inputEntry(node.inputs[0], scope, path));
      if (entry !== undefined) result.set('out', entry);
    } else if (node.kind === 'custom') {
      // A node without an operation only holds what was typed into its outputs.
      for (const p of node.outputs)
        if (!p.signal && node.preset && Object.hasOwn(node.preset, p.name)) {
          const text = JSON.stringify(node.preset[p.name]);
          if (text !== undefined) result.set(p.id, entryOf(node.preset[p.name], text));
        }
    }
    return result;
  }
  /** What the code of a node left in `output` for its data ports. */
  function collect(node, output) {
    const map = new Map();
    if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
      // What the code of a Script puts in `output` must be a free output of its Library node: a slip in a name is an error, not a value that goes nowhere.
      if (node.op === 'script')
        for (const name of Object.keys(output)) {
          if (node.outputs.some(p => p.name === name)) continue;
          if (Object.hasOwn(node.signals ?? {}, name))
            throw plain(`“${name}” is a signal output: fire it with node.output.${name}.emit()`);
          throw plain(
            node.scope
              ? `The Library node has no free output “${name}” (an output that a node inside feeds cannot be set by code)`
              : `This Script is not in a Library node, so it has no outputs to set: “${name}”`
          );
        }
      for (const p of node.outputs) {
        if (p.signal || !Object.hasOwn(output, p.name)) continue;
        const text = JSON.stringify(output[p.name]);
        if (text === undefined) {
          if (output[p.name] !== undefined && node.op === 'script')
            throw plain(`node.output.${p.name} cannot be sent: a function or a symbol is not data`);
          continue;
        }
        map.set(p.id, entryOf(output[p.name], text));
      }
    }
    return {map};
  }
  /** What a node's code left in `output` becomes what readers get: a Script writes into the copy it is in (what it did not set stays as it was). */
  function commit(node, output) {
    if (!nodes.get(node.id)) return;
    const result = collect(node, output);
    if (!node.scope) return keep(node.id, result);
    const map = new Map([...(latest.get(node.scope) ?? EMPTY), ...result.map]);
    for (const p of node.outputs)
      if (!p.signal && Object.hasOwn(output, p.name) && output[p.name] === undefined) map.delete(p.id);
    keep(node.scope, {map});
  }
  /** Publish the current JSON values and invalidate dependent reads. */
  function keep(id, {map}) {
    latest.set(id, map);
    const signature = [...map]
      .map(
        ([port, entry]) =>
          port +
          '=' +
          ('j' in entry
            ? entry.j
            : typeof entry.v === 'string'
              ? JSON.stringify(entry.v)
              : typeof entry.v + ':' + String(entry.v))
      )
      .join('\u0001');
    if (signatures.get(id) !== signature) {
      signatures.set(id, signature);
      versions.set(id, (versions.get(id) ?? 0) + 1);
      tick++;
      publish('values:' + id, () => ({
        ev: 'values',
        id,
        outputs: Object.fromEntries([...map].map(([port, value]) => [port, unwrap(value)])),
      }));
    }
  }

  // ----- Read scopes -----

  /** The running nodes outside the scope whose results its nodes read (through Reroutes and nodes that are computed when read). */
  function dependencies(scope) {
    if (dependencyCache.has(scope)) return dependencyCache.get(scope);
    const found = new Set();
    const origin = (ref, seen) => {
      const n = ref?.n && nodes.get(ref.n);
      if (!n || seen.has(n.id)) return;
      seen.add(n.id);
      if (n.running) found.add(n.id);
      else for (const p of n.inputs) if (!p.signal) origin(p.ref, seen);
    };
    for (const n of view.values())
      if (scopeOf(n) === scope) for (const p of n.inputs) if (!p.signal) origin(p.ref, new Set());
    const list = [...found].filter(id => scopeOf(nodes.get(id)) !== scope);
    dependencyCache.set(scope, list);
    return list;
  }
  /** Brings the outputs of a read scope up to date: computes them if they never were, or if something they read has changed. */
  function freshen(scope, path, ctx) {
    const mark = SCOPE + scope;
    if (path.has(mark)) return Promise.reject(new Error('Graph contains a cycle'));
    let st = states.get(scope);
    if (!st) states.set(scope, (st = {seen: new Map(), at: -1, done: false, promise: null, error: null}));
    if (!st.promise) {
      if (st.done && st.at === tick) return st.error ? Promise.reject(st.error) : Promise.resolve();
      const state = st;
      state.promise = update(scope, state, new Set(path).add(mark), tick, ctx).finally(() => (state.promise = null));
    }
    return st.promise.then(() => {
      if (st.error) throw st.error;
    });
  }
  async function update(scope, st, path, at, ctx) {
    try {
      let stale = !st.done || st.contextAt !== stateRevision;
      for (const id of dependencies(scope)) {
        const home = scopeOf(nodes.get(id));
        if (readNodes.has(home)) await freshen(home, path, ctx);
        if (st.seen.get(id) !== (versions.get(id) ?? 0)) stale = true;
      }
      if (stale) {
        for (const id of dependencies(scope)) st.seen.set(id, versions.get(id) ?? 0);
        st.error = null;
        const via = new Set([...path].filter(x => typeof x === 'string' && x.startsWith(SCOPE)));
        const work = new Set();
        const outcomes = await Promise.allSettled(
          (readNodes.get(scope) ?? []).map(id =>
            track(
              run(id, {
                ...ctx,
                work,
                via,
                key: nextKey(),
                wave: newWave(ctx?.wave ?? ctx?.batch?.wave ?? null),
              }),
              work
            )
          )
        );
        while (work.size) await Promise.allSettled([...work]);
        const bad = outcomes.find(o => o.status === 'rejected');
        if (bad) st.error = bad.reason;
      }
      st.contextAt = stateRevision;
      st.done = !st.error;
    } catch (error) {
      // A scope it reads failed: this one fails with the same error, and is computed again when read again.
      st.error = error;
      st.done = false;
    }
    st.at = at;
  }

  // ----- Signals -----

  /** Signal descendants, including free Library outputs. A cycle never resets its starting node. */
  function downstream(id) {
    const seen = new Set([id]), pending = [id];
    for (let i = 0; i < pending.length; i++) {
      const node = nodes.get(pending[i]);
      for (const target of Object.values(node?.targets ?? {}).flat().concat(Object.values(node?.signals ?? {}).flat())) {
        if (seen.has(target)) continue;
        seen.add(target);
        pending.push(target);
      }
    }
    return pending.slice(1);
  }

  /** A signal leaves the output `port` of a node: every node it is wired to runs, at the same time. Answers when they and what they
   *  started have finished; throws the first error (in the order of the wires). */
  const fire = (node, port, ctx) => fireTo(nodes.get(node.id)?.targets?.[port.id] || [], ctx);
  async function fireTo(ids, ctx) {
    const outcomes = await Promise.allSettled(ids.map(id => trigger(id, {...ctx, key: nextKey()})));
    const bad = outcomes.find(o => o.status === 'rejected');
    if (bad) throw bad.reason;
  }
  /** A signal reaches a node. In a cancelled wave it does not start. */
  function trigger(id, ctx) {
    const node = nodes.get(id);
    if (!node || (!node.running && !node.error)) return Promise.resolve();
    if (cancelledWave(ctx.wave)) {
      emit({ev: 'skip', id, label: node?.label});
      return Promise.resolve();
    }
    return track(run(id, ctx), ctx.work);
  }
  const track = (promise, work) => {
    const entry = promise.catch(() => {}).finally(() => work.delete(entry));
    work.add(entry);
    return promise;
  };
  /** The execution of a running node (a Script or an event node). Answers when it and what its signals started have finished. */
  async function run(id, ctx) {
    if (cancelledWave(ctx.wave)) {
      emit({ev: 'skip', id});
      return;
    }
    const node = await execute(id, ctx);
    if (node && !cancelledWave(ctx.wave))
      for (const port of node.outputs.filter(p => p.signal)) await fire(node, port, ctx);
  }
  async function execute(id, ctx, attempt = 0) {
    let node = nodes.get(id);
    const generation = generations.get(id) ?? 0;
    const valid = () => !env.closed?.() && nodes.get(id) && (generations.get(id) ?? 0) === generation;
    const guard = (requireOpen = true) => {
      if (!valid()) {
        ctx.batch.cancelled = true;
        throw control('cancel');
      }
      if (closed && requireOpen) throw control('cancel');
    };
    const announce = event => {
      if (valid()) emit({...event, prefix: node?.prefix, invocation: ctx.key});
    };
    const started = Date.now();
    let announced = false,
      closed = false,
      shown;
    try {
      await enter();
      node = nodes.get(id);
      if (!node) throw plain(Object.fromEntries(view.issues)?.[id] ?? 'Node not found: ' + id);
      if (node.error) throw plain(node.error);
      const readingView = view;
      const data = node.inputs.filter(p => !p.signal);
      const outcomes = await Promise.allSettled(
        data.map(p => inputEntry(p, readScope(ctx), new Set([node.id, ...ctx.via])))
      );
      const bad = outcomes.find(o => o.status === 'rejected');
      if (bad) throw bad.reason;
      const values = new Map(
        data.map((p, i) => [p.id, outcomes[i].value === undefined ? undefined : unwrap(outcomes[i].value)])
      );
      await enter();
      if (view !== readingView) {
        // The graph is live: a read may see an edit. Retry a few times, then say so instead of looping.
        if (attempt >= 2) throw plain('The graph changed while its inputs were read: try again');
        return execute(id, ctx, attempt + 1);
      }
      if (cancelledWave(ctx.wave)) {
        announce({ev: 'skip', id});
        return false;
      }
      guard();
      announced = true;
      announce({ev: 'start', id: node.id, label: node.label, downstream: downstream(node.id)});
      const own = Date.now();
      const output = {...(node.preset ?? {}), ...(node.op === 'script' ? {} : (ctx.event ?? {}))};
      // A Script of a Library node reads the outputs of the node as they are now (what was typed there, what a Script left last).
      if (node.scope)
        for (const p of node.outputs) {
          const held = latest.get(node.scope)?.get(p.id);
          if (!p.signal && held !== undefined) output[p.name] = unwrap(held);
        }
      const display = (...parts) => {
        guard();
        if (closed) throw plain('The code of this node has ended');
        shown = displayText(parts);
        announce({ev: 'display', id: node.id, display: shown});
      };
      if (node.op === 'script') {
        const agentsys = async (method, route, body, query) => {
          guard(false);
          commit(node, output);
          const result = await call(node.id, method, route, body, query);
          guard(false);
          return result;
        };
        // widgets(list) puts widgets on this node (replacing its list; one that stays keeps its value); widgets.set({id: value}) sets values.
        const widgetsRoute = () => `projects/${node.context.project_id}/widgets/${node.id}`;
        const widgets = Object.assign(list => agentsys('PUT', widgetsRoute(), {widgets: list}), {
          set: values => agentsys('PUT', widgetsRoute(), {values}),
        });
        // context.event: what the event nodes beside it (in the same Library node, or at the root) carry: payload, connected, widget.
        const event = ctx.event ?? {};
        const {grant_chain, ...publicContext} = node.context;
        const context = Object.freeze({
          ...publicContext,
          event,
          state: watchState(state, () => guard(false)),
        });
        const codeInput = node.inputs.find(p => p.code);
        const code = codeInput ? values.get(codeInput.id) : '';
        if (typeof code === 'string' && /\bimport\s*\(/.test(code))
          throw plain('Dynamic import is not available in Script nodes');
        if (code !== undefined && code !== null && typeof code !== 'string')
          throw plain(`${node.prefix}: the script is text`);
        // A manual signal publishes current values and joins its own branches.
        const emitSignal = async (name, options) => {
          guard();
          if (closed) throw plain('The code of this node has ended');
          if (options !== undefined && (options === null || typeof options !== 'object'))
            throw plain('emit(options): options must be {handles, failFast}');
          const handles = options?.handles ?? [];
          if (!Array.isArray(handles) || handles.some(h => h !== 'break' && h !== 'continue'))
            throw plain('emit handles must be a list of "break" and "continue"');
          // The flow this node belongs to was cancelled: the code ends here (a loop must not go on spinning).
          if (cancelledWave(ctx.wave)) throw control('cancel');
          // A Script fires a free signal output of the Library node it belongs to.
          const current = nodes.get(node.id);
          const targets = Object.hasOwn(current?.signals ?? {}, name) ? current.signals[name] : current ? null : [];
          if (!targets)
            throw plain(
              node.scope
                ? `The Library node has no free signal output “${name}”`
                : `This Script has no signal output: “${name}”`
            );
          commit(node, output);
          flushEvents();
          announce({ev: 'pause', id: node.id, reason: 'signal'});
          const wave = newWave(ctx.wave, {handles, failFast: options?.failFast === true});
          try {
            await fireTo(targets, {...ctx, wave});
          } catch (error) {
            throw plain(error.message);
          } finally {
            await enter();
            announce({ev: 'resume', id: node.id});
          }
          return wave.control ?? undefined;
        };
        // node.flow: what the code does to the flow it is in. Each one ends the code of the Script (as `return` does), so what follows does not run;
        // do not catch it (a catch must rethrow an error that has `.control`).
        //   break(), continue()  the nearest emit above that handles it takes it: what that emit started stops starting new nodes. Without one, an error.
        //   cancel()             cancels the wave of the emit above (or, in a Script that nothing emitted for, everything started from its root): no error.
        //   abort()              cancels everything this signal call started, including its other roots.
        const unwind = what => {
          const below = [];
          for (let w = ctx.wave; w; w = w.parent) {
            below.push(w);
            if (w.handles.has(what)) {
              for (const x of below) x.cancelled = true;
              w.control = what;
              throw control(what);
            }
          }
          throw plain(
            `node.flow.${what}() outside a loop: no node above handles it (node.output.name.emit({handles: ["${what}"]}))`
          );
        };
        const flow = Object.freeze({
          break: () => unwind('break'),
          continue: () => unwind('continue'),
          cancel: () => {
            ctx.batch.cancelled = true;
            ctx.wave.cancelled = true;
            throw control('cancel');
          },
          abort: () => {
            ctx.batch.cancelled = true;
            ctx.batch.wave.cancelled = true;
            throw control('abort');
          },
        });
        // `node` is the Library node the Script is in: node.input.<name> reads its data inputs, node.output.<name> sets its free data outputs,
        // node.output.name.emit() fires a signal output, node.display(...) shows text on it, node.widgets(list) puts widgets on it and
        // node.reread(name) reads an input again.
        const input = Object.freeze(
          Object.fromEntries(node.inputs.filter(p => p.wrapper).map(p => [p.name, values.get(p.id)]))
        );
        // node.reread(name) reads an input again: the latest result of the node it comes from (for a loop that watches a value).
        const reread = async name => {
          const p = nodes.get(node.id)?.inputs.find(q => q.wrapper && q.name === name);
          if (!p) throw plain(`This node has no input “${name}”`);
          guard();
          const entry = await inputEntry(p, readScope(ctx), new Set([node.id, ...ctx.via]));
          return entry === undefined ? undefined : unwrap(entry);
        };
        // node.cancelled: the flow this node belongs to was cancelled (a long code can look and end early).
        const sleep = async ms => {
          if (!Number.isFinite(ms) || ms < 0) throw plain('Invalid delay');
          commit(node, output);
          flushEvents();
          announce({ev: 'pause', id: node.id, reason: 'delay'});
          try {
            for (let remaining = ms; remaining > 0; ) {
              const chunk = Math.min(remaining, 2147483647);
              await new Promise(resolve => setTimeout(resolve, chunk));
              remaining -= chunk;
            }
          } finally {
            await enter();
            announce({ev: 'resume', id: node.id});
          }
          if (cancelledWave(ctx.wave)) throw control('cancel');
          guard();
        };
        for (const name of Object.keys(node.signals ?? {})) {
          if (Object.hasOwn(output, name)) throw plain('A data output and signal output cannot share the name ' + name);
          Object.defineProperty(output, name, {
            value: Object.freeze({emit: options => track(emitSignal(name, options), ctx.work)}),
            enumerable: false,
          });
        }
        const outputProxy = new Proxy(output, {
          get(target, name) {
            if (typeof name === 'string' && name !== 'toJSON' && !Reflect.has(target, name))
              throw plain('Unknown output ' + name);
            return Reflect.get(target, name);
          },
          set(target, name, value) {
            guard(false);
            if (Object.hasOwn(node.signals ?? {}, name))
              throw plain('Use node.output.' + String(name) + '.emit() for a signal output');
            if (!node.outputs.some(port => !port.signal && port.name === name))
              throw plain('The Library node has no free output “' + String(name) + '”');
            target[name] = value;
            commit(node, target);
            return true;
          },
          deleteProperty(target, name) {
            guard(false);
            target[name] = undefined;
            commit(node, target);
            delete target[name];
            return true;
          },
        });
        const self = Object.freeze({
          input,
          output: outputProxy,
          display,
          widgets,
          reread,
          flow,
          sleep,
          get cancelled() {
            return cancelledWave(ctx.wave);
          },
        });

        try {
          await Promise.resolve().then(() => compile(code)(self, agentsys, context, Date, Math));
        } catch (error) {
          // node.flow.* ended the code on purpose: the node ends normally.
          if (error?.code === 'permission_denied') throw Object.assign(new Error(error.message), {blocked: true});
          if (!(error && error.control))
            throw error && error.plain
              ? error
              : new Error(`${node.prefix}: ${String((error && error.message) || error)}`);
        } finally {
          closed = true;
        }
      }
      if (!valid()) {
        ctx.batch.cancelled = true;
        return false;
      }
      commit(node, output);
      flushEvents();

      announce({ev: 'done', id: node.id, label: node.label, ms: Date.now() - own, display: shown});
      return node;
    } catch (error) {
      // A failure inside a wave of an emit with failFast cancels that wave (and the ones between).
      flushEvents();
      if (ctx.errors && valid()) ctx.errors[id] = error.message;
      const between = [];
      for (let w = ctx.wave; w; w = w.parent) {
        between.push(w);
        if (w.failFast) {
          for (const x of between) x.cancelled = true;
          break;
        }
      }
      announce({
        ev: 'fail',
        id,
        label: node?.label,
        ms: Date.now() - started,
        error: error.message,
        announced,
        blocked: !!error.blocked,
      });
      throw error;
    }
  }

  // ----- Roots -----

  /** The outputs of a node as the plain values a root reports. */
  const reported = id => {
    const out = {};
    for (const [port, entry] of latest.get(id) ?? EMPTY) out[port] = unwrap(entry);
    return out;
  };
  async function startRoot(id, batch, event) {
    const ctx = {
      batch,
      key: nextKey(),
      event,
      errors: batch.errors,
      work: batch.pending,
      via: new Set(),
      wave: newWave(batch.wave),
    };
    try {
      const outputs = {};
      if (event.input_port !== undefined) await fireTo(view.inputTargets(id, event.input_port), ctx);
      // A disabled node does not receive signals: it cannot report the values of an
      // earlier run as if this dispatch produced them.
      if (!view.get(id)) {
        emit({ev: 'root', id});
        return {id};
      }
      if (id.startsWith('complex:')) {
        for (const port of view.outputRefs(id))
          outputs[port.id] =
            port.ref && 'value' in port.ref
              ? copyOf(port.ref.value)
              : unwrap(await entryAt(port.ref, readScope(ctx), new Set()));
      } else {
        const node = nodes.get(id);
        if (!node) return {id, outputs};
        else if (node.running && event.input_port === undefined) {
          await track(run(id, ctx), batch.pending); // a Script runs as if a signal reached it, an event node carries its data and fires
          Object.assign(outputs, reported(node.scope ?? id));
        } else if (node.running) Object.assign(outputs, reported(node.scope ?? id));
        else for (const [port, entry] of await outputsOf(id, readScope(ctx), new Set())) outputs[port] = unwrap(entry);
      }
      if (!nodes.get(id)) return {id}; // removed while it ran: nothing to report
      emit({ev: 'root', id, outputs});
      return {id, outputs};
    } catch (error) {
      if (nodes.get(id)) emit({ev: 'root', id, error: error.message});
      return {id, error: error.message};
    }
  }

  return {
    flush: flushEvents,
    update(document) {
      flushEvents();
      const previous = view;
      view = createGraphView(document, {context: env.context});
      states.clear();
      dependencyCache.clear();
      readNodes.clear();
      const alive = new Set([...document.nodes.map(n => n.id), ...document.complex.map(c => 'complex:' + c.id)]);
      for (const n of previous.values()) if (!alive.has(n.id)) generations.set(n.id, (generations.get(n.id) ?? 0) + 1);
      for (const id of latest.keys())
        if (!alive.has(id)) {
          latest.delete(id);
          versions.delete(id);
          signatures.delete(id);
        }
      for (const n of view.values()) {
        if (n.op === 'on_read' && scopeOf(n)) readNodes.set(scopeOf(n), [...(readNodes.get(scopeOf(n)) ?? []), n.id]);
        if (n.op === 'scope') {
          const before = previous.get(n.id)?.preset ?? {},
            map = new Map(latest.get(n.id) ?? []);
          for (const port of n.outputs)
            if (!latest.has(n.id) || JSON.stringify(before[port.name]) !== JSON.stringify(n.preset[port.name])) {
              if (Object.hasOwn(n.preset, port.name))
                map.set(port.id, entryOf(n.preset[port.name], JSON.stringify(n.preset[port.name])));
              else map.delete(port.id);
            }
          keep(n.id, {map});
        }
      }
    },
    /** Signals the roots together and answers when everything they started has finished: {outputs by root, errors by node, cancelled}. */
    async signal(roots, event = {}) {
      const batch = {pending: new Set(), errors: {}, cancelled: false, wave: newWave(null)};
      const results = await Promise.all(roots.map(id => startRoot(id, batch, event)));
      while (batch.pending.size) await Promise.allSettled([...batch.pending]);
      flushEvents();
      return {
        outputs: Object.fromEntries(
          results.filter(result => result.outputs).map(result => [result.id, result.outputs])
        ),
        errors: {
          ...batch.errors,
          ...Object.fromEntries(results.filter(result => result.error).map(result => [result.id, result.error])),
        },
        cancelled: batch.cancelled,
      };
    },
  };
}
