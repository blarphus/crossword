const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const indexHtml = fs.readFileSync('public/index.html', 'utf8');
const serverJs = fs.readFileSync('server.js', 'utf8');

assert(!indexHtml.includes('.mode-toggle'), 'obsolete mode-toggle CSS should be removed');
assert(!indexHtml.includes('const roomCounts = new Map()'), 'unused roomCounts map should be removed');

const scriptStart = indexHtml.indexOf('<script>');
const scriptEnd = indexHtml.lastIndexOf('</script>');
assert(scriptStart >= 0 && scriptEnd > scriptStart, 'inline crossword script should exist');
new vm.Script(indexHtml.slice(scriptStart + 8, scriptEnd));
new vm.Script(serverJs);

console.log('stage1 ok');
