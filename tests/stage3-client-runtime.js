const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const indexHtml = fs.readFileSync('public/index.html', 'utf8');
const files = [
  'public/js/crossword/puzzle-state.js',
  'public/js/crossword/features/chat.js',
  'public/js/crossword/features/hints.js',
  'public/js/crossword/features/fire.js',
  'public/js/crossword/puzzle-render.js',
  'public/js/crossword/puzzle-input.js',
];

for (const scriptPath of files) {
  assert(indexHtml.includes(`<script src="/${scriptPath.replace(/^public\//, '')}"></script>`), `${scriptPath} should be loaded by index.html`);
  new vm.Script(fs.readFileSync(scriptPath, 'utf8'));
}

const movedFunctions = [
  'getCorrectAnswer',
  'isCellCorrect',
  'hasRebus',
  'applyCheckedCellMap',
  'refreshCheckedCells',
  'formatTimer',
  'getTimerSeconds',
  'updateTimerDisplay',
  'startTimerTick',
  'stopTimerTick',
  'formatChatTime',
  'updateChatUnreadIndicator',
  'updateChatComposerState',
  'renderChatMessages',
  'setChatOpen',
  'resetChatState',
  'appendChatMessage',
  'submitChatMessage',
  'loadPuzzle',
  'applySharedState',
  'showPointFloat',
  'checkLocalWordBonus',
  'triggerWordWave',
  'sendCellUpdate',
  'startHintTimer',
  'resetHintTimer',
  'showHintBtn',
  'hideHintBtn',
  'updateHintVoteText',
  'voteForHint',
  'applyHintReveal',
  'resetFireState',
  'startMyFire',
  'breakMyFire',
  'expireMyFire',
  'updatePresenceFireTimers',
  'startPresenceFireInterval',
  'stopPresenceFireInterval',
  'showFireBar',
  'hideFireBar',
  'showComboBroken',
  'showFireAnnounce',
  'handleRemoteFireEvent',
  'computeUserPoints',
  'renderPresenceBar',
  'isBlack',
  'inBounds',
  'getClueForCell',
  'getWordLen',
  'parseReferencedClues',
  'getWordCells',
  'buildGrid',
  'buildCluePanel',
  'render',
  'onCellClick',
  'advanceCursor',
  'retreatCursor',
  'advanceToNextClueIfWordFilled',
  'isWordSolved',
  'firstUnsolvedCell',
  'moveToNextWord',
  'moveArrow',
  'computeAccuracy',
  'showLeaderboard',
  'checkCompletion',
  'focusGrid',
  'commitRebus',
  'toggleRebus',
  'pausePuzzle',
  'initMobileKeyboard',
  'handleLetterInput',
  'handleBackspace',
];

for (const name of movedFunctions) {
  assert(!new RegExp(`function ${name}\\b`).test(indexHtml), `${name} should not be defined inline anymore`);
}

const scriptStart = indexHtml.indexOf('<script>');
const scriptEnd = indexHtml.lastIndexOf('</script>');
assert(scriptStart >= 0 && scriptEnd > scriptStart, 'inline crossword script should exist');
new vm.Script(indexHtml.slice(scriptStart + 8, scriptEnd));

console.log('stage3 ok');
