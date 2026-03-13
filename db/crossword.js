const { pool } = require('./shared');

async function savePuzzle(date, data) {
  await pool.query(
    'INSERT INTO puzzles (date, data) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET data = $2',
    [date, JSON.stringify(data)]
  );
}

async function getPuzzle(date) {
  const { rows } = await pool.query(
    'SELECT data FROM puzzles WHERE date = $1',
    [date]
  );
  return rows[0]?.data || null;
}

async function getAllPuzzleMeta() {
  const { rows } = await pool.query(
    `SELECT date, data->>'title' AS title, data->>'author' AS author,
            data->>'editor' AS editor, data->'dimensions' AS dimensions
     FROM puzzles ORDER BY date DESC`
  );
  return rows;
}

async function hasPuzzle(date) {
  const { rows } = await pool.query(
    'SELECT 1 FROM puzzles WHERE date = $1',
    [date]
  );
  return rows.length > 0;
}

async function getState(puzzleDate) {
  const { rows } = await pool.query(
    'SELECT user_grid, updated_at, cell_fillers, points, guesses FROM puzzle_state WHERE puzzle_date = $1',
    [puzzleDate]
  );
  return rows[0] || null;
}

async function upsertCell(puzzleDate, row, col, letter) {
  const key = `${row},${col}`;
  if (letter === '') {
    const { rowCount } = await pool.query(
      `UPDATE puzzle_state SET user_grid = user_grid - $1, updated_at = NOW()
       WHERE puzzle_date = $2`,
      [key, puzzleDate]
    );
    if (rowCount === 0) return;
  } else {
    await pool.query(
      `INSERT INTO puzzle_state (puzzle_date, user_grid, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (puzzle_date) DO UPDATE
       SET user_grid = puzzle_state.user_grid || $2, updated_at = NOW()`,
      [puzzleDate, JSON.stringify({ [key]: letter })]
    );
  }
}

async function clearState(puzzleDate) {
  await pool.query(
    'DELETE FROM puzzle_state WHERE puzzle_date = $1',
    [puzzleDate]
  );
}

function buildProgressInfo(row) {
  const dims = row.dimensions;
  const grid = row.grid;
  const rebus = row.rebus || {};
  const userGrid = row.user_grid || {};
  const numRows = dims.rows;
  const numCols = dims.cols;

  const cells = [];
  let filledCount = 0;
  let totalWhite = 0;
  let isComplete = true;

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (grid[r][c] === '.') {
        cells.push(0);
      } else {
        totalWhite++;
        const key = `${r},${c}`;
        const correctAnswer = rebus[key] || grid[r][c];
        const userLetter = userGrid[key] || '';
        if (userLetter) {
          cells.push(2);
          filledCount++;
          if (userLetter !== correctAnswer) {
            isComplete = false;
          }
        } else {
          cells.push(1);
          isComplete = false;
        }
      }
    }
  }

  if (totalWhite === 0) isComplete = false;

  return {
    date: row.date,
    rows: numRows,
    cols: numCols,
    cells,
    filledCount,
    totalWhite,
    isComplete,
  };
}

async function getCalendarData(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  const startDate = `${yearMonth}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${yearMonth}-${String(lastDay).padStart(2, '0')}`;

  const { rows } = await pool.query(
    `SELECT p.date,
            p.data->'dimensions' AS dimensions,
            p.data->'grid' AS grid,
            p.data->'rebus' AS rebus,
            ps.user_grid
     FROM puzzles p
     LEFT JOIN puzzle_state ps ON ps.puzzle_date = p.date
     WHERE p.date >= $1 AND p.date <= $2
     ORDER BY p.date`,
    [startDate, endDate]
  );

  return rows.map(row => buildProgressInfo(row));
}

async function getProgressSummary(puzzleDate) {
  const { rows } = await pool.query(
    `SELECT p.date,
            p.data->'dimensions' AS dimensions,
            p.data->'grid' AS grid,
            p.data->'rebus' AS rebus,
            ps.user_grid
     FROM puzzles p
     LEFT JOIN puzzle_state ps ON ps.puzzle_date = p.date
     WHERE p.date = $1`,
    [puzzleDate]
  );
  if (rows.length === 0) return null;
  return buildProgressInfo(rows[0]);
}

async function getTimer(puzzleDate) {
  const { rows } = await pool.query(
    'SELECT timer_seconds FROM puzzle_state WHERE puzzle_date = $1',
    [puzzleDate]
  );
  return rows[0]?.timer_seconds || 0;
}

async function saveTimer(puzzleDate, seconds) {
  await pool.query(
    `INSERT INTO puzzle_state (puzzle_date, user_grid, timer_seconds)
     VALUES ($1, '{}', $2)
     ON CONFLICT (puzzle_date) DO UPDATE SET timer_seconds = $2`,
    [puzzleDate, Math.floor(seconds)]
  );
}

