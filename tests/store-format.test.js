'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createApiServer} = require('../server/api-server');
const {checkStoreFormat, FORMAT, MARKER} = require('../server/store-format');

test('a new store is marked and can be reopened', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-format-'));
  try {
    const first = createApiServer({dataDir: dir});
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, MARKER))).format, FORMAT);
    await first.close();
    const next = createApiServer({dataDir: dir});
    await next.close();
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('unmarked and unsupported stores are refused before any file changes', () => {
  for (const marker of [null, '{broken', JSON.stringify({format: 'agentsys.store/2'})]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsys-format-'));
    try {
      fs.writeFileSync(path.join(dir, 'projects.json'), '[{"id":"keep"}]');
      if (marker !== null) fs.writeFileSync(path.join(dir, MARKER), marker);
      const snapshot = () => Object.fromEntries(fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name), 'hex')]));
      const before = snapshot();
      assert.throws(() => checkStoreFormat(dir, {initialize: true}), {code: 'unsupported_storage'});
      assert.throws(() => createApiServer({dataDir: dir}), {code: 'unsupported_storage'});
      assert.deepEqual(snapshot(), before);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
});
