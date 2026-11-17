'use strict';

// ---- routes-app ----
// Routes: session, settings, search, and the Library nodes.

// ----- application -----
route('GET', 'session', 'Read the session', async c => ({
  preferences: await c.prefs(),
  shortcut_defaults: DEFAULT_SHORTCUTS,
}));

route(
  'GET PUT',
  'settings',
  'Read or change application settings',
  async c => {
    const prefs = await c.prefs();
    if (c.method === 'GET')
      return {
        preferences: prefs,
        resources: await c.ctx.get('resources', []),
        node_folders: await nodeFolders(c),
        node_folder_icons: await c.ctx.get('node_folder_icons', {}),
      };
    const value = c.body;
    if ('undo_steps' in value) {
      if (!Number.isInteger(value.undo_steps) || value.undo_steps < 0 || value.undo_steps > 500)
        throw bad('Undo steps must be an integer from 0 to 500');
      prefs.undo_steps = value.undo_steps;
      for (const history of histories.values())
        history.undo = value.undo_steps ? history.undo.slice(-value.undo_steps) : [];
    }
    if ('developer_mode' in value) {
      if (typeof value.developer_mode !== 'boolean') throw bad('developer_mode must be true or false');
      prefs.developer_mode = value.developer_mode;
    }
    if ('shortcuts' in value) prefs.shortcuts = validateShortcuts(value.shortcuts);
    if ('style' in value) prefs.style = validateAppearance(value.style, prefs.style);
    delete prefs.themes; // saved themes and the selected theme were removed: the palette is the style
    delete prefs.theme;
    if (prefs.style) delete prefs.style.components;
    c.ctx.set('prefs', prefs);
    return prefs;
  },
  {body: {undo_steps: 50, developer_mode: false}}
);

route(
  'GET',
  'search/nodes',
  'Search nodes across all projects',
  async c => {
    const q = c.query.q ?? '',
      offset = Number(c.query.offset ?? 0),
      limit = Number(c.query.limit ?? 100);
    if (typeof q !== 'string' || q.length > 240 || offset < 0 || !(limit >= 1 && limit <= 200))
      throw bad('Search requires a query up to 240 characters, a nonnegative offset and a limit from 1 to 200');
    const norm = s => String(s).normalize('NFKC').toLowerCase();
    const terms = norm(q).replace(/\//g, ' ').split(/\s+/).filter(Boolean),
      matches = [];
    for (const project of await c.projects())
      for (const wf of project.workflows) {
        const doc = await c.ctx.get('wf:' + wf.id, emptyDoc());
        const entries = [
          ...doc.nodes.map(n => ({
            id: n.id,
            kind: n.kind,
            node_type: n.node_type,
            label: n.config?.title || n.label,
            words: n.node_type + ' ' + (n.config?.op || ''),
          })),
          ...doc.groups.map(g => ({id: 'group:' + g.id, kind: 'group', label: g.name, words: 'group'})),
        ];
        for (const e of entries) {
          const text = norm([project.name, wf.name, project.id, e.kind, e.label, e.words, e.id].join(' '));
          if (terms.every(t => text.includes(t)))
            matches.push({
              id: e.id,
              kind: e.kind,
              label: e.label.slice(0, 240),
              node_type: e.node_type ?? null,
              status: null,
              project_id: project.id,
              project_name: project.name,
              workflow_id: wf.id,
              workflow_name: wf.name,
            });
        }
      }
    return {
      nodes: matches.slice(offset, offset + limit),
      total: matches.length,
      next_offset: offset + limit < matches.length ? offset + limit : null,
    };
  },
  {query: ['q', 'offset', 'limit']}
);

// ----- library: Custom Nodes -----
route(
  'GET POST',
  'resources',
  'List or create Library nodes',
  async c => {
    const items = await c.ctx.get('resources', []);
    if (c.method === 'GET') return items;
    return saveResource(c, items, null, c.body.name, c.body.payload);
  },
  {body: {name: 'My node', payload: {bundle: {}}}}
);

function saveResource(c, items, id, name, payload, newId = null) {
  if (typeof name !== 'string' || !name.trim()) throw bad('A node name is required.');
  name = name.trim();
  validateResource(payload);
  if (items.some(r => r.name === name && r.id !== id)) throw bad('A node with that name already exists.');
  c.libraryTouched = true; // the Library's types follow its nodes
  const now = Date.now() / 1000;
  let item = items.find(r => r.id === id);
  if (item) Object.assign(item, {name, payload, updated: now});
  else {
    item = {id: newId || uid(), name, payload, created: now, updated: now};
    items.push(item);
  }
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));
  c.ctx.set('resources', items);
  return item;
}
route(
  'GET PUT DELETE',
  'resources/{resource_id}',
  'Read, change or delete a Library node',
  async (c, {resource_id}) => {
    const items = await c.ctx.get('resources', []),
      item = items.find(r => r.id === resource_id);
    if (!item) throw missing('Record not found');
    if (c.method === 'GET') return item;
    if (c.method === 'DELETE') {
      c.ctx.set(
        'resources',
        items.filter(r => r !== item)
      );
      await removeWorkflow(c, 'lib-' + item.id);
      await c.ctx.remove('policy:lib-' + item.id);
      c.libraryTouched = true;
      return {deleted: true};
    }
    let payload = c.body.payload;
    if (isObject(payload) && c.body.replace === true) {
      // Overwriting the node as a whole: the saved graph is replaced, and the editor's copy of the old one is dropped.
      await c.ctx.remove('wf:lib-' + item.id);
    } else if (isObject(payload)) {
      // The graph belongs to the editor; this form only changes the name, description, icon and group.
      const bundle = clone(item.payload.bundle),
        name = String(c.body.name ?? '')
          .trim()
          .slice(0, 100),
        top = bundle?.groups?.find(g => !g.parent);
      if (top && name) top.name = name;
      payload = {...payload, bundle};
      const doc = await c.ctx.get('wf:lib-' + item.id, null);
      const root = doc?.groups?.find(g => g.id === doc.root);
      if (root && name) root.name = name;
      if (doc) c.ctx.set('wf:lib-' + item.id, doc);
    }
    return saveResource(c, items, resource_id, c.body.name, payload);
  },
  {body: {name: 'My node', payload: {}}}
);

// ---- routes-projects ----
// Routes: projects and workflows (create, rename, duplicate, delete).

// ----- projects -----
const trimmedName = (value, label = 'Project') => {
  if (typeof value !== 'string' || !(value.trim().length >= 1 && value.trim().length <= 100))
    throw bad(`${label} name must contain 1 to 100 characters`);
  return value.trim();
};
/** A name that is not used yet: "Name", then "Name 2", "Name 3"… */
const freeName = (taken, base) => {
  let name = base.slice(0, 100),
    n = 2;
  while (taken.has(name)) name = base.slice(0, 100 - ` ${n}`.length).trimEnd() + ` ${n++}`;
  return name;
};
async function nextUntitled(c, projects) {
  const meta = await c.ctx.get('meta', {project_number: 0});
  const numbers = projects
    .map(p => /^untitled(\d+)$/i.exec(p.name))
    .filter(Boolean)
    .map(m => Number(m[1]));
  return Math.max(meta.project_number || 0, ...numbers) + 1;
}

route('GET', 'project-defaults', 'Suggest a name for a new project', async c => ({
  name: 'Untitled' + (await nextUntitled(c, await c.projects())),
}));

route(
  'GET POST',
  'projects',
  'List or create projects',
  async c => {
    const projects = await c.projects();
    if (c.method === 'GET')
      return projects.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description || '',
        workflow_count: p.workflows.length,
      }));
    const number = await nextUntitled(c, projects);
    const name = c.body.auto_name || !String(c.body.name || '').trim() ? 'Untitled' + number : trimmedName(c.body.name);
    const match = /^untitled(\d+)$/i.exec(name);
    if (match) c.ctx.set('meta', {project_number: Math.max(number - 1, Number(match[1]))});
    const id = uid();
    projects.push({
      id,
      name,
      description: '',
      created: Date.now() / 1000,
      workflows: [{id, name: 'Main', created: Date.now() / 1000}],
    });
    c.ctx.set('projects', projects);
    return {id, name};
  },
  {body: {name: 'My project'}}
);

route(
  'GET PUT PATCH DELETE',
  'projects/{project_id}',
  'Read, change, rename or delete a project',
  async (c, {project_id}) => {
    const projects = await c.projects(),
      project = await c.project(project_id, c.method !== 'GET');
    if (c.method === 'GET')
      return {
        project: {id: project.id, name: project.name, description: project.description || ''},
        workflows: project.workflows.map(wf => ({...wf, project_id})),
      };
    if (c.method === 'DELETE') {
      for (const wf of project.workflows) await removeWorkflow(c, wf.id);
      await c.ctx.remove('policy:' + project_id);
      c.ctx.set(
        'projects',
        projects.filter(p => p !== project)
      );
      return {deleted: project_id};
    }
    project.name = trimmedName(c.body.name ?? project.name);
    if ('description' in c.body) {
      if (typeof c.body.description !== 'string' || c.body.description.length > 2000)
        throw bad('Description must be text of at most 2000 characters');
      project.description = c.body.description;
    }
    return {id: project_id, name: project.name, description: project.description || ''};
  },
  {body: {name: 'New name'}}
);

route('POST', 'projects/{project_id}/duplicate', 'Duplicate a project with its workflows', async (c, {project_id}) => {
  const projects = await c.projects(),
    source = await c.project(project_id, true),
    name = freeName(new Set(projects.map(p => p.name)), source.name.slice(0, 95) + ' copy');
  const id = uid(),
    copy = {id, name, description: source.description || '', created: Date.now() / 1000, workflows: []};
  for (const wf of source.workflows) {
    const wid = copy.workflows.length ? uid() : id;
    copy.workflows.push({id: wid, name: wf.name, created: Date.now() / 1000});
    let ids;
    c.ctx.set(
      'wf:' + wid,
      duplicateDocument(await c.ctx.get('wf:' + wf.id, emptyDoc()), map => {
        ids = map;
      })
    );
    await duplicateGraphData(c, wf.id, wid, ids);
  }
  projects.push(copy);
  c.ctx.set('projects', projects);
  return {id, name};
});

route(
  'GET POST',
  'projects/{project_id}/workflows',
  'List or create workflows',
  async (c, {project_id}) => {
    const project = await c.project(project_id, c.method === 'POST');
    if (c.method === 'GET') return project.workflows.map(w => ({...w, project_id}));
    const name = trimmedName(c.body.name ?? 'Workflow', 'Workflow');
    if (project.workflows.some(w => w.name === name)) throw bad('A workflow with that name already exists');
    const id = uid();
    project.workflows.push({id, name, created: Date.now() / 1000});
    c.ctx.set('wf:' + id, emptyDoc());
    return {id};
  },
  {body: {name: 'Workflow'}}
);

