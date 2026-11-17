'use strict';
const fs = require('node:fs');
const path = require('node:path');
const FORMAT = 'agentsys.store/1';
const MARKER = '.agentsys-store.json';

function checkStoreFormat(directory, {initialize = false} = {}) {
  const marker = path.join(directory, MARKER);
  if (fs.existsSync(marker)) {
    let record;
    try { record = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch {}
    if (record?.format !== FORMAT) throw Object.assign(new Error('Unsupported data directory format. Select a new empty --data directory.'), {code: 'unsupported_storage'});
    return;
  }
  const entries = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name !== '.server.lock') : [];
  if (entries.length) throw Object.assign(new Error('The data directory is not an initialized AgentSys store. Select a new empty --data directory; existing files were not changed.'), {code: 'unsupported_storage'});
  if (initialize) {
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(marker, JSON.stringify({format: FORMAT}) + '\n', {flag: 'wx', mode: 0o600});
  }
}
module.exports = {checkStoreFormat, FORMAT, MARKER};
