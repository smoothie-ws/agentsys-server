const test=require('node:test'), assert=require('node:assert/strict');
const matcher=require('../runtime/core').capabilityAllows;
const cases=require('../contract-fixtures/capabilities.json');
test('capabilities follow public conformance fixtures',()=>{for(const item of cases) assert.equal(matcher(item.grants,item.need),item.allowed,JSON.stringify(item));});