route(
  'PATCH DELETE',
  'projects/{project_id}/workflows/{workflow_id}',
  'Rename or delete a workflow',
  async (c, {project_id, workflow_id}) => {
    const project = await c.project(project_id, true),
      wf = project.workflows.find(w => w.id === workflow_id);
    if (!wf) throw missing('Record not found');
    if (c.method === 'DELETE') {
      project.workflows = project.workflows.filter(w => w !== wf);
      await removeWorkflow(c, workflow_id);
      return {deleted: workflow_id};
    }
    const name = trimmedName(c.body.name, 'Workflow');
    if (project.workflows.some(w => w.name === name && w.id !== workflow_id))
      throw bad('A workflow with that name already exists');
    wf.name = name;
    return {id: workflow_id, name};
  },
  {body: {name: 'New name'}}
);

route(
  'POST',
  'projects/{project_id}/workflows/{workflow_id}/duplicate',
  'Duplicate a workflow',
  async (c, {project_id, workflow_id}) => {
    const project = await c.project(project_id, true),
      source = project.workflows.find(w => w.id === workflow_id);
    if (!source) throw missing('Record not found');
    const existing = new Set(project.workflows.map(w => w.name)),
      base = c.body.name != null ? trimmedName(c.body.name, 'Workflow') : source.name.slice(0, 95) + ' copy',
      name = freeName(existing, base);
    const id = uid();
    project.workflows.push({id, name, created: Date.now() / 1000});
    let ids;
    c.ctx.set(
      'wf:' + id,
      duplicateDocument(await c.ctx.get('wf:' + workflow_id, emptyDoc()), map => {
        ids = map;
      })
    );
    await duplicateGraphData(c, workflow_id, id, ids);
    return {id, name};
  }
);

// ---- execution ----
// A live runtime belongs to the workflow, including its durable JSON state and values.
const GRAPH_RUNTIMES = new Map();
// A live runtime is cheap to rebuild from its saved data, so idle ones are released: after ten
// minutes without a signal, or beyond sixteen idle workflows (least recently used first).
let RUNTIME_TTL_MS = 10 * 60 * 1000;
const MAX_IDLE_RUNTIMES = 16;
const runtimeKey = id => `workflows/${id}/runtime`;
const runtimeStatus = entry => (entry.paused ? 'paused' : entry.pending.size ? 'running' : 'idle');
const BUSY = ['running', 'sleeping', 'waiting'];

async function graphData(c, workflow) {
  const live = GRAPH_RUNTIMES.get(workflow),
    saved = live ? runtimeDetail(live) : await c.ctx.get(runtimeKey(workflow), {});
  return clone({state: saved.state ?? {}, outputs: saved.outputs ?? {}, displays: saved.displays ?? {}});
}
function importGraphData(c, workflow, value) {
  if (value === undefined) return;
  if (
    !isObject(value) ||
    !isObject(value.state) ||
    !isObject(value.outputs) ||
    !isObject(value.displays) ||
    Object.values(value.outputs).some(value => !isObject(value)) ||
    Object.values(value.displays).some(text => typeof text !== 'string')
  )
    throw bad('runtime must contain JSON state, outputs and displays objects');
  c.ctx.set(runtimeKey(workflow), clone(value));
}
async function duplicateGraphData(c, source, target, ids) {
  const data = await graphData(c, source);
  for (const key of ['outputs', 'displays'])
    data[key] = Object.fromEntries(
      Object.entries(data[key])
        .filter(([id]) => ids.has(id))
        .map(([id, value]) => [ids.get(id), value])
    );
  importGraphData(c, target, data);
}
const runtimeDetail = entry => ({
  workflow_id: entry.workflow,
  status: runtimeStatus(entry),
  paused: entry.paused,
  revision: entry.revision,
  active_signals: entry.pending.size,
  nodes: [...entry.nodes.values()],
  runs: entry.runs,
  activity: entry.activity,
  outputs: entry.outputs,
  errors: entry.errors,
  displays: entry.displays,
  state: entry.state,
  ...(entry.storageError ? {storage_error: entry.storageError} : {}),
});
function saveRuntime(entry) {
  entry.revision++;
  entry.dirty = true;
  if (!entry.saving)
    entry.saving = Promise.resolve()
      .then(async () => {
        while (entry.dirty && !entry.deleted) {
          entry.dirty = false;
          const {runs: _passes, activity: _activity, ...saved} = runtimeDetail(entry);
          try {
            await DB.commit({[runtimeKey(entry.workflow)]: clone(saved)});
            entry.storageError = null;
          } catch (error) {
            // Keep the change for the next attempt: a transient failure must not lose it, and
            // waiting requests see storage_error instead of an ambiguous rejection.
            entry.storageError = error.message;
            entry.dirty = true;
            return;
          }
        }
      })
      .finally(() => {
        entry.saving = null;
        // A change that arrived between the last loop check and this cleanup is written now; a
        // recorded storage failure waits for the next explicit save instead of spinning.
        if (entry.dirty && !entry.deleted && !entry.storageError) saveRuntime(entry);
      });
  entry.saving.catch(error => {
    entry.storageError = error.message;
  });
  return entry.saving;
}
/** A runtime nothing is using: no signal, pause, detached handler, stop or write in flight. */
const runtimeIdle = entry =>
  !entry.pending.size && !entry.paused && !entry.detached.size && !entry.stopping && !entry.saving && !entry.dirty && !entry.deleted;
/** Releases an idle runtime's host and keeps only its saved data. */
function evictRuntime(entry) {
  if (GRAPH_RUNTIMES.get(entry.workflow) !== entry || !runtimeIdle(entry)) return false;
  const host = entry.host;
  entry.host = null;
  entry.controller?.abort();
  host?.close();
  GRAPH_RUNTIMES.delete(entry.workflow);
  return true;
}
/** Lazy sweep: called when a workflow runtime is looked up or signalled. */
function sweepRuntimes(now = Date.now()) {
  const idle = [...GRAPH_RUNTIMES.values()]
    .filter(runtimeIdle)
    .sort((a, b) => b.lastUsed - a.lastUsed);
  for (const entry of idle) if (now - entry.lastUsed > RUNTIME_TTL_MS) evictRuntime(entry);
  const left = idle.filter(entry => GRAPH_RUNTIMES.has(entry.workflow));
  for (const entry of left.slice(MAX_IDLE_RUNTIMES)) evictRuntime(entry);
}
function runtimeDocument(entry) {
  if (!entry.detached.size) return entry.document;
  const document = clone(entry.document);
  for (const fragment of entry.detached.values()) {
    for (const name of ['nodes', 'complex', 'groups', 'edges']) {
      const known = new Set(document[name].map(item => item.id));
      document[name].push(...fragment[name].filter(item => !known.has(item.id)));
    }
    Object.assign(document.widgets, fragment.widgets);
  }
  return document;
}
function syncRuntimeGraph(workflow, document) {
  const entry = GRAPH_RUNTIMES.get(workflow);
  if (!entry) return;
  const signature = JSON.stringify(document);
  if (signature === entry.documentSignature) return;
  entry.documentSignature = signature;
  entry.document = document;
  const current = runtimeDocument(entry);
  entry.alive = new Set([...current.nodes.map(n => n.id), ...current.complex.map(c => 'complex:' + c.id)]);
  for (const values of [entry.outputs, entry.displays, entry.errors])
    for (const id of Object.keys(values)) if (!entry.alive.has(id)) delete values[id];
  for (const id of Object.keys(entry.runs)) if (!entry.alive.has(id)) delete entry.runs[id];
  for (const id of entry.nodes.keys()) if (!entry.alive.has(id)) entry.nodes.delete(id);
  entry.host?.update(current).catch(error => {
    if (entry.host) entry.errors.host = error.message;
  });
  saveRuntime(entry);
}
async function graphRuntime(c, project) {
  sweepRuntimes();
  const metadata = await c.project(project),
    selected = c.workflowId ?? metadata.workflows[0]?.id;
  if (!metadata.workflows.some(workflow => workflow.id === selected)) throw missing('Workflow not found');
  const existing = GRAPH_RUNTIMES.get(selected);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }
  return exclusive(async () => {
    const {editor, meta} = await c.workflow(project);
    if (!GRAPH_RUNTIMES.has(meta.id)) {
      const saved = (await DB.get(runtimeKey(meta.id))) ?? {};
      GRAPH_RUNTIMES.set(meta.id, {
        project,
        workflow: meta.id,
        document: editor.snapshot(),
        state: clone(saved.state ?? {}),
        outputs: clone(saved.outputs ?? {}),
        displays: clone(saved.displays ?? {}),
        errors: clone(saved.errors ?? {}),
        // Nothing runs after a restart: what was busy was stopped.
        nodes: new Map(
          (saved.nodes ?? []).map(node => [
            node.node_id,
            {...node, status: BUSY.includes(node.status) ? 'stopped' : node.status},
          ])
        ),
        // node id -> how many times it finished or failed: the editor lights a node for each pass, however short
        runs: {},
        activity: [], // bounded start order for the canvas; transient, never replayed after a restart
        activitySequence: 0,
        revision: saved.revision ?? 0,
        paused: saved.paused === true,
        pending: new Set(), // the signal calls in progress
        dispatches: new Set(), // their records, for Stop
        calls: new Map(), // node id -> status of each of its overlapping invocations
        detached: new Map(),
        host: null,
        controller: null,
        dirty: false,
        saving: null,
        lastUsed: Date.now(),
      });
    }
    const document = editor.snapshot();
    for (const {doc} of c.docs.values()) doc.types = ownTypes(doc.types);
    await c.ctx.commit();
    syncRuntimeGraph(meta.id, document);
    sweepRuntimes();
    return GRAPH_RUNTIMES.get(meta.id);
  });
}
function runtimeEvent(entry, event) {
  if (event.id && !entry.alive?.has(event.id)) return;
  if (event.ev === 'state') {
    entry.state = event.state;
    return saveRuntime(entry);
  }
  if (event.ev === 'values') {
    entry.outputs[event.id] = event.outputs;
    return saveRuntime(entry);
  }
  if (event.ev === 'display') {
    entry.displays[event.id] = event.display;
    return saveRuntime(entry);
  }
  if (event.ev === 'root') {
    if (event.error) entry.errors[event.id] = event.error;
    else {
      entry.outputs[event.id] = event.outputs;
      delete entry.errors[event.id];
    }
    return saveRuntime(entry);
  }
  const status = {
    start: 'running',
    resume: 'running',
    pause: event.reason === 'delay' ? 'sleeping' : 'waiting',
    done: 'completed',
    fail: event.blocked ? 'blocked' : 'failed',
    skip: 'skipped',
  }[event.ev];
  if (!status) return;
  if (event.ev === 'start')
    for (const id of event.downstream ?? []) {
      // A parallel invocation owns its live state; only previous, settled work is cleared.
      const previous = entry.nodes.get(id);
      if (id !== event.id && previous && !entry.calls.get(id)?.size && !BUSY.includes(previous.status))
        entry.nodes.set(id, {node_id: id, status: 'ready'});
    }
  if (event.ev === 'start') {
    entry.activity.push({sequence: ++entry.activitySequence, node_id: event.id});
    if (entry.activity.length > 128) entry.activity.splice(0, entry.activity.length - 128);
  }
  // A node with overlapping invocations stays active until all of them have settled.
  const calls = entry.calls.get(event.id) ?? new Map(),
    key = event.invocation ?? event.id;
  if (BUSY.includes(status)) calls.set(key, status);
  else calls.delete(key);
  if (calls.size) entry.calls.set(event.id, calls);
  else entry.calls.delete(event.id);
  const current = BUSY.find(status => [...calls.values()].includes(status)) ?? status;
  entry.nodes.set(event.id, {node_id: event.id, status: current, ...(event.error ? {error: event.error} : {})});
  if (event.ev === 'done' || event.ev === 'fail') entry.runs[event.id] = (entry.runs[event.id] ?? 0) + 1;
  if (event.ev === 'start') delete entry.errors[event.id];
  if (event.error) entry.errors[event.id] = event.error;
  saveRuntime(entry);
}
function ensureGraphHost(entry) {
  if (entry.host) return entry.host;
  entry.controller = new AbortController();
  let host;
  host = createScriptHost(runtimeDocument(entry), runtimeDetail(entry), {
    context: {project_id: entry.project, workflow_id: entry.workflow},
    paused: entry.paused,
    signal: entry.controller.signal,
    onEvent: event => {
      if (host && entry.host === host) runtimeEvent(entry, event);
    },
    onFailure: () => {
      if (entry.host !== host) return;
      entry.host = null;
      entry.controller?.abort();
    },
  });
  entry.host = host;
  return host;
}
/**
 * Signals the roots and answers, when everything they started has finished, with the runtime plus `dispatch_status`
 * and `dispatch_outputs` (the outputs of the roots). `caller` is the Script context of a checked API call: stopping
 * the caller's workflow stops this one too.
 */
