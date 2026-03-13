const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const dbIndex = fs.readFileSync('db.js', 'utf8');
const sharedJs = fs.readFileSync('db/shared.js', 'utf8');
const crosswordJs = fs.readFileSync('db/crossword.js', 'utf8');
const jeopardyJs = fs.readFileSync('db/jeopardy.js', 'utf8');

assert(dbIndex.includes("require('./db/shared')"), 'db.js should load db/shared.js');
assert(dbIndex.includes("require('./db/crossword')"), 'db.js should load db/crossword.js');
assert(dbIndex.includes("require('./db/jeopardy')"), 'db.js should load db/jeopardy.js');
assert(!/SELECT data FROM puzzles/.test(dbIndex), 'db.js should no longer contain crossword SQL');
assert(!/FROM jeopardy_games/.test(dbIndex), 'db.js should no longer contain jeopardy SQL');

new vm.Script(sharedJs);
new vm.Script(crosswordJs);
new vm.Script(jeopardyJs);
new vm.Script(dbIndex);

console.log('stage5 ok');
