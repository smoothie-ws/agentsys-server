const test=require('node:test'),assert=require('node:assert/strict');
const Format=require('../runtime/storage/format'), fixture=require('../contract-fixtures/graph.json');
test('public graph document and text packet conform to published fixture',()=>{
assert.deepEqual(Format.encode(fixture.document),fixture.packet);
assert.deepEqual(Format.decode(fixture.packet),fixture.document);
});