function signalGraph(entry, roots, event = {}, caller = null) {
  checkRoots(roots, Graph.nodeMap(runtimeDocument(entry)));
  entry.lastUsed = Date.now();
  const record = {cancelled: false},
    stopping = entry.stopping,
    callerSignal = caller?.signal,
    stopWithCaller = () => stopGraph(entry.workflow).catch(() => {});
  if (callerSignal && caller.workflow_id !== entry.workflow)
    callerSignal.addEventListener('abort', stopWithCaller, {once: true});
  entry.dispatches.add(record);
  const work = (async () => {
    let result = {errors: {}, outputs: {}};
    try {
      await stopping; // a Run that arrives while Stop is in progress starts after it
      if (!record.cancelled && roots.length) result = await ensureGraphHost(entry).signal(roots, event);
      // The host answered: a failure recorded by an earlier dispatch is history, not the state of this one.
      delete entry.errors.host;
    } catch (error) {
      if (!record.cancelled) {
        entry.errors.host = error.message;
        result = {errors: {host: error.message}, outputs: {}};
      }
    } finally {
      callerSignal?.removeEventListener('abort', stopWithCaller);
      entry.dispatches.delete(record);
      entry.pending.delete(work);
      entry.lastUsed = Date.now();
      await saveRuntime(entry);
    }
    const failed = Object.keys(result.errors).length > 0;
    return {
      ...runtimeDetail(entry),
      dispatch_status: record.cancelled || result.cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
      dispatch_outputs: result.outputs,
      errors: result.errors,
    };
  })();
  // A fire-and-forget signal still exposes persistence failures via runtime.storage_error.
  work.catch(() => {});
  entry.pending.add(work);
  saveRuntime(entry);
  return work;
}
/** Stops the workflow's host (and so its timers and checked network calls). Data stays; waits for the work to end. */
function stopGraph(workflow) {
  const entry = GRAPH_RUNTIMES.get(workflow);
  if (!entry) return Promise.resolve();
  if (entry.stopping) return entry.stopping;
  const pending = [...entry.pending];
  for (const record of entry.dispatches) record.cancelled = true;
  const host = entry.host;
  entry.controller?.abort();
  const work = (async () => {
    // One turn for the host to hand over the notifications coalesced before Stop (state, values).
    await new Promise(resolve => setTimeout(resolve, 0));
    if (entry.host === host) entry.host = null;
    host?.close();
    entry.paused = false;
    for (const [id, node] of entry.nodes)
      if (BUSY.includes(node.status)) entry.nodes.set(id, {...node, status: 'stopped'});
    entry.calls.clear();
    await Promise.allSettled(pending);
    await saveRuntime(entry);
  })().finally(() => {
    entry.stopping = null;
  });
  entry.stopping = work;
  return work;
}
async function deleteGraphRuntime(workflow) {
  const entry = GRAPH_RUNTIMES.get(workflow);
  if (entry) {
    await stopGraph(workflow);
    entry.deleted = true;
    await entry.saving;
    GRAPH_RUNTIMES.delete(workflow);
  }
  await DB.commit({[runtimeKey(workflow)]: undefined});
}
/** Release a deleted workflow's live work, durable state and undo history together. */
async function removeWorkflow(c, workflow) {
  await deleteGraphRuntime(workflow);
  await c.ctx.remove('wf:' + workflow);
  clearHistories(workflow);
}
async function dispatchGraphEvent(project, workflow, hook, group, data, removed = null) {
  const entry = await graphRuntime(new Call('GET', {}, {workflow_id: workflow}, null), project);
  if (removed) {
    const root = removed.complex.find(c => c.id === group),
      ids = new Set(root?.members ?? []);
    ids.add('complex:' + group);
    const existing = new Set(entry.document.nodes.map(n => n.id));
    entry.detached.set(group, {
      ...removed,
      nodes: removed.nodes.filter(n => ids.has(n.id) && !existing.has(n.id)),
      complex: removed.complex.filter(c => ids.has('complex:' + c.id)),
      groups: removed.groups.filter(g => g.id === group || ids.has('complex:' + g.id)),
      edges: removed.edges.filter(e => ids.has(e.source) || ids.has(e.target)),
    });
    entry.documentSignature = null;
    syncRuntimeGraph(workflow, entry.document);
  }
  const view = createGraphView(runtimeDocument(entry), {context: {project_id: project, workflow_id: workflow}});
  const roots = view
    .values()
    .filter(n => n.op === hook && view.scopes.get(n.id)?.group === group)
    .map(n => n.id);
  try {
    return await signalGraph(entry, roots, data);
  } finally {
    if (removed) {
      entry.detached.delete(group);
      entry.documentSignature = null;
      syncRuntimeGraph(workflow, entry.document);
    }
  }
}

DB.subscribe(keys => {
  for (const entry of GRAPH_RUNTIMES.values())
    if (keys.includes('wf:' + entry.workflow) || keys.includes('resources')) {
      exclusive(async () => {
        if (GRAPH_RUNTIMES.get(entry.workflow) !== entry) return;
        const call = new Call('GET', {}, {workflow_id: entry.workflow}, null);
        const {editor} = await call.workflow(entry.project);
        const document = editor.snapshot();
        for (const {doc} of call.docs.values()) doc.types = ownTypes(doc.types);
        await call.ctx.commit();
        syncRuntimeGraph(entry.workflow, document);
        if (call.refreshed) DB.announce(['wf:' + entry.workflow]);
      }).catch(error => {
        entry.errors.host = error.message;
        saveRuntime(entry);
      });
    }
});
route(
  'GET POST DELETE',
  'projects/{project_id}/execution',
  'Inspect the live graph, signal on_run or stop current work',
  async (c, {project_id}) => {
    const entry = await graphRuntime(c, project_id);
    if (c.method === 'DELETE') await stopGraph(entry.workflow);
    if (c.method === 'POST') {
      const roots = c.body.node_ids ?? entry.document.nodes.filter(isRunStart).map(node => node.id);
      const event = {payload: c.body.payload ?? {}};
      if (c.body.input_port !== undefined) {
        if (typeof c.body.input_port !== 'string') throw bad('input_port must name a signal input');
        event.input_port = c.body.input_port;
      }
      if (!isObject(event.payload)) throw bad('payload must be an object');
      const work = signalGraph(entry, roots, event, c.scriptContext);
      if (c.body.wait === true) return await work;
      return {...runtimeDetail(entry), dispatch_status: 'running'};
    }
    await entry.saving;
    sweepRuntimes();
    return runtimeDetail(entry);
  },
  {
    unlocked: true,
    body: {payload: {}, wait: false, node_ids: [], input_port: null},
    query: ['workflow_id'],
  }
);
route(
  'POST',
  'projects/{project_id}/execution/{action}',
  'Pause or resume the live graph',
  async (c, {project_id, action}) => {
    if (!['pause', 'resume'].includes(action)) throw bad('Choose pause or resume');
    const entry = await graphRuntime(c, project_id);
    entry.paused = action === 'pause';
    entry.host?.pause(entry.paused).catch(() => {});
    await saveRuntime(entry);
    return runtimeDetail(entry);
  },
  {unlocked: true, query: ['workflow_id']}
);

// ---- routes-workflow ----
// Routes used by the canvas: read the graph, undo/redo, create and edit nodes, wires, groups,
// Complex Nodes, clipboard, styles, layout, validation and evaluation.

route(
  'POST',
  'projects/{project_id}/batch',
  'Apply related graph edits as one document transaction',
  async (c, params) => {
    const operations = c.body.operations;
    if (!Array.isArray(operations) || !operations.length || operations.length > 200)
      throw bad('Pass 1 to 200 operations');
    const workflow = await c.workflow(params.project_id);
    const result = [];
    for (const operation of operations) {
      if (
        !isObject(operation) ||
        typeof operation.path !== 'string' ||
        !/^[a-z-]+(?:\/[a-zA-Z0-9:-]+)?$/.test(operation.path) ||
        !EDITS.has(operation.path.split('/')[0]) ||
        ['batch', 'available-nodes'].includes(operation.path)
      )
        throw bad('Invalid batch edit path');
      const method = operation.method ?? 'PUT';
      const path = `projects/${params.project_id}/${operation.path}`;
      const found = ROUTES.find(r => r.regex.test(path) && r.methods.has(method) && !r.unlocked);
      if (!found || (operation.body !== undefined && !isObject(operation.body))) throw bad('Invalid batch edit');
      const before = c.body;
      c.body = {...(operation.body ?? {}), workflow_id: workflow.meta.id};
      try {
        result.push(await found.handler(c, {...path.match(found.regex).groups}));
      } finally {
        c.body = before;
      }
    }
    return {results: result};
  }
);

// ----- workflow canvas -----
route(
  'GET',
  'projects/{project_id}/workflow',
  'Read the workflow graph',
  async (c, {project_id}) => {
    const {project, meta, doc} = await c.workflow(project_id),
      h = historyOf(meta.id, c.client);
    return {...buildSnapshot(project, meta, doc), history: {undo: h.undo.length, redo: h.redo.length}};
  },
  {
    query: ['workflow_id'],
    returns: 'Nodes with their ports, wires, groups and diagnostics, and the undo and redo depth',
  }
);

