const { initDb } = require('./db/shared');
const crossword = require('./db/crossword');
const jeopardy = require('./db/jeopardy');

module.exports = {
  initDb,
  ...crossword,
  ...jeopardy,
};