async function getMetadata(key) {
  const { rows } = await pool.query('SELECT value FROM metadata WHERE key = $1', [key]);
  return rows[0]?.value || null;
}

async function setMetadata(key, value) {
  await pool.query(
    'INSERT INTO metadata (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, value]
  );
}

async function getUser(deviceId) {
  if (deviceId) {
    const { rows } = await pool.query('SELECT ip, name, color, device_id FROM users WHERE device_id = $1', [deviceId]);
    if (rows[0]) return rows[0];
  }
  return null;
}

async function createUser(ip, name, color, deviceId) {
  if (deviceId) {
    const { rowCount } = await pool.query(
      'UPDATE users SET name = $1, color = $2 WHERE device_id = $3',
      [name, color, deviceId]
    );
    if (rowCount === 0) {
      await pool.query(
        'INSERT INTO users (ip, name, color, device_id) VALUES ($1, $2, $3, $4) ON CONFLICT (ip) DO UPDATE SET name = $2, color = $3, device_id = $4',
        [deviceId, name, color, deviceId]
      );
    }
  } else {
    await pool.query(
      'INSERT INTO users (ip, name, color) VALUES ($1, $2, $3) ON CONFLICT (ip) DO UPDATE SET name = $2, color = $3',
      [ip, name, color]
    );
  }
}

async function getUserCount() {
  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM users');
  return parseInt(rows[0].count, 10);
}

async function upsertCellFiller(puzzleDate, row, col, name) {
  const key = `${row},${col}`;
  if (!name) {
    await pool.query(
      `UPDATE puzzle_state SET cell_fillers = COALESCE(cell_fillers, '{}'::jsonb) - $1
       WHERE puzzle_date = $2`,
      [key, puzzleDate]
    );
  } else {
    await pool.query(
      `INSERT INTO puzzle_state (puzzle_date, user_grid, cell_fillers, updated_at)
       VALUES ($1, '{}', $2, NOW())
       ON CONFLICT (puzzle_date) DO UPDATE
       SET cell_fillers = COALESCE(puzzle_state.cell_fillers, '{}'::jsonb) || $2`,
      [puzzleDate, JSON.stringify({ [key]: name })]
    );
  }
}

async function getCellFillers(puzzleDate) {
  const { rows } = await pool.query(
    'SELECT cell_fillers FROM puzzle_state WHERE puzzle_date = $1',
    [puzzleDate]
  );
  return rows[0]?.cell_fillers || {};
}

async function getUserColors(names) {
  if (!names.length) return {};
  const { rows } = await pool.query(
    'SELECT name, color FROM users WHERE name = ANY($1)',
    [names]
  );
  const map = {};
  for (const row of rows) map[row.name] = row.color;
  return map;
}

async function addPoints(puzzleDate, userName, delta) {
  if (delta === 0) return;
  const existing = await getState(puzzleDate);
  if (!existing) {
    const pts = { [userName]: delta };
    await pool.query(
      `INSERT INTO puzzle_state (puzzle_date, user_grid, points, updated_at)
       VALUES ($1, '{}', $2, NOW())`,
      [puzzleDate, JSON.stringify(pts)]
    );
  } else {
    const pts = existing.points || {};
    pts[userName] = (pts[userName] || 0) + delta;
    await pool.query(
      'UPDATE puzzle_state SET points = $1 WHERE puzzle_date = $2',
      [JSON.stringify(pts), puzzleDate]
    );
  }
}

async function addGuess(puzzleDate, userName, isCorrect) {
  const existing = await getState(puzzleDate);
  if (!existing) {
    const guesses = { [userName]: { total: 1, incorrect: isCorrect ? 0 : 1 } };
    await pool.query(
      `INSERT INTO puzzle_state (puzzle_date, user_grid, guesses, updated_at)
       VALUES ($1, '{}', $2, NOW())`,
      [puzzleDate, JSON.stringify(guesses)]
    );
  } else {
    const guesses = existing.guesses || {};
    if (!guesses[userName]) guesses[userName] = { total: 0, incorrect: 0 };
    guesses[userName].total++;
    if (!isCorrect) guesses[userName].incorrect++;
    await pool.query(
      'UPDATE puzzle_state SET guesses = $1 WHERE puzzle_date = $2',
      [JSON.stringify(guesses), puzzleDate]
    );
  }
}

module.exports = {
  savePuzzle,
  getPuzzle,
  getAllPuzzleMeta,
  hasPuzzle,
  getState,
  upsertCell,
  clearState,
  getCalendarData,
  getProgressSummary,
  getTimer,
  saveTimer,
  getMetadata,
  setMetadata,
  getUser,
  createUser,
  getUserCount,
  upsertCellFiller,
  getCellFillers,
  getUserColors,
  addPoints,
  addGuess,
};