for (const redo of [false, true])
  route(
    'POST',
    `projects/{project_id}/${redo ? 'redo' : 'undo'}`,
    redo ? 'Redo the last undone edit' : 'Undo the last edit',
    async (c, {project_id}) => {
      const {meta, doc} = await c.workflow(project_id),
        h = historyOf(meta.id, c.client),
        from = redo ? h.redo : h.undo,
        to = redo ? h.undo : h.redo,
        entry = from.pop();
      if (entry) {
        let state;
        if (redo) state = entry.after;
        else {
          entry.after = JSON.stringify(stateOf(doc));
          state = entry.before;
        }
        Object.assign(doc, JSON.parse(state));
        to.push(entry);
      }
      return {undo: h.undo.length, redo: h.redo.length};
    }
  );

route(
  'GET',
  'node-hooks',
  'Read the log of the on_placed, on_deleted, on_input_connected and on_widget signals that ran without a Run (the last 200)',
  async c => HOOKS.log.filter(e => !c.query.workflow_id || e.workflow_id === c.query.workflow_id),
  {
    unlocked: true,
    query: ['workflow_id'],
    returns: 'Entries {at, hook, node_id, project_id, workflow_id, ok, error, ms}, oldest first',
  }
);

route(
  'PUT',
  'projects/{project_id}/available-nodes',
  'Include or exclude a Library node or all current nodes in a Library group from this workflow’s Add menu',
  async (c, {project_id}) => {
    const {resource_id, folder, enabled} = c.body;
    if (typeof enabled !== 'boolean') throw bad('Pass enabled: true or false');
    if ((typeof resource_id === 'string') === (typeof folder === 'string'))
      throw bad('Pass either resource_id or folder');
    const items = await c.ctx.get('resources', []);
    let targets;
    if (typeof resource_id === 'string') {
      if (!items.some(r => r.id === resource_id)) throw missing('Custom Node not found');
      if (project_id === 'lib-' + resource_id) throw bad('A Custom Node cannot contain itself');
      targets = [resource_id];
    } else {
      if (!(await nodeFolders(c)).includes(folder)) throw missing('Group not found');
      targets = items
        .filter(r => project_id !== 'lib-' + r.id && underPath(String(r.payload.folder || ''), folder))
        .map(r => r.id);
    }
    const {doc} = await c.workflow(project_id),
      available = new Set(doc.library_nodes ?? []);
    for (const id of targets) {
      if (enabled) available.add(id);
      else available.delete(id);
    }
    doc.library_nodes = [...available];
    return {library_nodes: clone(doc.library_nodes)};
  },
  {
    body: {resource_id: 'Library resource ID', enabled: true},
    query: ['workflow_id'],
    note: 'Use folder instead of resource_id to toggle a group and its subgroups. All Library nodes are excluded by default.',
  }
);

route(
  'POST',
  'projects/{project_id}/custom-nodes/{resource_id}',
  'Place a Library Custom Node on the canvas as one node',
  async (c, {project_id, resource_id}) => {
    const item = (await c.ctx.get('resources', [])).find(r => r.id === resource_id);
    if (!item) throw bad('Custom Node not found');
    if (project_id === 'lib-' + resource_id) throw bad('A Custom Node cannot contain itself');
    if (item.payload.bundle?.version !== BUNDLE_VERSION)
      throw bad(`The Custom Node “${item.name}” has a bundle this version cannot read.`);
    const {editor, doc} = await c.workflow(project_id);
    const result = editor.paste(clone(item.payload.bundle), c.body.point, {
      source: {resource_id, stamp: item.updated},
      grants: c.body.grants ?? item.payload.grants ?? [],
    });
    // Placement and inclusion are one edit: failed placement never changes the available set.
    doc.library_nodes = [...new Set([...(doc.library_nodes ?? []), resource_id])];
    return result;
  },
  {body: {point: {x: 0, y: 0}}, query: ['workflow_id']}
);

route(
  'POST',
  'projects/{project_id}/typed-nodes',
  'Create a Custom node',
  async (c, {project_id}) => {
    await c.requireDeveloper('Creating a Custom node');
    return (await c.workflow(project_id)).editor.saveNode(c.body);
  },
  {
    body: {
      node_type: 'custom',
      config: {
        title: 'Answer',
        op: 'script',
        inputs: [
          {id: 'in', name: 'In', type: 'signal'},
          {id: 'script', name: 'script', default: 'node.display(42);', type: 't:… (a type with the code control)'},
        ],
        outputs: [{id: 'out', name: 'out', type: 'signal'}],
      },
      position: {x: 0, y: 0},
    },
    returns:
      'The new node. config: {title, inputs: [{id, name, type?}], outputs: [{id, name, type?}], op? (what the node does: script, on_run, on_read, on_placed, on_deleted, on_input_connected, on_widget; none: it holds the values typed into its outputs), widgets? (the widgets the node has: [{id, kind, label?, value?, ...}])}. A port of type `signal` carries no data: a signal output goes to every wire, and a signal input starts the node. A Script (op script) has exactly the signal input `in` and the code input `script`, and the signal output `out`, emitted automatically after successful completion: it runs the code when a signal reaches it, and the code reads the data inputs of the Library node it is in (node.input.name), writes its free outputs (node.output.name) and fires its free signal outputs (node.output.name.emit()).',
  }
);
route(
  'POST',
  'projects/{project_id}/primitives',
  'Add a Script or an Event node',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.addPrimitive(c.body.primitive, c.body.point),
  {
    body: {primitive: 'script', point: {x: 0, y: 0}},
    returns:
      'The new node. The two nodes the engine is made of: `script` (runs its code when a signal reaches it) and `event` (no inputs, one signal output; it fires when the event chosen on it happens).',
  }
);
route(
  'PUT',
  'projects/{project_id}/primitives/{node_id}/event',
  'Choose the event of an Event node',
  async (c, {project_id, node_id}) => (await c.workflow(project_id)).editor.setEvent(node_id, c.body.event),
  {body: {event: 'on_run'}, returns: 'One of on_run, on_read, on_placed, on_deleted, on_input_connected, on_widget'}
);
route(
  'PUT',
  'projects/{project_id}/typed-nodes/{node_id}',
  "Change a Custom node's configuration",
  async (c, {project_id, node_id}) => {
    await c.requireDeveloper('Changing a Custom node');
    return (await c.workflow(project_id)).editor.saveNode(c.body, node_id);
  },
  {body: {node_type: 'custom', config: {title: 'Answer', outputs: [{id: 'result', name: 'result', default: 43}]}}}
);
route(
  'POST',
  'projects/{project_id}/split-connections',
  'Break connections in the middle with a Reroute point',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.splitConnections(c.body),
  {body: {splits: [{edge_id: 'port:…', position: {x: 0, y: 0}}]}, returns: 'The ids of the new Reroute points'}
);
route(
  'PUT',
  'projects/{project_id}/widgets/{node_id}',
  'Put widgets on a Custom node, or set the values of its widgets (for Script code that puts widgets on a node)',
  async (c, {project_id, node_id}) => {
    const {editor} = await c.workflow(project_id);
    if ('widgets' in c.body) editor.setWidgets(node_id, c.body.widgets);
    if ('values' in c.body) editor.setWidgetValues(node_id, c.body.values);
    if (!('widgets' in c.body || 'values' in c.body))
      throw bad('Give widgets (the list) or values ({widget ID: value})');
    return {saved: true};
  },
  {
    body: {widgets: [{id: 'name', kind: 'text', label: 'Name', value: ''}]},
    returns:
      'Widget kinds: text, textarea, number, checkbox, select (options), range (min, max, step), button (its value counts clicks), label (text), html (html, height; shown in a sandboxed frame). A widget that stays keeps its value unless the list gives one.',
  }
);
route(
  'PUT',
  'projects/{project_id}/widget-values',
  'A person changed widgets of a node: sets the values and calls on_widget of the node',
  async (c, {project_id}) => {
    const {editor} = await c.workflow(project_id);
    editor.setWidgetValues(c.body.node_id, c.body.values);
    for (const id of Object.keys(c.body.values)) c.widgetEvents.push({node_id: c.body.node_id, widget_id: id});
    return {saved: true};
  },
  {body: {node_id: 'record:…', values: {name: 'Ann'}}}
);
route(
  'PUT',
  'projects/{project_id}/input-values',
  'A person typed into the control of a free input: sets the value (the default of the input) on the node; null takes it away',
  async (c, {project_id}) => {
    const {editor} = await c.workflow(project_id);
    return editor.setInputValues(c.body.node_id, c.body.values);
  },
  {body: {node_id: 'record:… or complex:…', values: {name: 'Ann'}}}
);
route(
  'PUT',
  'projects/{project_id}/output-values',
  'A person typed into the control of an output that shows one (`editable`): sets the value the node holds there, which is its output until its code sets another; null takes it away',
  async (c, {project_id}) => {
    const {editor} = await c.workflow(project_id);
    return editor.setOutputValues(c.body.node_id, c.body.values);
  },
  {body: {node_id: 'record:… or complex:…', values: {value: 'Ann'}}}
);
route(
  'GET',
  'projects/{project_id}/types',
  'The types this workflow defines (records of named, typed fields; ports use them as t:<id>)',
  async (c, {project_id}) => ({types: clone((await c.workflow(project_id)).editor.doc.types ?? [])}),
  {returns: '{types: [{id, name, color?, fields: [{name, type}]}]}'}
);
route(
  'PUT',
  'projects/{project_id}/types',
  'Replace the types of this workflow (a type that ports use cannot be removed)',
  async (c, {project_id}) => {
    await c.requireDeveloper('Changing types');
    // The Custom Node being edited may change the Library types it uses: they are changed for everybody once it is saved.
    return {
      types: (await c.workflow(project_id)).editor.setTypes(c.body.types, {library: project_id.startsWith('lib-')}),
    };
  },
  {
    body: {
      types: [
        {
          id: '32 hex characters',
          name: 'Person',
          color: '#7aa2f7',
          fields: [
            {name: 'name', type: 'text'},
            {name: 'age', type: 'int'},
          ],
        },
      ],
    },
  }
);
route(
  'PUT',
  'projects/{project_id}/node-slots/{node_id}',
  'Change the input and output slots of a node (for Script code that manages the slots of a Library node copy); a direction that is left out stays',
  async (c, {project_id, node_id}) => {
    const {inputs, outputs} = c.body,
      slots = {...(inputs ? {inputs} : {}), ...(outputs ? {outputs} : {})};
    return (await c.workflow(project_id)).editor.setSlots(node_id, slots);
  },
  {body: {inputs: [{id: 'a', name: 'a', type: 't:… (optional)'}], outputs: [{id: 'result', name: 'result'}]}}
);
route(
  'POST',
  'projects/{project_id}/port-connections',
  'Add or remove wires between ports',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.connections(c.body),
  {body: {add: [{source: 'node id', source_port: 'result', target: 'node id', target_port: 'input'}], remove: []}}
);
route(
  'PUT',
  'projects/{project_id}/complex/{group_id}',
  'Turn a group into a Complex Node, or change its ports, collapsed state or size',
  async (c, {project_id, group_id}) => (await c.workflow(project_id)).editor.complex(group_id, c.body),
  {body: {wrap: true, collapsed: false}}
);
route(
  'PUT',
  'projects/{project_id}/groups',
  'Replace the list of groups',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.groups(c.body.groups),
  {body: {groups: [{id: 'g1', name: 'Group', members: []}]}}
);
route(
  'DELETE',
  'projects/{project_id}/groups/{group_id}',
  'Delete a group with its nodes',
  async (c, {project_id, group_id}) => (await c.workflow(project_id)).editor.deleteGroup(group_id),
  {query: ['workflow_id']}
);
route(
  'POST',
  'projects/{project_id}/delete-nodes',
  'Delete nodes, optionally reconnecting their wires',
  async (c, {project_id}) =>
    (await c.workflow(project_id)).editor.deleteNodes(
      c.body.node_ids,
      c.body.dissolve ?? false,
      c.body.group_positions
    ),
  {body: {node_ids: [], dissolve: false}}
);
route(
  'POST',
  'projects/{project_id}/copy',
  'Copy nodes into a clipboard bundle',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.copy(c.body.node_ids, c.body.group_ids),
  {body: {node_ids: [], group_ids: []}}
);
route(
  'POST',
  'projects/{project_id}/paste',
  'Paste a clipboard bundle',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.paste(c.body.clipboard, c.body.point),
  {body: {clipboard: {version: BUNDLE_VERSION}, point: {x: 0, y: 0}}}
);
route(
  'PUT',
  'projects/{project_id}/node-style',
  'Pin, color, collapse (folded) or disable (disabled) a node or group; a disabled group disables everything in it',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.nodeStyle(c.body),
  {body: {node_id: 'node id', pinned: true, color: '#3b6ea8', folded: false, disabled: false}}
);
route(
  'PUT',
  'projects/{project_id}/node-title',
  'Rename a Custom node on this workflow (a Complex Node or a group is renamed through its group)',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.renameNode(c.body.node_id, c.body.title),
  {body: {node_id: 'node id', title: 'Name'}}
);
route(
  'PUT',
  'projects/{project_id}/layout',
  'Move or resize nodes',
  async (c, {project_id}) => (await c.workflow(project_id)).editor.saveLayout(c.body.positions),
  {body: {positions: {'node id': {x: 0, y: 0}}}}
);

