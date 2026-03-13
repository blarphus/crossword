const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const indexHtml = fs.readFileSync('public/index.html', 'utf8');
const storeJs = fs.readFileSync('public/js/crossword/store.js', 'utf8');
const calendarJs = fs.readFileSync('public/js/crossword/calendar-view.js', 'utf8');
const entryOverlayJs = fs.readFileSync('public/js/crossword/entry-overlay.js', 'utf8');

assert(indexHtml.includes('<script src="/js/crossword/store.js"></script>'), 'index should load store.js');
assert(indexHtml.includes('<script src="/js/crossword/calendar-view.js"></script>'), 'index should load calendar-view.js');
assert(indexHtml.includes('<script src="/js/crossword/entry-overlay.js"></script>'), 'index should load entry-overlay.js');

const movedFunctions = [
  'getDeviceId',
  'normalizeRoomCode',
  'loadSoloState',
  'saveSoloState',
  'clearSoloState',
  'buildSoloProgressInfo',
  'getCurrentUserGridMap',
  'getCurrentCheckedCellMap',
  'updateCalendarSummaryForCurrentPuzzle',
  'populateSoloFillersFromGrid',
  'setActiveRoomContext',
  'clearActiveRoomContext',
  'isManuallyComplete',
  'setManualCompleteStatus',
  'todayET',
  'cloneCalendarSummary',
  'normalizeSoloCalendarTemplateItem',
  'getSoloCalendarTemplate',
  'initCalendarNav',
  'syncCalendarSelects',
  'fetchAndRenderCalendar',
  'renderCalendar',
  'drawThumbnail',
  'renderAiBotList',
  'showPuzzleEntryOverlay',
];

for (const name of movedFunctions) {
  assert(!new RegExp(`function ${name}\\b`).test(indexHtml), `${name} should not be defined inline anymore`);
}

new vm.Script(storeJs);
new vm.Script(calendarJs);
new vm.Script(entryOverlayJs);

const scriptStart = indexHtml.indexOf('<script>');
const scriptEnd = indexHtml.lastIndexOf('</script>');
assert(scriptStart >= 0 && scriptEnd > scriptStart, 'inline crossword script should exist');
new vm.Script(indexHtml.slice(scriptStart + 8, scriptEnd));

console.log('stage2 ok');
