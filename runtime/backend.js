'use strict';

// ---- settings ----
// Default keyboard shortcuts and the validation of user-chosen ones.

const DEFAULT_SHORTCUTS = {
  copy: 'Ctrl+KeyC',
  cut: 'Ctrl+KeyX',
  paste: 'Ctrl+KeyV',
  delete: 'Delete',
  dissolve: 'KeyX',
  group: 'Ctrl+KeyG',
  ungroup: 'Ctrl+Alt+KeyG',
  renameGroup: 'F2',
  selectAll: 'Ctrl+KeyA',
  marquee: 'KeyB',
  invertSelection: 'Ctrl+KeyI',
  fit: 'Home',
  zoomIn: 'Equal',
  zoomOut: 'Minus',
  run: 'Ctrl+Enter',
  pan: 'Space',
  multiSelect: 'Shift',
  cancel: 'Escape',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  undo: 'Ctrl+KeyZ',
  redo: 'Ctrl+Shift+KeyZ',
  togglePanel: 'KeyN',
  disable: 'KeyM',
  fold: 'KeyF',
  snap: 'KeyG',
  hints: 'KeyH',
  toolSelect: 'Digit1',
  toolMove: 'Digit2',
  toolPan: 'Digit3',
  toolDelete: 'Digit4',
  toolAdd: 'Digit5',
};
const SHORTCUT_PATTERN =
  /^(?:(?:Ctrl|Alt|Shift|Meta)\+)*(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Left|Right|Up|Down)|Space|Enter|Escape|Delete|Backspace|Home|End|PageUp|PageDown|Equal|Minus|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|Shift|Control|Alt|Meta)$/;
// GRAPH_RANGES and WIRE_STYLE_IDS are shared with the client (runtime/core.js).

function validateShortcuts(value) {
  if (!isObject(value) || Object.keys(value).some(k => !Object.hasOwn(DEFAULT_SHORTCUTS, k)))
    throw bad('Unknown shortcut action');
  for (const binding of Object.values(value)) {
    if (typeof binding !== 'string' || (binding && !SHORTCUT_PATTERN.test(binding)))
      throw bad('Invalid physical-key shortcut');
    const parts = binding.split('+');
    if (parts.length !== new Set(parts).size) throw bad('A modifier cannot occur twice');
  }
  const effective = {...DEFAULT_SHORTCUTS, ...value};
  // Existing custom bindings take precedence over newly introduced tool defaults.
  for (const action of ['toolSelect', 'toolMove', 'toolPan', 'toolDelete', 'toolAdd']) {
    if (!Object.hasOwn(value, action) && Object.entries(value).some(([key, binding]) => key !== action && binding === effective[action]))
      effective[action] = '';
  }
  const used = Object.values(effective)
    .filter(Boolean)
    .map(v =>
      v
        .split('+')
        .map(p => p.replace('Meta', 'Ctrl'))
        .sort()
        .join('+')
    );
  if (used.length !== new Set(used).size) throw bad('Shortcuts must be unique; clear the conflicting binding first');
  return value;
}

/** Validation of the appearance (the style). `base` is what is stored; `style` changes it. */
function validateAppearance(style, base = {}) {
  if (
    !isObject(style) ||
    Object.keys(style).some(
      k =>
        ![
          'font_size',
          'font_family',
          'background',
          'surface',
          'text',
          'accent',
          'effects',
          'animations',
          ...Object.keys(GRAPH_RANGES),
          'wire_style',
        ].includes(k)
    )
  )
    throw bad('Invalid style settings');
  const merged = {...base, ...style};
  if ('font_size' in merged && (!Number.isInteger(merged.font_size) || merged.font_size < 12 || merged.font_size > 22))
    throw bad('Font size must be an integer from 12 to 22');
  if (
    'font_family' in merged &&
    !['system', 'Arial', 'Verdana', 'Georgia', 'Trebuchet MS', 'Courier New'].includes(merged.font_family)
  )
    throw bad('Unsupported interface font');
  for (const k of ['background', 'surface', 'text', 'accent'])
    if (k in merged && (typeof merged[k] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(merged[k])))
      throw bad('Style colors must use #RRGGBB');
  for (const [k, [min, max]] of Object.entries(GRAPH_RANGES))
    if (k in merged && !(Number.isInteger(merged[k]) && merged[k] >= min && merged[k] <= max))
      throw bad(`${k} must be an integer from ${min} to ${max}`);
  if ('wire_style' in merged && !WIRE_STYLE_IDS.includes(merged.wire_style)) throw bad('Unsupported wire style');
  for (const k of ['effects', 'animations'])
    if (k in merged && typeof merged[k] !== 'boolean') throw bad('Style toggles must be booleans');
  return merged;
}

// ---- resources ----
// Library resources are Custom Nodes: validation of a saved node and of an icon.

// Accidental-edit fingerprint, not a package signature or an authorization decision.
function resourceContentChecksum(payload) {
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
    value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' :
      JSON.stringify(value === undefined ? null : value);
  const text = canonical({...payload, plugin: undefined});
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return 'fnv1a-' + hash.toString(16).padStart(8, '0');
}

function validateIcon(value = '') {
  if (
    typeof value !== 'string' ||
    !(
      (value.length <= 30 && /^[a-z0-9_-]*$/i.test(value)) ||
      (value.length <= 100000 && /^data:image\/png;base64,[a-z0-9+/]+=*$/i.test(value)) ||
      (value.length <= 150000 && /^data:image\/svg\+xml,%3C/i.test(value))
    )
  )
    throw bad('The icon must be a name, a PNG image (100000 characters) or an encoded SVG image (150000 characters).');
}
function validateResource(payload) {
  if (!isObject(payload)) throw bad('Invalid payload.');
  checkManifest(payload);
  const bundle = payload.bundle;
  if (!isObject(bundle) || bundle.version !== BUNDLE_VERSION || !Array.isArray(bundle.groups) || !bundle.groups.length)
    throw bad('A Custom Node is a group of nodes.');
  validateIcon(payload.icon ?? '');
  if (typeof (payload.description ?? '') !== 'string' || (payload.description ?? '').length > 2000)
    throw bad('Description must be text of at most 2000 characters.');
  if (typeof (payload.folder ?? '') !== 'string' || (payload.folder ?? '').length > 200)
    throw bad('The group must be text of at most 200 characters.');
  if ('folder' in payload)
    payload.folder = String(payload.folder)
      .split('/')
      .map(p => p.trim())
      .filter(Boolean)
      .join('/');
  if (JSON.stringify(bundle).length > 4000000) throw bad('This Custom Node is too large.');
}