route(
  'POST',
  'projects/{project_id}/evaluate-node',
  'Evaluate nodes and return their outputs',
  async (c, {project_id}) => {
    const body = c.body,
      ids = body.node_ids ?? body.node_id;
    const multiple = Array.isArray(ids);
    const entry = await graphRuntime(c, project_id);
    const roots = multiple ? ids : [ids],
      result = await signalGraph(entry, roots, {}, c.scriptContext);
    const errors = Object.fromEntries(roots.filter(id => result.errors[id]).map(id => [id, result.errors[id]]));
    if (!body.collect && Object.keys(errors).length) throw Error(Object.values(errors)[0]);
    return {
      outputs: multiple
        ? Object.fromEntries(roots.map(id => [id, result.outputs[id] ?? {}]))
        : (result.outputs[ids] ?? {}),
      errors,
      displays: result.displays,
      status: Object.fromEntries(result.nodes.map(node => [node.node_id, node.status])),
      dispatch_status: result.dispatch_status,
    };
  },
  {
    unlocked: true,
    body: {node_ids: ['node id'], collect: true},
    returns:
      'Outputs by node id, errors by node id, the state of every evaluated node and the text that nodes showed with node.display(), by node id',
  }
);

// ---- routes-library ----
// Routes of the Custom Node Library: the tree of groups, and the graph editor that edits one Custom Node
// (a private workflow whose id is "lib-<resource id>").

// ----- Library groups for Custom Nodes: a tree of named groups, stored apart from the nodes -----
// parentPath and underPath are shared with the client (runtime/core.js).
/** Stored groups plus every level of the group path of each item (imported items name a group that may not exist yet). */
async function nodeFolders(c) {
  const all = new Set(await c.ctx.get('node_folders', []));
  for (const r of await c.ctx.get('resources', [])) {
    const parts = String(r.payload.folder || '')
      .split('/')
      .filter(Boolean);
    parts.forEach((_, i) => all.add(parts.slice(0, i + 1).join('/')));
  }
  return [...all].sort((a, z) => a.localeCompare(z, undefined, {sensitivity: 'base'}));
}
route(
  'GET POST',
  'library/node-folders',
  'List, create, rename or delete Library groups',
  async c => {
    const folders = await nodeFolders(c);
    if (c.method === 'GET') return folders;
    const {action} = c.body,
      path = String(c.body.path ?? ''),
      name = String(c.body.name ?? '').trim();
    let items = await c.ctx.get('resources', []);
    const validName = () => {
      if (!name || name.length > 100 || name.includes('/'))
        throw bad('A group name has 1 to 100 characters and no “/”.');
    };
    let next = folders;
    const icons = await c.ctx.get('node_folder_icons', {});
    if (action === 'icon') {
      if (!folders.includes(path)) throw bad('Group not found');
      const icon = String(c.body.icon ?? '');
      validateIcon(icon);
      if (icon) icons[path] = icon;
      else delete icons[path];
    } else if (action === 'create') {
      validName();
      if (path && !folders.includes(path)) throw bad('Group not found');
      const made = path ? path + '/' + name : name;
      if (folders.includes(made)) throw bad('A group with this name already exists here.');
      next = [...folders, made];
    } else if (action === 'rename') {
      validName();
      if (!folders.includes(path)) throw bad('Group not found');
      const target = parentPath(path) ? parentPath(path) + '/' + name : name;
      if (target !== path && folders.includes(target)) throw bad('A group with this name already exists here.');
      const move = p => (underPath(p, path) ? target + p.slice(path.length) : p);
      next = folders.map(move);
      for (const k of Object.keys(icons))
        if (underPath(k, path) && move(k) !== k) {
          icons[move(k)] = icons[k];
          delete icons[k];
        }
      for (const r of items) r.payload.folder = move(String(r.payload.folder || ''));
    } else if (action === 'delete') {
      if (!folders.includes(path)) throw bad('Group not found');
      // The group goes with everything in it: its groups, and the Custom Nodes (with their graphs).
      next = folders.filter(p => !underPath(p, path));
      for (const k of Object.keys(icons)) if (underPath(k, path)) delete icons[k];
      const doomed = items.filter(r => underPath(String(r.payload.folder || ''), path));
      if (doomed.length) c.libraryTouched = true;
      for (const r of doomed) {
        await removeWorkflow(c, 'lib-' + r.id);
        await c.ctx.remove('policy:lib-' + r.id);
      }
      items = items.filter(r => !doomed.includes(r));
    } else throw bad('Unknown action');
    c.ctx.set('node_folders', next);
    c.ctx.set('node_folder_icons', icons);
    c.ctx.set('resources', items);
    return nodeFolders(c);
  },
  {
    body: {action: 'create', path: '', name: 'Logic'},
    note: 'action: create | rename | delete | icon',
  }
);

route(
  'POST',
  'library/custom-nodes/{resource_id}/move',
  'Move a Custom Node into a group',
  async (c, {resource_id}) => {
    const items = await c.ctx.get('resources', []),
      item = items.find(r => r.id === resource_id);
    if (!item) throw missing('Record not found');
    const folder = String(c.body.folder ?? '');
    if (folder && !(await nodeFolders(c)).includes(folder)) throw bad('Group not found');
    item.payload.folder = folder;
    c.ctx.set('resources', items);
    return {id: item.id, folder};
  },
  {body: {folder: 'Logic'}}
);

