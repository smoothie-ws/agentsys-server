const test=require('node:test'),assert=require('node:assert/strict');
const Format=require('../runtime/storage/format'), fixture=require('../contract-fixtures/graph.json');
test('public graph document and text packet conform to published fixture',()=>{
assert.deepEqual(Format.encode(fixture.document),fixture.packet);
assert.deepEqual(Format.decode(fixture.packet),fixture.document);
});

for (const entry of fixture.cases) test('format fixture: ' + entry.name, () => {
  assert.deepEqual(Format.encode(entry.document), entry.packet);
  assert.deepEqual(Format.decode(entry.packet), entry.document);
});