// ---- permissions ----
// CAPABILITY and checkManifest live in runtime/core.js: the editor checks grants before it saves, and the
// server checks them again at the API boundary.
// Every route gets an explicit method -> needs entry. Unknown families are denied to scripts.
function routeNeeds(pattern, method) {
  if (pattern === 'projects/{project_id}/evaluate-node' || pattern.startsWith('projects/{project_id}/execution'))
    return [method === 'GET' ? 'run.read' : 'run.start'];
  if (pattern === 'net') return ['net.fetch:{host}'];
  if (pattern === 'notifications')
    return [method === 'GET' ? 'notifications.read' : method === 'POST' ? 'notifications.write' : 'system.admin'];
  if (/^collections/.test(pattern)) return [method === 'GET' ? 'collections.read' : 'collections.write'];
  if (/^(resources|library)(\/|$)/.test(pattern)) return [method === 'GET' ? 'library.read' : 'library.write'];
  if (/^projects(\/|$)/.test(pattern) || pattern === 'search/nodes')
    return [method === 'GET' ? 'graph.read' : 'graph.write'];
  return ['system.admin'];
}
const allows = (list, capability) =>
  list.some(value => value === capability || (value.endsWith(':*') && capability.startsWith(value.slice(0, -1))));
// An optional server-wide egress allowlist (`AGENTSYS_ALLOW_NET` / `allowedNetHosts`): a pattern may contain `*`.
const NET_ALLOW = typeof AGENTSYS_NET_ALLOW !== 'undefined' && Array.isArray(AGENTSYS_NET_ALLOW) ? AGENTSYS_NET_ALLOW : [];
// A deployment may refuse private, loopback and link-local destinations. The policy is explicitly configured,
// and a project policy can turn it on for its own Scripts (see routes-permissions.js).
const NET_BLOCK_PRIVATE = typeof AGENTSYS_NET_BLOCK_PRIVATE !== 'undefined' && AGENTSYS_NET_BLOCK_PRIVATE === true;
/** Host and port, lower-case, without the trailing root dot: `example.com.` is the same DNS name as `example.com`. */
const normalizeAuthority = value => {
  let text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (text.endsWith('.')) text = text.slice(0, -1);
  text = text.replace(/\.(?=:\d+$)/, '');
  return text;
};
/** The host[:port] a URL resolves to, normalized. */
const authorityOf = value => {
  const url = value instanceof URL ? value : new URL(String(value));
  return normalizeAuthority(url.host);
};
/** A literal IP address (v4 or v6, brackets accepted) or an empty string. */
const literalAddress = hostname => {
  const text = String(hostname || '')
    .trim()
    .replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return text;
  if (/^[0-9a-f:]+$/i.test(text) && text.includes(':')) return text.toLowerCase();
  return '';
};
const ipv4Private = address => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 || // this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments / TEST-NET-1
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved and broadcast
  );
};
/** Private, loopback, link-local, multicast or otherwise non-public destination. */
const privateAddress = address => {
  const text = String(address || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!text) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return ipv4Private(text);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (mapped) return ipv4Private(mapped[1]);
  if (!text.includes(':')) return true; // not an address known here: fail closed
  if (text === '::' || text === '::1') return true;
  const first = text.split(':').find(Boolean) || '';
  const group = parseInt(first || '0', 16);
  return (
    (group & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (group & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (group & 0xff00) === 0xff00 || // multicast
    text.startsWith('2001:db8:') || // documentation
    text.startsWith('64:ff9b:') // NAT64
  );
};
/** `{address, family}` entries for a hostname, or null when the runtime cannot resolve (an older browser). */
const resolveHost = async hostname => {
  if (typeof AGENTSYS_RESOLVE !== 'function') return null;
  const literal = literalAddress(hostname);
  if (literal) return [{address: literal, family: literal.includes(':') ? 6 : 4}];
  return AGENTSYS_RESOLVE(String(hostname).replace(/^\[|\]$/g, ''));
};
/** The address to pin a deny-private request to, or null when any answer is private. */
const publicAddress = async hostname => {
  const addresses = await resolveHost(hostname);
  if (!addresses || !addresses.length || addresses.some(entry => privateAddress(entry.address))) return null;
  return addresses[0].address;
};
const hostMatches = (patterns, host) => {
  if (!Array.isArray(patterns)) return true; // no list: the caller's other layers decide
  const wanted = normalizeAuthority(host);
  return patterns.some(pattern => {
    if (typeof pattern !== 'string' || !pattern) return false;
    const value = normalizeAuthority(pattern);
    if (value === wanted) return true;
    if (!value.includes('*')) return false;
    return new RegExp('^' + value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(wanted);
  });
};
const netHostAllowed = (host, patterns = NET_ALLOW) => !patterns.length || hostMatches(patterns, host);
// Permissions come from the placed instances. Library defaults are copied on placement, never checked at runtime.
const grantedBy = (permissions, capability) => permissions.chain.every(list => allows(list, capability));
async function permissionNeeds(method, path, body) {
  const found = ROUTES.find(r => r.methods.has(method) && r.regex.test(path));
  if (!found) return ['system.admin'];
  const params = Object.fromEntries(
    Object.entries(path.match(found.regex).groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])
  );
  const needs = found.needs[method];
  if (needs.some(need => need.includes('{host}'))) {
    try {
      params.host = authorityOf(body.url);
    } catch {
      throw bad('Invalid network URL');
    }
  }
  return needs.map(need => need.replace(/{(\w+)}/g, (_, k) => params[k] ?? '*'));
}
async function assertScriptPermission(context, method, path, body) {  const step = context.step;
  const permissions = step?.permissions ?? {chain: [[]]};
  const policy = (await DB.get('policy:' + context.project_id)) ?? {allow: ['graph.read']};
  let needs = await permissionNeeds(method, path, body);
  if (method !== 'GET' && path.startsWith('projects/') && decodeURIComponent(path.split('/')[1] || '').startsWith('lib-'))
    needs.push('library.write');
  const usedSecrets = JSON.stringify(body).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g);
  needs = [...needs, ...[...usedSecrets].map(m => 'secrets.use:' + m[1])];
  const denied = needs.find(need => !allows(policy.allow ?? [], need) || !grantedBy(permissions, need));
  if (denied) {
    throw new ApiError('permission_denied', 'Permission denied: ' + denied, 403);
  }
}
/**
 * The capabilities a scoped token (a client plugin) needs for one call. It refines `system.admin` only for the
 * families a plugin may legitimately use (preferences, one named secret, the session probe); everything else that
 * the route table treats as administrative keeps `system.admin`, which no plugin token can hold.
 */
async function scopedNeeds(method, path, body = {}) {
  const needs = await permissionNeeds(method, path, body);
  if (method !== 'GET' && path.startsWith('projects/') && decodeURIComponent(path.split('/')[1] || '').startsWith('lib-'))
    needs.push('library.write');
  const refined = [];
  for (const need of needs) {
    if (need !== 'system.admin') {
      refined.push(need);
      continue;
    }
    if (path === 'settings') {
      refined.push(method === 'GET' ? 'settings.read' : 'settings.write');
      continue;
    }
    const secret = /^secrets\/([A-Za-z0-9_-]+)$/.exec(path);
    if (secret) {
      refined.push('secrets.use:' + secret[1]);
      continue;
    }
    if (path === 'session' && method === 'GET') continue;
    refined.push('system.admin');
  }
  for (const match of JSON.stringify(body ?? {}).matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g))
    if (!refined.includes('secrets.use:' + match[1])) refined.push('secrets.use:' + match[1]);
  return [...new Set(refined)];
}

