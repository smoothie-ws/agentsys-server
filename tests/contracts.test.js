'use strict';
const {describe} = require('node:test');

describe("capability-contract", () => {
const test=require('node:test'), assert=require('node:assert/strict');
const matcher=require('../runtime/core').capabilityAllows;
const cases=require('../contract-fixtures/capabilities.json');
test('capabilities follow public conformance fixtures',()=>{for(const item of cases) assert.equal(matcher(item.grants,item.need),item.allowed,JSON.stringify(item));});
});

describe("format-contract", () => {
const test=require('node:test'),assert=require('node:assert/strict');
const Format=require('../runtime/format'), fixture=require('../contract-fixtures/graph.json');
test('public graph document and text packet conform to published fixture',()=>{
assert.deepEqual(Format.encode(fixture.document),fixture.packet);
assert.deepEqual(Format.decode(fixture.packet),fixture.document);
});

for (const entry of fixture.cases) test('format fixture: ' + entry.name, () => {
  assert.deepEqual(Format.encode(entry.document), entry.packet);
  assert.deepEqual(Format.decode(entry.packet), entry.document);
});
});

describe("format-property", () => {
// Property tests for the canonical graph format: whatever a valid document contains, encoding it and decoding the
// packet returns an equivalent document, and the encoding is stable when repeated. A deterministic PRNG keeps a
// failure reproducible without a fixture.
const test = require('node:test'),
  assert = require('node:assert/strict');
const TextGraph = require('../runtime/format');

let seed = 0x5eed1234;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const pick = list => list[Math.floor(random() * list.length)];
const integer = (min, max) => min + Math.floor(random() * (max - min + 1));
const text = () => 'v' + integer(0, 999) + ' ' + pick(['alpha', 'beta', 'a/b', '100%', 'line\nbreak']);
const id = () => 'id' + integer(0, 100000);

function value(depth = 0) {
  const kind = depth > 3 ? pick(['string', 'number', 'boolean', 'null']) : pick(['string', 'number', 'boolean', 'null', 'array', 'object']);
  if (kind === 'string') return text();
  if (kind === 'number') return integer(-1000, 1000) / 10;
  if (kind === 'boolean') return random() < 0.5;
  if (kind === 'null') return null;
  if (kind === 'array') return Array.from({length: integer(0, 4)}, () => value(depth + 1));
  return Object.fromEntries(Array.from({length: integer(0, 5)}, () => ['k' + integer(0, 20), value(depth + 1)]));
}

function document() {
  const nodes = Array.from({length: integer(0, 8)}, () => ({
    id: id(),
    config: {title: text(), ...(random() < 0.4 ? {op: 'script', inputs: [{id: 'script', default: text()}]} : {})},
    position: {x: integer(-500, 500), y: integer(-500, 500)},
    ...(random() < 0.3 ? {layout: {width: integer(1, 300), height: integer(1, 200)}} : {}),
  }));
  return {
    root: nodes[0]?.id ?? null,
    nodes,
    groups: Array.from({length: integer(0, 3)}, () => ({id: id(), name: text(), members: nodes.map(node => node.id)})),
    edges: Array.from({length: integer(0, 5)}, () => ({id: id(), source: id(), target: id()})),
    widgets: random() < 0.5 ? {[id()]: [{id: id(), kind: 'text', value: value()}]} : {},
    positions: {[id()]: {x: integer(-9, 9), y: integer(-9, 9)}},
    runtime: {state: value(), outputs: value()},
    extra: value(),
  };
}

test('encode/decode is an equivalence and the canonical form is stable', () => {
  for (let round = 0; round < 120; round++) {
    const original = document();
    const packet = TextGraph.encode(original);
    assert.equal(packet.format, TextGraph.FORMAT);
    const decoded = TextGraph.decode(packet);
    // The format sorts the collections it declares; comparing canonical forms is the real invariant.
    assert.equal(TextGraph.canonical(decoded), TextGraph.canonical(original), 'document ' + round + ' round trip');
    assert.deepEqual(TextGraph.encode(decoded), packet, 'encoding is idempotent');
  }
});

test('a script default becomes a sidecar file and comes back as text, including unusual characters', () => {
  for (let round = 0; round < 60; round++) {
    const code = `node.display(${JSON.stringify(text())});\n// ${round}`;
    const doc = {nodes: [{id: 'n1', config: {op: 'script', inputs: [{id: 'script', default: code}]}}]};
    const packet = TextGraph.encode(doc);
    assert.equal(packet.files['graph.json'].includes(JSON.stringify(code)), false, 'the code is not inline JSON');
    assert.equal(TextGraph.decode(packet).nodes[0].config.inputs[0].default, code);
  }
});

test('malformed packets fail with an error and never return a partial document', () => {
  const packet = TextGraph.encode({nodes: [{id: 'n1', config: {op: 'script', inputs: [{id: 'script', default: 'x'}]}}]});
  const clone = () => JSON.parse(JSON.stringify(packet));
  const cases = [
    p => delete p.files['graph.json'],
    p => (p.files['layout.json'] = '{"0":1}'),
    p => (p.files['layout.json'] = '{"0":["value","nodes"]}'),
    p => (p.files['extra.txt'] = 'x'),
    p => (p.files['scripts/../../etc/passwd.js'] = 'x'),
    p => (p.files['graph.json'] = p.files['graph.json'].replace('"$script"', '"other"')),
    p => (p.files['layout.json'] = JSON.stringify([['__proto__', 'x']])),
    p => (p.files['layout.json'] = JSON.stringify([['value', 'nodes', 'constructor', 'prototype']])),
  ];
  for (const mutate of cases) {
    const broken = clone();
    mutate(broken);
    assert.throws(() => TextGraph.decode(broken));
  }
});
});

