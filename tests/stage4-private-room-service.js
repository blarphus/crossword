const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const serverJs = fs.readFileSync('server.js', 'utf8');
const serviceJs = fs.readFileSync('crossword/runtime/private-room-service.js', 'utf8');

assert(serverJs.includes("require('./crossword/runtime/private-room-service')"), 'server.js should load the private room service');
assert(serverJs.includes('createPrivateRoomService({'), 'server.js should instantiate the private room service');

const movedFunctions = [
  'normalizeRoomCode',
  'privateRoomChannel',
  'createPrivateRoom',
  'buildPrivateRoomSnapshot',
  'getPrivateRoomElapsedSeconds',
  'startPrivateRoomTimer',
  'stopPrivateRoomTimer',
  'getPrivateRealPlayerCount',
  'areAllPrivatePlayersPaused',
  'processPrivateRoomCellUpdate',
  'getPrivateAiBotList',
  'addPrivateAiBot',
  'removePrivateAiBot',
  'removeAllPrivateAiBots',
  'pauseAllPrivateAiBots',
  'resumeAllPrivateAiBots',
  'startPrivateAiSolving',
  'leaveCurrentPrivateRoom',
];

for (const name of movedFunctions) {
  assert(!new RegExp(`function ${name}\\b`).test(serverJs), `${name} should not be implemented inline in server.js anymore`);
}

new vm.Script(serviceJs);
new vm.Script(serverJs);

console.log('stage4 ok');