// A client plugin uses this to turn a small form into an ordinary Library node. The node is saved by the server
// and has no dependency on the plugin after this call: it is a normal graph with a Script.
route(
  'POST',
  'library/script-nodes',
  'Create a Script-backed Library node',
  async c => {
    const name = String(c.body.name || '').trim();
    if (!name || name.length > 100) throw bad('A node name has 1 to 100 characters');
    const code = String(c.body.code ?? '');
    if (!code.trim() || code.length > 200000) throw bad('The Script code has 1 to 200000 characters');
    const inputs = c.body.inputs === undefined ? [] : c.body.inputs,
      outputs = c.body.outputs === undefined ? [] : c.body.outputs,
      grants = c.body.grants === undefined ? ['graph.read'] : c.body.grants;
    if (!Array.isArray(inputs) || inputs.length > 64 || !Array.isArray(outputs) || outputs.length > 64)
      throw bad('inputs and outputs are lists of at most 64 ports');
    checkManifest({grants});
    const items = await c.ctx.get('resources', []);
    const resourceId = c.body.resource_id === undefined || c.body.resource_id === null ? null : String(c.body.resource_id);
    let existing = null;
    if (resourceId) {
      existing = items.find(item => item.id === resourceId);
      if (!existing) throw missing('Record not found');
      // A deployed plugin may replace only a node it owns. Without the owner tag this is a person's node, and a
      // package update must never rewrite it.
      const owner = existing.payload?.plugin?.id;
      const claimed = c.body.plugin && isObject(c.body.plugin) ? String(c.body.plugin.id ?? '') : '';
      if (!owner || owner !== claimed)
        throw new ApiError('permission_denied', 'This Library node is not owned by that plugin; it was not changed.', 403);
      if (!existing.payload.plugin.contentChecksum)
        throw new ApiError('resource_conflict', 'This Library node has no deployment edit baseline. Export it and explicitly redeploy it before replacing it.', 409);
      if (existing.payload.plugin.contentChecksum !== resourceContentChecksum(existing.payload))
        throw new ApiError('resource_conflict', 'This Library node was edited after deployment; preserve or duplicate those edits before updating.', 409);
    }
    if (items.some(item => item.name === name && item.id !== resourceId)) throw bad('A node with that name already exists.');
    const payload = scriptNodePayload({
      name,
      inputs,
      outputs,
      grants,
      code,
      description: String(c.body.description ?? '').slice(0, 2000),
      folder: String(c.body.folder ?? '').slice(0, 200),
      icon: c.body.icon,
    });
    if (c.body.plugin && isObject(c.body.plugin)) {
      const owner = String(c.body.plugin.id ?? '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(owner)) throw bad('Invalid plugin owner id');
      payload.plugin = {
        id: owner,
        name: String(c.body.plugin.name ?? name).slice(0, 100),
        version: String(c.body.plugin.version ?? '').slice(0, 40),
        checksum: String(c.body.plugin.checksum ?? '').slice(0, 80),
        contentChecksum: resourceContentChecksum(payload),
      };
    }
    const saved = saveResource(c, items, resourceId, name, payload);
    if (resourceId) {
      // The editor's private copy of the old graph must not outlive the definition it was built from.
      await c.ctx.remove('wf:lib-' + resourceId);
      await c.ctx.remove('policy:lib-' + resourceId);
    }
    return saved;
  },
  {
    body: {
      name: 'HTTP Request',
      code: 'node.output.value = 1;',
      inputs: [],
      outputs: ['value'],
      resource_id: null,
      plugin: {id: 'my-plugin', name: 'HTTP Request', version: '1.0.0', checksum: 'fnv1a-…'},
    },
    note: 'resource_id replaces a Script-backed node that a plugin owns; a user node is never rewritten.',
  }
);

// ----- Library graph editor: a private workflow that holds the Custom Node being edited -----
route(
  'POST',
  'library/node-editor',
  'Open the graph editor for a new or existing Custom Node',
  async c => {
    await c.requireDeveloper('Editing a Custom Node');
    const items = await c.ctx.get('resources', []);
    const rid = c.body.resource_id || uid(),
      item = items.find(r => r.id === rid);
    if (c.body.resource_id && !item) throw missing('Record not found');
    const id = 'lib-' + rid,
      doc = emptyDoc();
    doc.folder = String(c.body.folder ?? '');
    if (!item) {
      // A new node starts with its main group, a Complex Node that everything else is built inside.
      const gid = uid();
      doc.groups.push({id: gid, name: 'Custom node', members: [], parent: null});
      doc.complex.push({
        id: gid,
        interface: {inputs: [], outputs: []},
        collapsed: false,
        compact_width: 240,
        compact_height: 90,
      });
      // The frame starts as small as it can be (the smallest size its resize allows); it grows around what is put inside.
      doc.layout['group:' + gid] = {x: 0, y: 0, width: 260, height: 140};
      doc.root = gid;
    } else {
      const project = await c.project(id),
        editor = new Editor(project, project.workflows[0], doc);
      editor.paste(clone(item.payload.bundle), {x: 0, y: 0}, {preserveIds: true});
      const top = doc.groups.find(g => !g.parent && doc.complex.some(x => x.id === g.id && !x.source));
      if (top) {
        doc.complex.find(cx => cx.id === top.id).collapsed = false;
        top.name = item.name;
        doc.root = top.id;
        // The saved bundle keeps only node positions; the workspace is the area they cover, with room to grow.
        const spots = doc.nodes.map(n => doc.layout[n.id]).filter(Boolean);
        const saved = item.payload.frame,
          x0 = spots.length ? Math.min(...spots.map(p => p.x)) : 0,
          y0 = spots.length ? Math.min(...spots.map(p => p.y)) : 0;
        // The frame comes back as it was left; without a saved one it covers the nodes with room to grow.
        if (saved)
          doc.layout['group:' + top.id] = {
            x: x0 + saved.dx,
            y: y0 + saved.dy,
            width: Math.max(300, saved.width),
            height: Math.max(200, saved.height),
          };
        // Without an explicit user-sized frame, let the canvas wrap the visible
        // composition rather than fitting every hidden descendant in the template.
      }
    }
    c.ctx.set('wf:' + id, doc);
    if (!item) {
      // The new node exists in the Library from the start and follows every change.
      let name = 'Custom node';
      for (let n = 2; items.some(r => r.name === name); n++) name = 'Custom node ' + n;
      doc.groups.find(g => g.id === doc.root).name = name;
      const project = await c.project(id),
        editor = new Editor(project, project.workflows[0], doc);
      const bundle = editor.copy([], [doc.root]);
      saveResource(c, items, null, name, {bundle, description: '', folder: doc.folder}, rid);
    }
    histories.delete(id);
    return {project_id: id, workflow_id: id, resource_id: rid};
  },
  {body: {resource_id: null, folder: ''}}
);

route(
  'POST',
  'library/custom-nodes/{resource_id}/duplicate',
  'Duplicate a Custom Node',
  async (c, {resource_id}) => {
    await c.requireDeveloper('Duplicating a Custom Node');
    const items = await c.ctx.get('resources', []),
      item = items.find(r => r.id === resource_id);
    if (!item) throw missing('Record not found');
    const name = freeName(new Set(items.map(r => r.name)), item.name.slice(0, 95) + ' copy');
    const payload = clone(item.payload),
      top = payload.bundle?.groups?.find(g => !g.parent);
    if (top) top.name = name;
    const copy = saveResource(c, items, null, name, payload);
    return {id: copy.id, name: copy.name};
  },
  {body: {}}
);

// ---- routes-permissions ----
route(
  'GET PUT',
  'projects/{project_id}/node-permissions/{node_id}',
  'Inspect effective Script grants or authorize a standalone Script',
  async (c, {project_id, node_id}) => {
    const {doc, editor} = await c.workflow(project_id),
      raw = doc.nodes.find(n => n.id === node_id),
      node = createGraphView(editor.snapshot(), {context: {project_id, workflow_id: c.workflowId}}).get(node_id);
    if (!raw || raw.config?.op !== 'script' || !node) throw missing('Script not found');
    const chain = node.context.grant_chain ?? [],
      editable = !chain.length;
    if (c.method === 'PUT') {
      if (!editable) throw bad('Edit the enclosing Custom Node permissions');
      if (!Array.isArray(c.body.grants)) throw bad('grants is required');
      checkManifest(c.body);
      raw.config.grants = clone(c.body.grants);
    }
    const layers = editable ? [raw.config.grants ?? []] : chain,
      policy = await c.ctx.get('policy:' + project_id, {allow: ['graph.read']}),
      candidates = [...new Set([...policy.allow, ...layers.flat()])],
      effective = candidates.filter(
        capability => allows(policy.allow, capability) && layers.every(list => allows(list, capability))
      );
    return {node_id, editable, grants: raw.config.grants ?? [], layers, project_allow: policy.allow, effective};
  },
  {needs: {GET: ['graph.read'], PUT: ['system.admin']}, query: ['workflow_id'], body: {grants: ['graph.read']}}
);
route(
  'GET PUT',
  'projects/{project_id}/policy',
  'Read or set the workspace capability allow list and its egress policy',
  async (c, {project_id}) => {
    await c.project(project_id);
    const current = await c.ctx.get('policy:' + project_id, {allow: ['graph.read']});
    if (c.method === 'PUT') {
      checkManifest({grants: c.body.allow});
      if (!Array.isArray(c.body.allow)) throw bad('allow is required');
      const next = {allow: c.body.allow};
      if ('net' in c.body) {
        if (c.body.net === null) {
          // Explicitly inherit the server's egress policy.
        } else if (!isObject(c.body.net) || Array.isArray(c.body.net)) throw bad('net must be an object or null');
        else {
          const {allow, deny_private} = c.body.net;
          if (allow !== undefined) {
            if (
              !Array.isArray(allow) ||
              allow.length > 50 ||
              allow.some(value => typeof value !== 'string' || !value || value.length > 200 || !/^[A-Za-z0-9.*:_\[\]-]+$/.test(value))
            )
              throw bad('net.allow must be a list of at most 50 host patterns');
          }
          if (deny_private !== undefined && typeof deny_private !== 'boolean')
            throw bad('net.deny_private must be true or false');
          next.net = {...(allow === undefined ? {} : {allow}), ...(deny_private === undefined ? {} : {deny_private})};
        }
      } else if (isObject(current.net)) next.net = current.net;
      c.ctx.set('policy:' + project_id, next);
    }
    const policy = await c.ctx.get('policy:' + project_id, {allow: ['graph.read']});
    return {allow: policy.allow ?? [], net: isObject(policy.net) ? policy.net : null};
  },
  {
    needs: {GET: ['system.admin'], PUT: ['system.admin']},
    body: {allow: ['graph.read'], net: {allow: ['api.example.com'], deny_private: true}},
  }
);
route('GET PUT DELETE', 'secrets/{name}', 'Store a secret; reads return metadata only', async (c, {name}) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(name)) throw bad('Invalid secret name');
  const key = 'secrets/' + name;
  if (c.method === 'PUT') {
    if (typeof c.body.value !== 'string' || !c.body.value || c.body.value.length > 10000)
      throw bad('value is text of 1 to 10000 characters');
    c.ctx.set(key, {value: c.body.value});
  }
  if (c.method === 'DELETE') await c.ctx.remove(key);
  return {name, present: c.method !== 'DELETE' && !!(await c.ctx.get(key))};
});
route(
  'POST',
  'net',
  'Make a capability checked HTTP request',
  async c => {
    let url;
    try {
      url = new URL(c.body.url);
    } catch {
      throw bad('Invalid network URL');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw bad('Use an HTTP(S) URL without credentials');
    // Secrets belong in headers or the body. A placeholder in the URL would be sent literally (and would move the
    // checked host if it were expanded), so it is refused before anything leaves the server.
    if (/\{\{secret:/i.test(String(c.body.url)))
      throw bad('A secret placeholder cannot be used in a network URL; put it in a header or the body');
    const host = authorityOf(url);
    if (!netHostAllowed(host))
      throw new ApiError(
        'permission_denied',
        `This server does not fetch ${url.host}; it allows ${NET_ALLOW.join(', ')}.`,
        403
      );
    // A project can narrow egress further for its own Scripts; a direct API call is bounded by the server list.
    const projectPolicy = c.scriptContext?.project_id
      ? await DB.get('policy:' + c.scriptContext.project_id)
      : null;
    const netPolicy = isObject(projectPolicy?.net) ? projectPolicy.net : null;
    if (netPolicy && !hostMatches(netPolicy.allow, host))
      throw new ApiError(
        'permission_denied',
        `This project does not fetch ${url.host}; it allows ${(netPolicy.allow || []).join(', ') || 'no host'}.`,
        403
      );
    const denyPrivate = netPolicy?.deny_private === true || (netPolicy?.deny_private !== false && NET_BLOCK_PRIVATE);
    let pinnedAddress = null;
    if (denyPrivate) {
      try {
        pinnedAddress = await publicAddress(url.hostname);
      } catch (error) {
        throw new ApiError('network_error', `Could not resolve ${url.hostname}: ${error.message}`, 502);
      }
      if (!pinnedAddress)
        throw new ApiError(
          'permission_denied',
          `This policy does not fetch private, loopback or link-local addresses (${url.hostname}).`,
          403
        );
    }
    const executionSignal = c.scriptContext?.signal;
    if (executionSignal?.aborted) throw bad('Execution stopped');
    {
      const request = await injectSecrets(c.body);
      const timeout = request.timeout === undefined ? 30000 : Number(request.timeout);
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120000)
        throw bad('timeout must be a number of milliseconds from 1 to 120000');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('The request timed out')), timeout);
      const abort = () => controller.abort(executionSignal?.reason);
      executionSignal?.addEventListener('abort', abort, {once: true});
      try {
        const limit = 2000000;
        const pinned = denyPrivate && typeof AGENTSYS_HTTP_REQUEST === 'function';
        const response = pinned
          ? await AGENTSYS_HTTP_REQUEST({
              url: url.toString(),
              method: request.method ?? 'GET',
              headers: request.headers ?? {},
              body: request.body,
              address: pinnedAddress,
              limit,
              timeout,
              signal: controller.signal,
            })
          : await fetch(url, {
              method: request.method ?? 'GET',
              headers: request.headers,
              body: request.body,
              redirect: 'manual',
              signal: controller.signal,
            });
        if (response.status >= 300 && response.status < 400)
          throw new ApiError('permission_denied', 'Redirects require a separate request and host permission', 403);
        let text;
        if (pinned) text = response.text;
        else {
          const declared = Number(response.headers?.get?.('content-length'));
          if (Number.isFinite(declared) && declared > limit) throw bad('Network response is too large');
          // Read with a hard limit instead of buffering whatever a remote endpoint chooses to send.
          if (response.body?.getReader) {
            const reader = response.body.getReader(),
              decoder = new TextDecoder(),
              chunks = [];
            let size = 0;
            while (true) {
              const {done, value} = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > limit) {
                await reader.cancel().catch(() => {});
                throw bad('Network response is too large');
              }
              chunks.push(value);
            }
            text = chunks.map(chunk => decoder.decode(chunk, {stream: true})).join('') + decoder.decode();
          } else text = await response.text();
        }
        if (text.length > limit) throw bad('Network response is too large');
        // Secrets can be reflected by an endpoint: scrub all stored values before returning.
        let clean = text;
        for (const m of JSON.stringify(c.body).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g)) {
          const secret = await DB.get('secrets/' + m[1]);
          if (secret?.value) clean = clean.replaceAll(secret.value, '[REDACTED]');
        }
        return {status: response.status, text: clean};
      } catch (error) {
        if (executionSignal?.aborted) throw bad('Execution stopped');
        if (error?.status) throw error;
        if (error?.code === 'too_large') throw bad('Network response is too large');
        if (error?.code === 'timeout' || controller.signal.aborted)
          throw new ApiError('network_error', 'The network request timed out', 504);
        throw new ApiError('network_error', 'The network request failed: ' + (error?.message || error), 502);
      } finally {
        clearTimeout(timer);
        // A refused redirect or declared oversized response may still be streaming. Release it as well as
        // successful requests; clearing the timeout alone leaves the socket and body alive indefinitely.
        controller.abort();
        executionSignal?.removeEventListener('abort', abort);
      }
    }
  },
  {unlocked: true}
);