describe("product-boundary", () => {
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
test('product source has no sibling repository or shared runtime dependency',()=>{
assert.equal(fs.existsSync(path.join(root,'shared')),false);
const metadata=require('../package.json');
assert.equal(metadata.workspaces,undefined);
for(const dependency of Object.values(metadata.dependencies||{})) assert.doesNotMatch(dependency,/^(?:file:|link:|workspace:)/);
function walk(dir){ for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
if(['.git','node_modules','dist','tests','tools','data'].includes(entry.name)) continue;
const file=path.join(dir,entry.name);
assert.equal(entry.isSymbolicLink(),false,file);
if(entry.isDirectory()) walk(file);
else if(entry.name.endsWith('.js')){
const source=fs.readFileSync(file,'utf8');
for(const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)){
const request=match[1]; if(!request.startsWith('.'))continue;
const target=path.resolve(path.dirname(file),request),relative=path.relative(root,target);
assert.ok(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),file+' -> '+request);
assert.ok([target,target+'.js',target+'.json',path.join(target,'index.js')].some(p=>fs.existsSync(p)),file+' -> '+request);
}
}
}} walk(root);
});
test('distribution ownership excludes the other product implementation',()=>{
for(const name of ['index.html','css','js/app','client-plugins','sdk','client']) assert.equal(fs.existsSync(path.join(root,name)),false,name);
for(const file of require('../headless').FILES) assert.ok(file.startsWith('runtime/'),file);
});
});

describe("published-contract", () => {
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {loadBackend} = require('../headless');
const {createApiServer} = require('../server/api-server');
const spec = require('../api/openapi.json');
test('published contract covers every runtime method and has no undocumented application routes', async () => {
  const runtime = loadBackend({scripts: 'inline'});
  const implementation = runtime.Backend.openapi();
  const platform = new Set(['/api/openapi.json', '/api/meta', '/api/events', '/api/diagnostics', '/api/auth/session', '/api/auth/logout', '/api/auth/plugin-session']);
  for (const [route, methods] of Object.entries(implementation.paths)) {
    assert.ok(spec.paths[route], route);
    assert.deepEqual(Object.keys(spec.paths[route]).sort(), Object.keys(methods).sort(), route);
    for (const operation of Object.values(spec.paths[route])) {
      assert.ok(operation.operationId);
      const response = operation.responses['401'];
      const body = response.$ref ? spec.components.responses[response.$ref.split('/').at(-1)] : response;
      assert.ok(body.content['application/json']);
    }
  }
  for (const route of platform) assert.ok(spec.paths[route], route);
  for (const route of Object.keys(spec.paths)) assert.ok(implementation.paths[route] || platform.has(route), route);
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.version, '1.0');
});
test('the HTTP contract artifact and discovery expose independent API and application versions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-published-'));
  const app = createApiServer({dataDir: dir, token: 'published-contract'});
  try {
    const base = await app.listen(0);
    const meta = await (await fetch(base + '/api/meta')).json();
    assert.equal(meta.version, require('../package.json').version);
    assert.equal(meta.limits.request_body_bytes, 20e6);
    assert.equal(meta.api_version, '1.0');
    const response = await fetch(base + '/api/openapi.json', {headers: {Authorization: 'Bearer published-contract'}});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), spec);
    assert.equal((await fetch(base + '/index.html')).status, 404);
  } finally {
    await app.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
});