function quarantineWrite(value) {
  if (!value || typeof value !== 'object') return value;
  if (value.format === TextGraph.FORMAT) {
    return TextGraph.encode(quarantineWrite(TextGraph.decode(value)));
  }
  if (Array.isArray(value)) return value.map(quarantineWrite);
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, quarantineWrite(v)]));
  // Supplied wrappers cannot lend a generated Script trusted Library instance grants.
  if (value.op === 'script' || (value.source && value.interface)) {
    out.grants = ['graph.read'];
  }
  return out;
}
// Script writes must apply the same policy at the API boundary.
function quarantineRequest(path, body) {
  const out = quarantineWrite(body);
  if (path === 'resources' || (path.startsWith('resources/') && out.payload))
    out.payload = {...out.payload, grants: ['graph.read']};
  if (out.config) out.config = {...out.config, grants: ['graph.read']};
  return out;
}
async function injectSecrets(value) {
  if (typeof value === 'string') {
    const matches = [...value.matchAll(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g)];
    for (const m of matches) {
      const secret = await DB.get('secrets/' + m[1]);
      if (!secret) throw missing('Secret not found: ' + m[1]);
      value = value.replaceAll(m[0], secret.value);
    }
    return value;
  }
  if (Array.isArray(value)) return Promise.all(value.map(injectSecrets));
  if (isObject(value))
    return Object.fromEntries(
      await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await injectSecrets(v)]))
    );
  return value;
}
const redactText = value =>
  String(value)
    .replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|token)[\"']?\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
function stripSecrets(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !/^(api[_-]?key|headers|password|secret|token|authorization|cookie|set-cookie)$/i.test(k))
      .map(([k, v]) => [k, stripSecrets(v)])
  );
}

// ---- scripts ----
// One isolated JavaScript host belongs to each live workflow.
function displayText(values) {
  return values.map(displayPart).join('\u001e');
}
function displayPart(value) {
  if (
    value &&
    typeof value === 'object' &&
    /^image\/(png|jpeg|gif|webp)$/.test(value.mime_type) &&
    typeof value.data === 'string'
  ) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw Error('Image data must be base64');
    return 'data:' + value.mime_type + ';base64,' + value.data;
  }
  return String(typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? value)).replaceAll(
    '\u001e',
    ' '
  );
}
const WORKER_FREEZE = `// Freeze the intrinsics the executor shares with node code: replacing Map.get, Promise
// or JSON must not let a Script impersonate a different invocation at the host bridge.
for (const name of ['Object','Array','Map','Set','WeakMap','WeakSet','Proxy','Reflect','Promise','Date','RegExp','String','Number','Boolean','Function','Error','TypeError','Uint8Array','ArrayBuffer','JSON','Math']) {
  const value=globalThis[name]; if(value?.prototype)Object.freeze(value.prototype);Object.freeze(value);
  if(!['Date','Math'].includes(name))Object.defineProperty(globalThis,name,{value,writable:false,configurable:false});
}
`;
const WORKER_BLOCKED = [
  'fetch',
  'importScripts',
  'Worker',
  'SharedWorker',
  'WebSocket',
  'WebSocketStream',
  'WebTransport',
  'RTCPeerConnection',
  'XMLHttpRequest',
  'EventSource',
  'navigator',
  'indexedDB',
  'caches',
  'Cache',
  'BroadcastChannel',
  'MessageChannel',
  'postMessage',
  'close',
  'process',
  'require',
  'onmessage',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'MessageEvent',
  'crypto',
  'performance',
  'Date',
  'Math',
];
const workerBlock = names => `const blocked = ${JSON.stringify(names)};
for (let object=globalThis; object && object!==Object.prototype; object=Object.getPrototypeOf(object)) {
  for(const name of blocked){
    const descriptor=Object.getOwnPropertyDescriptor(object,name);
    if(object===globalThis||descriptor?.configurable)Object.defineProperty(object,name,{value:undefined,writable:false,configurable:false});
    else if(descriptor&&descriptor.value!==undefined)throw new Error('Cannot isolate Worker API: '+name);
  }
}
`;

const GRAPH_WORKER_SOURCE = `
(() => {
const send=globalThis.postMessage.bind(globalThis),Date=globalThis.Date,Math=globalThis.Math;
${WORKER_FREEZE}
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
${displayPart}
${displayText}
${resolvePort}
${createGraphView}
${createGraphInterpreter}
const pending=new Map(),gate={paused:false,waiters:[]};let serial=0,runtime;
const call=(node,...args)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});send({type:'call',id,node,args});});
const receive=async({data})=>{
  if(data.type==='reply'){
    const item=pending.get(data.id);if(!item)return;pending.delete(data.id);
    return data.error?item.reject(Object.assign(new Error(data.error),{code:data.code})):item.resolve(data.result);
  }
  try{let result=null;
    if(data.type==='init'){
      gate.paused=data.paused===true;
      runtime=createGraphInterpreter(data.graph,data.saved,{AsyncFunction,displayText,call,gate,context:data.context,emit:event=>send({type:'event',event})});
    }else if(data.type==='update')runtime.update(data.graph);
    else if(data.type==='pause'){
      runtime?.flush?.();
      gate.paused=data.paused;
      if(!gate.paused)gate.waiters.splice(0).forEach(wake=>wake());
    }else if(data.type==='signal')result=await runtime.signal(data.nodes,data.event);
    runtime?.flush?.();
    send({type:'result',id:data.id,result});
  }catch(error){send({type:'result',id:data.id,error:String(error?.message??error),code:error?.code});}
};
globalThis.addEventListener?.('message',receive);
${workerBlock(WORKER_BLOCKED)}
return text=>receive({data:JSON.parse(text)});
})();`;
const workerURLs = new Map();
function startSourceWorker(source) {
  if (typeof AGENTSYS_SPAWN_WORKER === 'function') return AGENTSYS_SPAWN_WORKER(source);
  if (!workerURLs.has(source))
    workerURLs.set(source, URL.createObjectURL(new Blob([source], {type: 'text/javascript'})));
  return new Worker(workerURLs.get(source));
}
const liveBridgeFor = context => ({
  request: async ([method, path, body, query]) => {
    method = String(method).toUpperCase();
    path = String(path)
      .replace(/^\/?(api\/)?/, '')
      .replace(/\/+$/, '');
    body = {...(body ?? {})};
    query = {...(query ?? {})};
    if (context.workflow_id && path.startsWith(`projects/${context.project_id}/`)) {
      if (method === 'GET' || method === 'DELETE') query.workflow_id ??= context.workflow_id;
      else body.workflow_id ??= context.workflow_id;
    }
    await assertScriptPermission(context, method, path, body);
    if (method !== 'GET') body = quarantineRequest(path, body);
    if (context.signal?.aborted) throw new Error('Execution stopped');
    return stripSecrets(await Backend.request(method, path, {body, query, scriptContext: context}));
  },
});