// ---- routes-exchange ----
// Export and import of whole workflows and projects as one JSON document (what a person, a script or another
// program can save, diff, generate and bring back). Custom Nodes placed in a workflow travel as they are; they
// refresh from the Library when the same Library item exists in the target.

const EXCHANGE_KEYS = [
  'types',
  'nodes',
  'layout',
  'style',
  'groups',
  'complex',
  'port_edges',
  'widgets',
  'library_nodes',
];
const decodeExchange = packet => {
  try {
    return TextGraph.decode(packet);
  } catch (error) {
    throw bad(error.message);
  }
};

/** The document as exchanged: its stored parts, without the change counter. It carries the types it uses (the Library's too), so the file stands alone. */
const exportedDocument = async (c, doc, workflow) => {
  const out = clone(stateOf(doc)),
    library = await c.libraryTypes();
  out.types = [...library.filter(t => !out.types.some(o => o.id === t.id)).map(clone), ...out.types];
  const byId = new Map(out.types.map(t => [t.id, t])),
    used = new Set(),
    todo = [
      ...out.nodes.flatMap(n => [...(n.config?.inputs ?? []), ...(n.config?.outputs ?? [])]),
      ...out.complex.flatMap(x => [...x.interface.inputs, ...x.interface.outputs]),
    ].flatMap(p => typeRefs(p.type));
  for (const id of todo) {
    if (used.has(id)) continue;
    used.add(id);
    if (byId.has(id)) todo.push(...refsOf(byId.get(id)));
  }
  out.types = out.types.filter(t => used.has(t.id)).map(({library, ...t}) => t);
  if (workflow) out.runtime = await graphData(c, workflow);
  return out;
};

/** Checks a document from outside and returns a clean copy; throws a readable error if it cannot be a workflow. */
function importedDocument(project, input) {
  if (!isObject(input)) throw bad('document must be an object');
  const doc = emptyDoc();
  for (const key of EXCHANGE_KEYS) {
    if (!(key in input)) continue;
    const kind = ['types', 'nodes', 'groups', 'complex', 'port_edges', 'library_nodes'].includes(key)
      ? Array.isArray(input[key])
      : isObject(input[key]);
    if (!kind) throw bad(`document.${key} has the wrong shape`);
    doc[key] = clone(input[key]);
  }
  if (doc.library_nodes.some(id => typeof id !== 'string'))
    throw bad('document.library_nodes must contain resource IDs');
  doc.library_nodes = [...new Set(doc.library_nodes)];
  const ids = new Set();
  for (const node of doc.nodes) {
    if (!isObject(node) || typeof node.id !== 'string' || ids.has(node.id))
      throw bad('Every node needs a unique string id');
    ids.add(node.id);
    if (node.kind !== 'function' || !Object.hasOwn(DEFINITIONS, node.node_type))
      throw bad('A node has an unsupported type');
  }
  // An imported type is the workflow's own until it turns out to be a Library type of this installation (see unifyTypes).
  doc.types = doc.types.map(t => (isObject(t) ? plainType(t) : t));
  checkTypes(doc.types);
  for (const [id, list] of Object.entries(doc.widgets)) {
    if (!ids.has(id)) throw bad('Widgets belong to a node that does not exist');
    checkWidgets(list);
  }
  try {
    new Editor(project, {id: 'import', name: 'import'}, doc).snapshot();
  } catch (error) {
    throw bad('The document is not a valid workflow: ' + (error.message || error));
  }
  return doc;
}
// Insert through the same ID remapping and type merging as clipboard paste.
route('POST', 'projects/{project_id}/import-graph', 'Insert an exported graph into an existing workflow', async (c, {project_id}) => {
  const input = decodeExchange(c.body.graph);
  if (!['workflow', 'graph'].includes(input.kind) || !input.document) throw bad('Choose an exported workflow graph');
  const {project, editor, doc} = await c.workflow(project_id);
  const imported = importedDocument(project, input.document);
  const source = new Editor(project, {id: 'import', name: 'Imported graph'}, imported);
  const bundle = source.copy(imported.nodes.map(n => n.id), imported.groups.map(g => g.id));
  const result = bundle.records.length || bundle.groups.length ? editor.paste(bundle, c.body.point ?? {x: 0, y: 0}) : {ids: [], roots: []};
  doc.library_nodes = [...new Set([...(doc.library_nodes ?? []), ...imported.library_nodes])];
  return result;
}, {body: {workflow_id: 'target workflow', graph: {}, point: {x: 0, y: 0}}});

const wrapDocument = (kind, extra) => TextGraph.encode({kind, ...extra});

route(
  'GET',
  'projects/{project_id}/workflows/{workflow_id}/export',
  'Export the workflow graph (nodes, groups and connections)',
  async (c, {project_id, workflow_id}) => {
    if (String(project_id).startsWith('lib-')) throw bad('Export a Custom Node from the Library');
    const project = await c.project(project_id),
      wf = project.workflows.find(w => w.id === workflow_id);
    if (!wf) throw missing('Record not found');
    return wrapDocument('workflow', {
      name: wf.name,
      document: await exportedDocument(c, await c.ctx.get('wf:' + wf.id, emptyDoc())),
    });
  },
  {returns: '{format: "agentsys.text/1", files: {"graph.json": text, "layout.json": text, "scripts/…js": source}}'}
);
route(
  'POST',
  'projects/{project_id}/workflows/import',
  'Add a workflow from an exported document',
  async (c, {project_id}) => {
    if (String(project_id).startsWith('lib-')) throw bad('Workflows are imported into projects');
    const project = await c.project(project_id),
      body = decodeExchange(c.body);
    const input = body.kind === 'workflow' || body.document ? body : null;
    if (!input?.document) throw bad('Pass {name, document} as exported by the export route');
    const doc = importedDocument(project, input.document),
      name = freeName(
        new Set(project.workflows.map(w => w.name)),
        String(body.name ?? input.name ?? 'Imported workflow').trim() || 'Imported workflow'
      );
    const id = uid();
    project.workflows.push({id, name, created: Date.now() / 1000});
    c.ctx.set('wf:' + id, doc);
    c.ctx.set('projects', await c.projects());
    await c.collectHooks(project_id, id, doc, JSON.stringify(stateOf(emptyDoc())));
    return {id, name, diagnostics: new Editor(project, {id, name}, doc).snapshot().diagnostics.map(d => d.message)};
  },
  {
    body: TextGraph.encode({
      kind: 'workflow',
      name: 'optional new name',
      document: {types: [], nodes: [], layout: {}, groups: [], complex: [], port_edges: [], widgets: {}},
    }),
  }
);
route(
  'GET',
  'projects/{project_id}/export',
  'Export a project with all its workflows as one JSON document',
  async (c, {project_id}) => {
    if (String(project_id).startsWith('lib-')) throw bad('Export a Custom Node from the Library');
    const project = await c.project(project_id),
      workflows = [];
    for (const wf of project.workflows)
      workflows.push({
        name: wf.name,
        document: await exportedDocument(c, await c.ctx.get('wf:' + wf.id, emptyDoc()), wf.id),
      });
    return wrapDocument('project', {name: project.name, description: project.description || '', workflows});
  },
  {returns: '{format: "agentsys.text/1", files: canonical project files}'}
);
/** Creates a project from a decoded project document (`projects/import`). */
async function importProjectDocument(c, body) {
  if (!Array.isArray(body.workflows) || !body.workflows.length || body.workflows.length > 100)
    throw bad('Pass {name, workflows: [{name, document}]} as exported by the export route');
  const projects = await c.projects(),
    id = uid(),
    project = {
      id,
      name: freeName(
        new Set(projects.map(p => p.name)),
        String(body.name ?? 'Imported project').trim() || 'Imported project'
      ),
      description: typeof body.description === 'string' ? body.description.slice(0, 2000) : '',
      created: Date.now() / 1000,
      workflows: [],
    };
  const docs = [];
  for (const item of body.workflows) {
    if (!isObject(item)) throw bad('Every workflow needs a name and a document');
    const doc = importedDocument(project, item.document),
      name = freeName(
        new Set(project.workflows.map(w => w.name)),
        String(item.name ?? 'Workflow').trim() || 'Workflow'
      ),
      wid = project.workflows.length ? uid() : id;
    project.workflows.push({id: wid, name, created: Date.now() / 1000});
    docs.push([wid, doc]);
    importGraphData(c, wid, item.document.runtime);
  }
  for (const [wid, doc] of docs) {
    c.ctx.set('wf:' + wid, doc);
    await c.collectHooks(id, wid, doc, JSON.stringify(stateOf(emptyDoc())));
  }
  projects.push(project);
  c.ctx.set('projects', projects);
  return {id, name: project.name, workflows: project.workflows.map(w => ({id: w.id, name: w.name}))};
}
route(
  'POST',
  'projects/import',
  'Create a project from an exported document',
  async c => importProjectDocument(c, decodeExchange(c.body)),
  {body: TextGraph.encode({kind: 'project', name: 'My project', workflows: [{name: 'Main', document: {}}]})}
);

