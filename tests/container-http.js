'use strict';
// Execute from outside a server-only container. No client files or source imports.
const assert = require('node:assert/strict'), fs = require('node:fs');
const base = process.env.AGENTSYS_TEST_URL || 'http://127.0.0.1:8080';
const token = process.env.AGENTSYS_TEST_TOKEN || 'ci-container-token';
const stateFile = process.env.AGENTSYS_TEST_STATE || '.container-smoke.json';
async function call(method, route, body) {
  const response = await fetch(base + '/api/' + route, {method, headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}
(async () => {
  if (process.argv.includes('--verify-restart')) {
    const {project} = JSON.parse(fs.readFileSync(stateFile));
    const result = await call('GET', 'projects/' + project + '/workflow');
    assert.equal(result.nodes.length, 1);
    const execution = await call('GET', 'projects/' + project + '/execution');
    assert.ok(Object.values(execution.displays || {}).includes('server-only execution'));
    console.log('PASS server-only workflow and result survive container restart');
    return;
  }
  await call('PUT', 'settings', {developer_mode: true});
  const project = await call('POST', 'projects', {name: 'Server-only container'});
  const node = await call('POST', 'projects/' + project.id + '/typed-nodes', {node_type: 'custom', config: {title: 'Server only', op: 'script', inputs: [{id: 'in', name: 'in', type: 'signal'}, {id: 'script', name: 'script', default: "node.display('server-only execution'); node.output.result = 42;"}], outputs: [{id: 'out', name: 'out', type: 'signal'}, {id: 'result', name: 'result'}]}, position: {x: 0, y: 0}});
  const execution = await call('POST', 'projects/' + project.id + '/execution', {wait: true, node_ids: [node.id], input_port: 'in'});
  assert.equal(execution.dispatch_status, 'completed');
  assert.ok(Object.values(execution.displays || {}).includes('server-only execution'));
  assert.equal(execution.outputs[node.id].result, 42);
  fs.writeFileSync(stateFile, JSON.stringify({project: project.id}));
  console.log('PASS server-only project/workflow creation and meaningful execution over HTTP');
})().catch(error => {console.error(error); process.exitCode = 1;});