function scriptCallContext(graph, context, id, signal) {
  const node = createGraphView(graph, {context}).get(id);
  if (!node) throw missing('Script no longer belongs to this graph');
  return {
    ...context,
    node_id: id,
    signal,
    step: {permissions: {chain: node.context?.grant_chain?.length ? node.context.grant_chain : [node.grants ?? []]}},
  };
}
function createScriptHost(graph, saved, options) {
  const {context, onEvent, signal, paused = false, onFailure} = options;
  if (!canStartGraphWorker()) return createInlineGraphHost(graph, saved, options);
  const worker = startSourceWorker(GRAPH_WORKER_SOURCE),
    pending = new Map();
  let current = graph,
    sequence = 0,
    closed = false;
  const request = (type, body = {}) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(Error('Graph work stopped'));
      const id = ++sequence;
      pending.set(id, {resolve, reject});
      worker.ref?.();
      worker.postMessage({type, id, ...body});
    });
  const close = (error = Error('Graph work stopped')) => {
    if (closed) return;
    closed = true;
    worker.terminate();
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  worker.onerror = event => {
    close(Error(event.message || 'Graph host failed'));
    onFailure?.();
  };
  worker.onmessage = async ({data}) => {
    if (closed) return;
    if (data.type === 'event') {
      onEvent(data.event);
      return;
    }
    if (data.type === 'call') {
      let reply;
      try {
        const result = await liveBridgeFor(scriptCallContext(current, context, data.node, signal)).request(data.args);
        reply = {type: 'reply', id: data.id, result};
      } catch (error) {
        reply = {type: 'reply', id: data.id, error: error.message, code: error.code};
      }
      if (!closed) worker.postMessage(reply);
      return;
    }
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    if (!pending.size) worker.unref?.();
    data.error ? item.reject(Object.assign(Error(data.error), {code: data.code})) : item.resolve(data.result);
  };
  const ready = request('init', {graph, saved, context, paused});
  return {
    ready,
    close,
    async update(graph) {
      current = graph;
      await ready;
      return request('update', {graph});
    },
    async pause(paused) {
      await ready;
      return request('pause', {paused});
    },
    async signal(nodes, event) {
      await ready;
      return request('signal', {nodes, event});
    },
  };
}
const canStartGraphWorker = () => typeof AGENTSYS_SPAWN_WORKER === 'function' || typeof Worker === 'function';
function createInlineGraphHost(graph, saved, {context, onEvent, signal, paused = false}) {
  const gate = {paused, waiters: []};
  let current = graph,
    closed = false;
  const runtime = createGraphInterpreter(graph, saved, {
    AsyncFunction: Object.getPrototypeOf(async function () {}).constructor,
    displayText,
    gate,
    context,
    closed: () => closed,
    emit: event => {
      if (!closed) onEvent(event);
    },
    call: (id, ...args) => liveBridgeFor(scriptCallContext(current, context, id, signal)).request(args),
  });
  return {
    ready: Promise.resolve(),
    update(graph) {
      current = graph;
      runtime.update(graph);
      return Promise.resolve();
    },
    pause(paused) {
      runtime.flush();
      gate.paused = paused;
      if (!paused) gate.waiters.splice(0).forEach(wake => wake());
      return Promise.resolve();
    },
    signal: (nodes, event) => {
      const work = runtime.signal(nodes, event);
      if (!signal) return work;
      return new Promise((resolve, reject) => {
        const abort = () => reject(Error('Graph work stopped'));
        signal.addEventListener('abort', abort, {once: true});
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    },
    close() {
      runtime.flush();
      closed = true;
      gate.paused = false;
      gate.waiters.splice(0).forEach(wake => wake());
    },
  };
}

// ---- runtime ----
// Server application service: route table, request contexts, serialized mutations and per-client undo history.
// HTTP and checked Script calls both use Backend.request(); routes live in routes-*.js.

// ----- request plumbing -----
const ROUTES = [];
function route(methods, pattern, summary, handler, options = {}) {
  ROUTES.push({
    methods: new Set(methods.split(' ')),
    pattern,
    summary,
    handler,
    regex: new RegExp('^' + pattern.replace(/{(\w+)}/g, '(?<$1>[^/]+)') + '$'),
    ...options,
    needs: options.needs ?? Object.fromEntries(methods.split(' ').map(method => [method, routeNeeds(pattern, method)])),
  });
}
const EDITS = new Set([
  'batch',
  'available-nodes',
  'custom-nodes',
  'typed-nodes',
  'primitives',
  'widgets',
  'widget-values',
  'output-values',
  'node-slots',
  'port-connections',
  'split-connections',
  'complex',
  'layout',
  'groups',
  'paste',
  'import-graph',
  'node-style',
  'node-title',
  'input-values',
  'types',
  'node-permissions',
  'nodes',
  'delete-nodes',
]);
const histories = new Map();
const HISTORY_LIMIT = 2000; // client+workflow stacks are in memory; a scripted client cannot grow them without bound
// Undo belongs to the client that made the edit: two tabs sharing one stack would undo each other's work.
const historyOwner = client => client || 'default';
const historyKey = (id, client) => historyOwner(client) + '\u0000' + id;
const historyOf = (id, client) => {
  const key = historyKey(id, client);
  if (!histories.has(key)) {
    while (histories.size >= HISTORY_LIMIT) histories.delete(histories.keys().next().value);
    histories.set(key, {undo: [], redo: []});
  }
  return histories.get(key);
};
/** Drops every other client's undo stack for one workflow: their next undo would revert work they never saw. */
const clearOtherHistories = (id, keep) => {
  const owner = historyOwner(keep);
  for (const key of [...histories.keys()]) {
    const cut = key.indexOf('\u0000');
    if (key.slice(cut + 1) === id && key.slice(0, cut) !== owner) histories.delete(key);
  }
};
const clearHistories = id => {
  for (const key of [...histories.keys()]) if (key.slice(key.indexOf('\u0000') + 1) === id) histories.delete(key);
};
DB.subscribe(keys => {
  for (const key of keys) if (key.startsWith('wf:')) clearHistories(key.slice(3));
});

let queue = Promise.resolve();
let backendClosing = false;
const exclusive = work => {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
};

// ----- on_placed / on_deleted / on_input_connected / on_widget: the event nodes of a Library node, fired when a copy is added, removed, rewired or used -----
const HOOKS = {pending: new Set(), log: [], listeners: new Set()};
const MAX_HOOK_LOG = 200;
function noteHook(entry) {
  HOOKS.log.push(entry);
  if (HOOKS.log.length > MAX_HOOK_LOG) HOOKS.log.splice(0, HOOKS.log.length - MAX_HOOK_LOG);
  if (entry.ok) return;
  if (HOOKS.listeners.size) for (const listener of HOOKS.listeners) listener(entry);
  else console.warn(`[agentsys] ${entry.hook} of ${entry.node_id} failed: ${entry.error}`);
}
function runHooks(events) {
  for (const event of events) {
    const entry = {
      at: Date.now() / 1000,
      hook: event.hook,
      node_id: event.node_id,
      project_id: event.project_id,
      workflow_id: event.workflow_id,
      ok: true,
      error: null,
      ms: 0,
    };
    const work = Promise.resolve()
      .then(async () => {
        const started = Date.now();
        try {
          const result = await dispatchGraphEvent(
            event.project_id,
            event.workflow_id,
            event.hook,
            event.group,
            event.data,
            event.removed
          );
          if (Object.keys(result.errors).length) throw new Error(Object.values(result.errors)[0]);
          DB.announce(['wf:' + event.workflow_id]); // the code may have edited the workflow: open editors reload it
        } catch (error) {
          Object.assign(entry, {ok: false, error: error.message || String(error)});
        }
        entry.ms = Date.now() - started;
        noteHook(entry);
      })
      .finally(() => HOOKS.pending.delete(work));
    HOOKS.pending.add(work);
  }
}

class Call {
  constructor(method, body, query, edit, client = null) {
    Object.assign(this, {
      method,
      body,
      query,
      edit,
      client,
      ctx: new Context(),
      docs: new Map(),
      hookEvents: [],
      widgetEvents: [],
      editedNodes: new Set(),
      libraryTouched: false,
    });
    this.workflowId = body.workflow_id || query.workflow_id || null;
  }
  async projects() {
    return this.ctx.get('projects', []);
  }
  /** `manage`: the project is about to be changed, renamed or deleted, which only the user's own projects allow. */
  async project(id, manage = false) {
    // A Library node being edited is a private workflow of its own, not a project of the user.
    if (String(id).startsWith('lib-')) {
      if (manage) throw bad('A Custom Node is managed in the Library, not as a project');
      const item = (await this.ctx.get('resources', [])).find(r => r.id === id.slice(4));
      return {
        id,
        name: item?.name ?? 'New Custom Node',
        workflows: [{id, name: 'Node', created: 0}],
        library: id.slice(4),
      };
    }
    const project = (await this.projects()).find(p => p.id === id);
    if (!project) throw missing('Record not found');
    return project;
  }
  /** The project, one of its workflows and an editor on a private copy of that workflow's document. */
  async workflow(projectId, workflowId = this.workflowId) {
    if (String(projectId).startsWith('lib-') && this.method !== 'GET')
      await this.requireDeveloper('Editing a Custom Node');
    const project = await this.project(projectId);
    const meta = workflowId ? project.workflows.find(w => w.id === workflowId) : project.workflows[0];
    if (!meta) throw missing('Record not found');
    const doc = await this.ctx.get('wf:' + meta.id, emptyDoc());
    // The types of the workflow are the Library's and its own, one list while it is open (and stored as the workflow's own only).
    if (!this.docs.has(meta.id)) {
      const {types, absorbed, changed} = unifyTypes(await this.libraryTypes(), doc.types);
      doc.types = types;
      if (absorbed.size) new Editor(project, meta, doc).retype(absorbed);
      if (changed) this.refreshed = true; // a read that brought something up to date stores it
    }
    await this.refreshInstances(project, meta, doc);
    if (!this.docs.has(meta.id)) {
      // `if_cursor` makes an edit conditional: it only applies if nobody changed the workflow since it was read
      // (the snapshot's `cursor`). Over HTTP this is the If-Match header.
      const expected = this.query.if_cursor;
      if (this.method !== 'GET' && expected !== undefined && expected !== '' && Number(expected) !== (doc.cursor || 0))
        throw new ApiError(
          'conflict',
          `The workflow changed since it was read (cursor is ${doc.cursor || 0}, not ${expected}). Read it again and retry.`,
          409
        );
      this.docs.set(meta.id, {doc, before: JSON.stringify(stateOf(doc)), project: project.id});
    }
    const editor = new Editor(project, meta, doc);
    return {project, meta, doc, editor};
  }
  /** The types of the Library: [{id, name, color?, fields, control?, options?, alias?, library: true}]. They are made by the Custom Nodes (see reconcileLibraryTypes). */
  async libraryTypes() {
    return (await this.ctx.get('library_types', [])).map(libraryType);
  }
  /** Whether a workflow or the editor of a Custom Node mentions the Library type `id`. */
  async typeInUse(id) {
    // The used ids are collected once per request: the caller checks many types against the same data.
    if (!this.usedTypes) {
      const used = new Set();
      const collect = value => {
        for (const match of JSON.stringify(value ?? null).matchAll(/"t:([A-Za-z0-9_-]+)"/g)) used.add(match[1]);
      };
      for (const project of await this.projects())
        for (const wf of project.workflows) collect(await this.ctx.get('wf:' + wf.id, emptyDoc()));
      for (const r of await this.ctx.get('resources', [])) collect(await this.ctx.get('wf:lib-' + r.id, null));
      this.usedTypes = used;
    }
    return this.usedTypes.has(id);
  }
  /**
   * The types of the Library are the types the Custom Nodes define, kept once, in one list. After the Library's nodes changed (saved by the
   * editor, imported, duplicated, deleted):
   * - a type a node defines that the Library does not have yet is added (a type with the name and shape of one it has is that type, and
   *   a name that is taken by another shape is changed, in the node);
   * - a type the node being edited changed is changed for everybody (the other nodes carry the new definition);
   * - a node carries the definition of every type it uses, so it stands alone;
   * - a type no node defines and no workflow uses is removed.
   */
  async reconcileLibraryTypes() {
    const resources = await this.ctx.get('resources', []),
      nodes = resources
        .filter(r => Array.isArray(r.payload.bundle?.types))
        .sort((a, b) => Number(this.editedNodes.has(b.id)) - Number(this.editedNodes.has(a.id))),
      stored = await this.ctx.get('library_types', []),
      lib = clone(stored);
    const canon = t =>
      JSON.stringify([t.name, t.color ?? null, t.fields, t.control ?? null, t.options ?? null, t.alias ?? null]);
    // What the node that was edited says of its types is the truth.
    for (const r of nodes)
      if (this.editedNodes.has(r.id))
        for (const t of r.payload.bundle.types) {
          const i = lib.findIndex(x => x.id === t.id);
          if (i >= 0 && canon(lib[i]) !== canon(t)) lib[i] = plainType(t);
        }
    const changedNodes = [];
    for (const r of nodes) {
      const before = JSON.stringify(r.payload.bundle),
        {types, absorbed} = unifyTypes(lib, r.payload.bundle.types);
      let text = before;
      for (const [from, to] of absorbed) text = text.split(from).join(to);
      const bundle = JSON.parse(text),
        names = new Map(types.map(t => [t.id, t.name])),
        libIds = new Set(lib.map(t => t.id)),
        uses = new Set([...bundle.types.map(t => t.id).filter(id => libIds.has(id)), ...absorbed.values()]);
      const own = bundle.types.filter(t => !libIds.has(t.id)).map(t => ({...t, name: names.get(t.id) ?? t.name}));
      lib.push(...own.map(plainType));
      // Every type a Library type is made of goes along as well.
      for (let more = true; more; ) {
        more = false;
        for (const id of [...uses, ...own.map(t => t.id)]) {
          const t = lib.find(x => x.id === id);
          for (const ref of t ? [...typeRefs(t.alias), ...t.fields.flatMap(f => typeRefs(f.type))] : [])
            if (lib.some(x => x.id === ref) && !uses.has(ref) && !own.some(o => o.id === ref)) {
              uses.add(ref);
              more = true;
            }
        }
      }
      bundle.types = [...uses].map(id => plainType(lib.find(x => x.id === id))).concat(own.map(plainType));
      if (JSON.stringify(bundle) !== before) {
        r.payload.bundle = bundle;
        if (absorbed.size) r.updated = Date.now() / 1000; // its IDs changed: the copies on canvases follow
        changedNodes.push(r);
      }
    }
    // A type nobody needs goes.
    const needed = new Set(nodes.flatMap(r => r.payload.bundle.types.map(t => t.id)));
    const idle = lib.filter(t => !needed.has(t.id));
    for (const t of idle) if (await this.typeInUse(t.id)) needed.add(t.id);
    for (let more = true; more; ) {
      more = false;
      for (const t of lib)
        if (needed.has(t.id))
          for (const ref of [...typeRefs(t.alias), ...t.fields.flatMap(f => typeRefs(f.type))])
            if (!needed.has(ref)) {
              needed.add(ref);
              more = true;
            }
    }
    const next = lib
      .filter(t => needed.has(t.id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));
    checkTypes(next.map(t => ({...t})));
    if (JSON.stringify(next) !== JSON.stringify(stored)) this.ctx.set('library_types', next);
    if (changedNodes.length) this.ctx.set('resources', resources);
    // A type of an open workflow that is the Library's now is no longer its own.
    const ids = new Set(next.map(t => t.id));
    for (const {doc} of this.docs.values()) doc.types = (doc.types || []).filter(t => t.library || !ids.has(t.id));
  }
  /** Placed Library nodes follow their definition: when it was saved again, their contents are replaced. */
  async refreshInstances(project, meta, doc) {
    const ids = doc.complex.filter(c => c.source).map(c => c.id);
    if (!ids.length) return;
    const resources = await this.ctx.get('resources', []),
      editor = new Editor(project, meta, doc);
    const nested = id => {
      const parent = new Map(doc.groups.map(g => [g.id, g.parent]));
      for (let p = parent.get(id); p; p = parent.get(p)) if (doc.complex.some(x => x.id === p && x.source)) return true;
      return false;
    };
    for (const id of ids) {
      const stored = doc.complex.find(c => c.id === id),
        item = stored && resources.find(r => r.id === stored.source.resource_id);
      if (!item || item.updated === stored.source.stamp || nested(id)) continue;
      const backup = clone(doc);
      try {
        delete stored.refresh_error;
        editor.refreshInstance(id, clone(item.payload.bundle), {resource_id: item.id, stamp: item.updated});
        this.refreshed = true; // the copy is new (its nodes have new IDs): it is stored by whatever request found it out of date, even a read
      } catch (error) {
        Object.assign(doc, backup);
        // A broken definition has no executable last-valid fallback. Keep the wrapper and its external
        // interface for diagnosis, remove the obsolete implementation, and retry on the next definition.
        const snapshot = editor.snapshot(),
          cx = snapshot.complex.find(c => c.id === id);
        editor.deleteNodes(cx.members.filter(member => !member.startsWith('complex:')));
        const current = doc.complex.find(c => c.id === id);
        current.source.stamp = item.updated;
        current.refresh_error = 'Library update failed: ' + String(error.message).slice(0, 1000);
        this.refreshed = true;
      }
    }
  }
  /** Making or changing Custom nodes by hand is for developers: the Settings switch must be on. */
  async requireDeveloper(what) {
    if (!(await this.prefs()).developer_mode)
      throw new ApiError('developer_mode_required', `${what} needs developer mode (Settings > Developer mode)`, 403);
  }
  async prefs() {
    return this.ctx.get('prefs', {});
  }
  /** The Custom Node being edited is saved to the Library after every change, like a workflow. */
  async syncLibraryNode(id, doc) {
    const resources = await this.ctx.get('resources', []),
      item = resources.find(r => r.id === id.slice(4));
    if (!item) return;
    try {
      const project = await this.project(id),
        editor = new Editor(project, project.workflows[0], doc),
        root = editor.snapshot().groups.find(g => g.id === doc.root);
      if (!root || !root.has_complex) return;
      const bundle = editor.copy([], [root.id]),
        name =
          String(root.name || item.name)
            .trim()
            .slice(0, 100) || item.name;
      validateResource({...item.payload, bundle});
      const taken = resources.some(r => r.id !== item.id && r.name === name);
      Object.assign(item, {
        name: taken ? item.name : name,
        payload: {...item.payload, bundle},
        updated: Date.now() / 1000,
      });
      if (this.scriptContext) {
        item.payload.grants = ['graph.read'];
      }
      // The size of the main group's frame is remembered, relative to the nodes inside it.
      const frame = doc.layout['group:' + doc.root],
        spots = doc.nodes.map(n => doc.layout[n.id]).filter(Boolean);
      if (frame) {
        const x0 = spots.length ? Math.min(...spots.map(s => s.x)) : 0,
          y0 = spots.length ? Math.min(...spots.map(s => s.y)) : 0;
        item.payload.frame = {dx: frame.x - x0, dy: frame.y - y0, width: frame.width, height: frame.height};
      }
      this.ctx.set('resources', resources);
      this.editedNodes.add(item.id);
      this.libraryTouched = true;
    } catch {
      /* a half-built node is kept in the editor and saved once it is valid */
    }
  }
  /**
   * on_placed, on_deleted, on_input_connected and on_widget: the copies of Library nodes that are in this workflow now but were not before
   * (placed, pasted, created by a script, brought back by redo), the ones that were and are gone, copies whose wired inputs
   * changed, and the widgets a person used. For each, the event nodes of that kind inside the copy fire (see hookPlan), and the graph
   * does the rest. Comparing the two documents means every way of adding or removing a node is covered, and nothing else is:
   * moving, editing or refreshing a copy is not. A copy without event nodes of the kind runs nothing.
   */
  async collectHooks(project, workflow, doc, before) {
    const was = JSON.parse(before),
      copies = state => new Map(state.complex.filter(c => c.source).map(c => [c.id, c]));
    const old = copies(was),
      now = copies(doc),
      context = {project_id: project, workflow_id: workflow};
    const snapshots = new Map();
    const snapshotOf = state => {
      if (!snapshots.has(state))
        snapshots.set(state, buildSnapshot({id: project}, {id: workflow, name: ''}, state, false));
      return snapshots.get(state);
    };
    const event = (hook, group, state, data) => {
      const graph = snapshotOf(state),
        view = createGraphView(graph, {context});
      if (view.values().some(node => node.op === hook && view.scopes.get(node.id)?.group === group))
        this.hookEvents.push({
          hook,
          group,
          data,
          project_id: project,
          workflow_id: workflow,
          node_id: 'complex:' + group,
          ...(hook === 'on_deleted' ? {removed: graph} : {}),
        });
    };
    for (const id of now.keys()) if (!old.has(id)) event('on_placed', id, doc, {});
    for (const id of old.keys()) if (!now.has(id)) event('on_deleted', id, was, {});
    // on_input_connected: a copy whose wired inputs are not the ones they were.
    const wiredIds = (state, id) =>
      state.port_edges
        .filter(e => e.target === 'complex:' + id)
        .map(e => e.target_port)
        .sort();
    for (const [id, c] of now) {
      const ids = wiredIds(doc, id);
      const sources = state =>
        state.port_edges
          .filter(e => e.target === 'complex:' + id)
          .map(e => JSON.stringify([e.target_port, e.source, e.source_port]))
          .sort();
      if (!old.has(id) || JSON.stringify(sources(doc)) === JSON.stringify(sources(was))) continue;
      event('on_input_connected', id, doc, {
        connected: ids.map(pid => c.interface.inputs.find(p => p.id === pid)?.name ?? pid),
      });
    }
    // on_widget: one call for each widget a person changed, on every Library node copy around the node that has the widget.
    const around = nodeId => {
      const found = [];
      for (let g = doc.groups.find(x => x.members.includes(nodeId)); g; g = doc.groups.find(x => x.id === g.parent))
        if (now.has(g.id)) found.push(g);
      return found;
    };
    for (const {node_id, widget_id} of this.widgetEvents) {
      const widget = doc.widgets[node_id]?.find(w => w.id === widget_id);
      if (widget)
        for (const group of around(node_id))
          event('on_widget', group.id, doc, {
            widget: {id: widget.id, kind: widget.kind, label: widget.label, value: widget.value},
          });
    }
  }
  /** Records undo history and bumps the change cursor of every workflow this call modified. */
  async finish(action) {
    for (const [id, {doc, before, project}] of this.docs) {
      if (doc.root) new Editor({id: 'lib-' + id}, {id}, doc).adoptIntoRoot();
      const after = JSON.stringify(stateOf(doc));
      if (after === before) continue;
      this.docs.get(id).presentationOnly = semanticKey(JSON.parse(before)) === semanticKey(stateOf(doc));
      await this.collectHooks(project, id, doc, before);
      doc.cursor = (doc.cursor || 0) + 1;
      if (id.startsWith('lib-')) await this.syncLibraryNode(id, doc);
      if (!EDITS.has(action)) continue;
      const history = historyOf(id, this.client),
        limit = (await this.prefs()).undo_steps ?? 50,
        branched = history.redo.length > 0;
      history.redo = [];
      clearOtherHistories(id, this.client);
      if (!limit) continue;
      const last = history.undo.at(-1);
      if (!branched && last && this.edit && this.edit === last.token) continue;
      history.undo.push({before, after: null, action, token: this.edit || null});
      while (history.undo.length > limit) history.undo.shift();
    }
    if (this.libraryTouched) await this.reconcileLibraryTypes();
    // What a workflow stores of the Library's types is nothing: they are read from the Library.
    for (const {doc} of this.docs.values()) doc.types = ownTypes(doc.types);
  }
}

const Backend = {
  /** Resolves with the parsed result or throws an ApiError. */
  async request(method, path, {body = {}, query = {}, edit = null, scriptContext = null, client = null, pluginIdentity = null} = {}) {
    path = path.replace(/^\/+|\/+$/g, '');
    const found = ROUTES.find(r => r.methods.has(method) && r.regex.test(path));
    if (!found) {
      // A known path with another method is a 405 with the methods it does accept, not a 404.
      const allowed = [...new Set(ROUTES.filter(r => r.regex.test(path)).flatMap(r => [...r.methods]))];
      if (allowed.length) {
        const error = new ApiError('method_not_allowed', `Use ${allowed.join(', ')} for /${path}`, 405);
        error.allow = allowed.join(', ');
        throw error;
      }
      throw missing('API endpoint not found');
    }
    const params = Object.fromEntries(
      Object.entries(path.match(found.regex).groups || {}).map(([k, v]) => {
        let value;
        try {
          value = decodeURIComponent(v);
        } catch {
          throw bad('Invalid path escape');
        }
        if (/[\\/\0]/.test(value) || value === '.' || value === '..') throw bad('Invalid path component');
        return [k, value];
      })
    );
    const call = new Call(method, body ?? {}, query ?? {}, edit, client);
    call.scriptContext = scriptContext;
    // Stop aborts the signal of a Script: its API calls neither start nor save after that.
    const running = () => {
      if (backendClosing) throw new ApiError('server_closing', 'The server is shutting down', 503);
      if (scriptContext?.signal?.aborted) throw bad('Execution stopped');
    };
    running();
    if (found.unlocked) return found.handler(call, params);
    const result = await exclusive(async () => {
      running();
      // Identity comes from the server's credential map, never from request JSON. Check inside the writer lock.
      if (pluginIdentity && method !== 'GET') {
        const refuseOwner = () => { throw new ApiError('permission_denied', 'This plugin may only change its own Library resources.', 403); };
        const resources = await call.ctx.get('resources', []);
        const resourceId = params.resource_id || body?.resource_id ||
          (String(params.project_id || '').startsWith('lib-') ? params.project_id.slice(4) : null);
        const existing = resourceId && resources.find(item => item.id === resourceId);
        if (existing && (!pluginIdentity.id || existing.payload?.plugin?.id !== pluginIdentity.id)) refuseOwner();
        if (path === 'library/node-folders') refuseOwner(); // bulk operations can affect several owners
        if (path === 'library/script-nodes' || path === 'resources' || /^resources\//.test(path)) {
          if (!pluginIdentity.id) refuseOwner();
          const tag = path === 'library/script-nodes' ? body.plugin : body.payload?.plugin;
          if (tag?.id && tag.id !== pluginIdentity.id) refuseOwner();
          if (method !== 'DELETE') {
            if (path === 'library/script-nodes') body.plugin = {...tag, id: pluginIdentity.id};
            else if (body.payload) body.payload.plugin = {...tag, id: pluginIdentity.id};
          }
        }
      }
      const result = await found.handler(call, params);
      if (method !== 'GET') await call.finish(found.pattern.split('/')[2] || found.pattern.split('/')[0]);
      // A read that found something to bring up to date (a copy of a Library node, a type) stores it.
      if (method === 'GET' && call.refreshed) for (const {doc} of call.docs.values()) doc.types = ownTypes(doc.types);
      running();
      if (method !== 'GET' || call.refreshed) await call.ctx.commit();
      // The live interpreter follows a document only when it changed in a way it can observe (not a move or a colour),
      // and only if one is running for it.
      if (method !== 'GET' || call.refreshed)
        for (const [id, {doc, project, presentationOnly}] of call.docs) {
          if (presentationOnly || !GRAPH_RUNTIMES.has(id)) continue;
          const types = [...(await call.libraryTypes()), ...ownTypes(doc.types)];
          syncRuntimeGraph(id, buildSnapshot({id: project}, {id, name: ''}, {...doc, types}, false));
        }
      return result;
    });
    if (call.libraryTouched) {
      for (const entry of GRAPH_RUNTIMES.values())
        if (!call.docs.has(entry.workflow)) {
          const refresh = new Call('GET', {}, {workflow_id: entry.workflow}, null);
          await exclusive(async () => {
            const {editor} = await refresh.workflow(entry.project),
              document = editor.snapshot();
            for (const {doc} of refresh.docs.values()) doc.types = ownTypes(doc.types);
            await refresh.ctx.commit();
            syncRuntimeGraph(entry.workflow, document);
          });
          DB.announce(['wf:' + entry.workflow]);
        }
    }
    // Event handlers run after the edit is saved and the writer lock is free.
    runHooks(call.hookEvents);
    return result;
  },
  /** Called with a log entry whenever hook code (on_placed, on_deleted, on_input_connected, on_widget) fails. Returns the function that stops listening. */
  subscribeHooks(listener) {
    HOOKS.listeners.add(listener);
    return () => HOOKS.listeners.delete(listener);
  },
  /** Resolves when no hook code is running or waiting (for tests and programs that must see its effects). */
  async hooksIdle() {
    while (HOOKS.pending.size) await Promise.allSettled([...HOOKS.pending]);
  },
  subscribe(listener, options) {
    return DB.subscribe(listener, options);
  },
  async shutdownExecutions() {
    await Promise.all([...GRAPH_RUNTIMES.keys()].map(stopGraph));
  },
  /** Terminal shutdown: prevent new/queued commits, drain writers and hooks, then finish runtime cleanup. */
  async close() {
    backendClosing = true;
    await this.shutdownExecutions();
    await queue;
    await this.hooksIdle();
    await this.shutdownExecutions();
  },
  get persistent() {
    return DB.persistent;
  },
  get storage() {
    return {mode: DB.mode, directory: DB.directory};
  },
  /** A read-only server diagnostics snapshot: counts and the states of live runtimes, never workflow data or secrets. */
  diagnostics() {
    const runtimes = [...GRAPH_RUNTIMES.values()].map(entry => ({
      workflow_id: entry.workflow,
      status: runtimeStatus(entry),
      paused: entry.paused,
      active_signals: entry.pending.size,
      detached: entry.detached.size,
      last_used: entry.lastUsed,
      storage_error: entry.storageError || null,
    }));
    return {
      routes: ROUTES.length,
      runtimes,
      running: runtimes.filter(item => item.status !== 'idle').length,
      hook_log: HOOKS.log.slice(-20),
      pending_hooks: HOOKS.pending.size,
    };
  },
  /** The capabilities a scoped token needs for a call (see permissions.js). Used by the HTTP layer. */
  async scopedNeeds(method, path, body) {
    return scopedNeeds(String(method || 'GET').toUpperCase(), String(path || '').replace(/^\/+|\/+$/g, ''), body ?? {});
  },
  /** An OpenAPI-style description of every call, for the API page. */
  openapi() {
    const paths = {};
    for (const r of ROUTES) {
      const item = (paths['/api/' + r.pattern] ??= {});
      const parameters = [...r.pattern.matchAll(/{(\w+)}/g)].map(m => ({
        name: m[1],
        in: 'path',
        required: true,
        schema: {type: 'string'},
      }));
      for (const method of r.methods)
        item[method.toLowerCase()] = {
          summary: r.summary,
          description: r.description || '',
          parameters: [...parameters, ...(r.query || []).map(q => ({name: q, in: 'query', schema: {type: 'string'}}))],
          ...(method !== 'GET' && method !== 'DELETE' && r.body
            ? {requestBody: {content: {'application/json': {example: r.body}}}}
            : {}),
          responses: {
            200: {description: r.returns || 'Success'},
            400: {description: 'Invalid request'},
            404: {description: 'Not found'},
            403: {description: 'Permission denied'},
            409: {description: 'The workflow changed since it was read'},
          },
          'x-needs': r.needs[method],
        };
    }
    return {info: {title: 'AgentSys Server API', version: '1.0'}, paths};
  },
};