// ---- routes-notifications ----
// Notifications: a list of messages for the person (the bell at the top right). Plugins (api.notify) and
// workflows post to it, through POST notifications (the capability `notifications.write`). A notification is a short title, an optional text,
// a level and an optional link to a page of the app.

const NOTIFICATIONS = 'notifications';
const NOTIFICATION = {max: 200, title: 200, body: 2000, levels: ['info', 'success', 'warn', 'error']};

const notificationList = c => c.ctx.get(NOTIFICATIONS, []);
function newNotification(input) {
  const text = (value, label, max, min = 0) => {
    if (typeof value !== 'string' || value.trim().length < min || value.length > max)
      throw bad(`${label} must be text of ${min ? `${min} to ` : 'at most '}${max} characters`);
    return value;
  };
  const level = input.level ?? 'info';
  if (!NOTIFICATION.levels.includes(level)) throw bad(`level is one of ${NOTIFICATION.levels.join(', ')}`);
  if (
    input.href !== undefined &&
    (typeof input.href !== 'string' || !/^\/(?!\/)[A-Za-z0-9_\-/?=&%.]{0,198}$/.test(input.href))
  )
    throw bad('href is a page of the app, like /projects');
  return {
    id: uid(),
    title: text(input.title, 'title', NOTIFICATION.title, 1).trim(),
    body: text(input.body ?? '', 'body', NOTIFICATION.body),
    level,
    href: input.href ?? '',
    source: text(input.source ?? '', 'source', 100),
    created: Date.now() / 1000,
  };
}
route(
  'GET POST DELETE',
  'notifications',
  'List notifications (newest first), post one, or clear them all',
  async c => {
    const items = await notificationList(c);
    if (c.method === 'GET') {
      const limit = Math.min(Math.max(Number(c.query.limit) || 50, 1), NOTIFICATION.max);
      return {total: items.length, items: [...items].reverse().slice(0, limit)};
    }
    if (c.method === 'POST') {
      const item = newNotification(c.body);
      c.ctx.set(NOTIFICATIONS, [...items, item].slice(-NOTIFICATION.max));
      return item;
    }
    c.ctx.set(NOTIFICATIONS, []);
    return {deleted: items.length};
  },
  {
    body: {
      title: 'Backup finished',
      body: 'optional text',
      level: 'info|success|warn|error',
      href: '/projects',
      source: 'optional',
    },
    query: ['limit'],
  }
);
route('DELETE', 'notifications/{id}', 'Delete one notification', async (c, {id}) => {
  const items = await notificationList(c);
  if (!items.some(n => n.id === id)) throw missing('Notification not found');
  c.ctx.set(
    NOTIFICATIONS,
    items.filter(n => n.id !== id)
  );
  return {deleted: id};
});

// ---- routes-collections ----
// Generic JSON collections: a client plugin (or a Script) defines a collection's shape and stores records.
// The server validates the shape and persists the data; it assigns no meaning to fields such as provider or database.

const COLLECTION_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const RECORD_LIMIT = 10000;
const RECORD_SIZE = 1000000;
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const definitionsKey = 'collections';

function checkCollectionSchema(schema, depth = 0) {
  if (depth > 12) throw bad('A collection schema is nested too deeply');
  if (schema === undefined) return {type: 'object'};
  if (!isObject(schema)) throw bad('schema must be an object');
  if (schema.type !== undefined && !SCHEMA_TYPES.has(schema.type))
    throw bad('schema.type must be one of ' + [...SCHEMA_TYPES].join(', '));
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 200))
    throw bad('schema.enum must be a list of at most 200 values');
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) throw bad('schema.properties must be an object');
    if (Object.keys(schema.properties).length > 200) throw bad('A collection has at most 200 fields');
    for (const value of Object.values(schema.properties)) checkCollectionSchema(value, depth + 1);
  }
  if (schema.items !== undefined) checkCollectionSchema(schema.items, depth + 1);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(v => typeof v !== 'string')))
    throw bad('schema.required must be a list of field names');
  return clone(schema);
}

function validateAgainst(schema, value, path = 'data') {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ok =
      schema.type === 'integer'
        ? Number.isInteger(value)
        : schema.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : actual === schema.type;
    if (!ok) return `${path} must be ${schema.type}`;
  }
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value)))
    return `${path} must be one of its allowed values`;
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength)
    return `${path} is longer than ${schema.maxLength} characters`;
  if (Array.isArray(value) && schema.items)
    for (let i = 0; i < value.length; i++) {
      const error = validateAgainst(schema.items, value[i], `${path}[${i}]`);
      if (error) return error;
    }
  if (isObject(value) && schema.properties) {
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) {
        if (schema.additionalProperties === false) return `${path}.${key} is not allowed`;
        continue;
      }
      const error = validateAgainst(schema.properties[key], child, `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

async function collectionDefinition(c, name) {
  if (!COLLECTION_NAME.test(name)) throw bad('A collection name is lower-case letters, digits and "-"');
  const definitions = await c.ctx.get(definitionsKey, {});
  if (!Object.hasOwn(definitions, name)) throw missing('Collection not found: ' + name);
  return {definitions, definition: definitions[name]};
}

const recordsKey = name => `collection:${name}`;
const versionOf = record => {
  if (!Number.isSafeInteger(record.version) || record.version < 1)
    throw new ApiError('invalid_storage', 'A stored collection record has an invalid revision.', 500);
  return record.version;
};
const publicRecord = record => ({
  id: record.id,
  data: clone(record.data),
  created: record.created,
  updated: record.updated,
  // The version is what a client sends back as If-Match to make its next write conditional.
  version: versionOf(record),
});

/** The version a conditional write expects (`If-Match` arrives as `if_version`), or null for an unconditional one. */
function expectedVersion(c) {
  const raw = c.query.if_version;
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw bad('if_version must be a positive integer (the record version)');
  return value;
}
function assertVersion(record, expected) {
  if (expected === null) return;
  if (versionOf(record) !== expected)
    throw new ApiError(
      'conflict',
      `The record changed since it was read (version is ${versionOf(record)}, not ${expected}). Read it again and retry.`,
      409
    );
}

route('GET', 'collections', 'List generic JSON collection definitions', async c => {
  const definitions = await c.ctx.get(definitionsKey, {});
  return Object.entries(definitions).map(([name, definition]) => ({
    name,
    ...clone(definition),
  }));
});

route(
  'PUT DELETE',
  'collections/{name}',
  'Define, change or remove a generic JSON collection',
  async (c, {name}) => {
    if (!COLLECTION_NAME.test(name)) throw bad('A collection name is lower-case letters, digits and "-"');
    const definitions = await c.ctx.get(definitionsKey, {});
    if (c.method === 'DELETE') {
      if (!definitions[name]) throw missing('Collection not found');
      if (c.query.force !== '1') {
        const records = await c.ctx.get(recordsKey(name), []);
        if (records.length) throw bad('The collection has records; pass ?force=1 to delete them');
      }
      delete definitions[name];
      c.ctx.set(definitionsKey, definitions);
      await c.ctx.remove(recordsKey(name));
      return {deleted: true, name};
    }
    const title = String(c.body.title || name).slice(0, 120);
    const description = String(c.body.description || '').slice(0, 2000);
    const schema = checkCollectionSchema(c.body.schema ?? {type: 'object'});
    const definition = {title, description, schema, updated: Date.now() / 1000};
    definitions[name] = definition;
    c.ctx.set(definitionsKey, definitions);
    return {name, ...definition};
  },
  {body: {title: 'Providers', description: '', schema: {type: 'object', properties: {}}}}
);

route(
  'GET POST',
  'collections/{name}/records',
  'List or create records in a generic JSON collection',
  async (c, {name}) => {
    const {definition} = await collectionDefinition(c, name);
    const records = await c.ctx.get(recordsKey(name), []);
    if (c.method === 'GET') {
      const offset = Math.max(0, Number(c.query.offset ?? 0) || 0),
        limit = Math.min(500, Math.max(1, Number(c.query.limit ?? 100) || 100)),
        q = String(c.query.q ?? '').toLocaleLowerCase();
      const matching = q
        ? records.filter(record => JSON.stringify(record.data).toLocaleLowerCase().includes(q))
        : records;
      return {
        total: matching.length,
        records: matching.slice(offset, offset + limit).map(publicRecord),
        next_offset: offset + limit < matching.length ? offset + limit : null,
      };
    }
    if (records.length >= RECORD_LIMIT) throw bad('This collection has reached its record limit');
    const data = c.body.data === undefined ? c.body : c.body.data;
    if (!isObject(data)) throw bad('data must be a JSON object');
    const text = JSON.stringify(data);
    if (text.length > RECORD_SIZE) throw bad('A record is at most 1 MB');
    const error = validateAgainst(definition.schema, data);
    if (error) throw bad(error);
    const now = Date.now() / 1000,
      record = {
        id: c.body.id && /^[A-Za-z0-9_-]{1,100}$/.test(c.body.id) ? c.body.id : uid(),
        data,
        created: now,
        updated: now,
        version: 1,
      };
    if (records.some(item => item.id === record.id)) throw bad('A record with that id already exists');
    records.push(record);
    c.ctx.set(recordsKey(name), records);
    return publicRecord(record);
  },
  {query: ['offset', 'limit', 'q'], body: {data: {}}}
);

route(
  'GET PUT DELETE',
  'collections/{name}/records/{record_id}',
  'Read, replace or delete one record in a generic JSON collection',
  async (c, {name, record_id}) => {
    const {definition} = await collectionDefinition(c, name);
    const records = await c.ctx.get(recordsKey(name), []),
      record = records.find(item => item.id === record_id);
    if (!record) throw missing('Record not found');
    if (c.method === 'GET') return publicRecord(record);
    const expected = expectedVersion(c);
    assertVersion(record, expected);
    if (c.method === 'DELETE') {
      c.ctx.set(
        recordsKey(name),
        records.filter(item => item !== record)
      );
      return {deleted: true, id: record.id, version: versionOf(record)};
    }
    const data = c.body.data === undefined ? c.body : c.body.data;
    if (!isObject(data)) throw bad('data must be a JSON object');
    if (JSON.stringify(data).length > RECORD_SIZE) throw bad('A record is at most 1 MB');
    const error = validateAgainst(definition.schema, data);
    if (error) throw bad(error);
    record.data = data;
    record.updated = Date.now() / 1000;
    record.version = versionOf(record) + 1;
    c.ctx.set(recordsKey(name), records);
    return publicRecord(record);
  },
  {
    query: ['if_version'],
    body: {data: {}},
    returns:
      'The record with its version. Send the version back as If-Match (?if_version) to make the next write conditional; a mismatch is 409 conflict.',
  }
);
