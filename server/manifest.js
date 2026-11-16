'use strict';
// The server runtime is a fixed, documented set of files. It is deliberately not read from index.html: the
// client and the server are separate programs, and a client asset can never add server code.
//
// Order matters: shared helpers, storage, the graph model, then the API surface.
const FILES = [
  'runtime/core.js',
  'runtime/storage/db.js',
  'runtime/storage/format.js',
  'runtime/model/graph.js',
  'runtime/model/schema.js',
  'runtime/model/types.js',
  'runtime/model/snapshot.js',
  'runtime/model/documents.js',
  'runtime/model/editor.js',
  'runtime/model/evaluate.js',
  'runtime/model/executor.js',
  'runtime/backend/settings.js',
  'runtime/backend/resources.js',
  'runtime/backend/permissions.js',
  'runtime/backend/scripts.js',
  'runtime/backend/runtime.js',
  'runtime/backend/routes-app.js',
  'runtime/backend/routes-projects.js',
  'runtime/backend/execution.js',
  'runtime/backend/routes-workflow.js',
  'runtime/backend/routes-library.js',
  'runtime/backend/routes-permissions.js',
  'runtime/backend/routes-exchange.js',
  'runtime/backend/routes-notifications.js',
  'runtime/backend/routes-collections.js',
  'runtime/backend/builtin-nodes.js',
  'runtime/backend/graph-nodes.js',
  'runtime/backend/routes-builtin.js',
];

/** Server-only files: the static Client must never send these to a browser, including retired paths. */
const SERVER_ONLY =
  /^(?:server\.js$|js\/storage\/db\.js$|js\/model\/(?:executor|editor|snapshot|evaluate|schema|documents)\.js$|js\/backend\/|server\/|bin\/|legacy\/|headless\.js$)/;

module.exports = {FILES, SERVER_ONLY};
