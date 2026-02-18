const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS puzzle_state (
      puzzle_date TEXT PRIMARY KEY,
      user_grid   JSONB NOT NULL,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS puzzles (
      date       TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metadata (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  // Add timer column to puzzle_state if missing
  await pool.query(`
    ALTER TABLE puzzle_state ADD COLUMN IF NOT EXISTS timer_seconds INTEGER DEFAULT 0
  `);
  // Users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      ip         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migrate users table to support device-based identity
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS device_id TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_device_id_idx ON users (device_id) WHERE device_id IS NOT NULL`);
  // Cell filler attribution column
  await pool.query(`
    ALTER TABLE puzzle_state ADD COLUMN IF NOT EXISTS cell_fillers JSONB DEFAULT '{}'
  `);
  // Persisted points column (userName → number)
  await pool.query(`
    ALTER TABLE puzzle_state ADD COLUMN IF NOT EXISTS points JSONB DEFAULT '{}'
  `);
  // Guess tracking column (userName → { total, incorrect })
  await pool.query(`
    ALTER TABLE puzzle_state ADD COLUMN IF NOT EXISTS guesses JSONB DEFAULT '{}'
  `);

  // ─── Jeopardy tables ──────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jeopardy_games (
      game_id    TEXT PRIMARY KEY,
      show_number TEXT,
      air_date   TEXT,
      season     INTEGER,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS jeopardy_games_air_date_idx ON jeopardy_games (air_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS jeopardy_games_season_idx ON jeopardy_games (season)`);

  // Jeopardy shared progress (like puzzle_state for crosswords)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jeopardy_progress (
      game_id        TEXT PRIMARY KEY,
      clues_answered INTEGER DEFAULT 0,
      total_clues    INTEGER DEFAULT 60,
      current_round  TEXT DEFAULT 'jeopardy',
      completed      BOOLEAN DEFAULT FALSE,
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

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
  // Use JSONB path to update a single cell in the grid
  const existing = await getState(puzzleDate);
  if (!existing) {
    // Create a new empty grid and set the cell
    const grid = {};
    grid[`${row},${col}`] = letter;
    await pool.query(
      `INSERT INTO puzzle_state (puzzle_date, user_grid, updated_at)
       VALUES ($1, $2, NOW())`,
      [puzzleDate, JSON.stringify(grid)]
    );
  } else {
    const grid = existing.user_grid;
    if (letter === '') {
      delete grid[`${row},${col}`];
    } else {
      grid[`${row},${col}`] = letter;
    }
    await pool.query(
      `UPDATE puzzle_state SET user_grid = $1, updated_at = NOW()
       WHERE puzzle_date = $2`,
      [JSON.stringify(grid), puzzleDate]
    );
  }
}

async function clearState(puzzleDate) {
  await pool.query(
    'DELETE FROM puzzle_state WHERE puzzle_date = $1',
    [puzzleDate]
  );
}

async function getCalendarData(yearMonth) {
  // yearMonth is "YYYY-MM"
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
        cells.push(0); // black
      } else {
        totalWhite++;
        const key = `${r},${c}`;
        const correctAnswer = rebus[key] || grid[r][c];
        const userLetter = userGrid[key] || '';
        if (userLetter) {
          cells.push(2); // filled
          filledCount++;
          if (userLetter !== correctAnswer) {
            isComplete = false;
          }
        } else {
          cells.push(1); // empty white
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

async function getTimer(puzzleDate) {
  const { rows } = await pool.query(
    'SELECT timer_seconds FROM puzzle_state WHERE puzzle_date = $1',
    [puzzleDate]
  );
  return rows[0]?.timer_seconds || 0;
}

async function saveTimer(puzzleDate, seconds) {
  // Upsert: create row if it doesn't exist yet
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

// ─── User identity (IP-based) ──────────────────────────────────

async function getUser(deviceId) {
  if (deviceId) {
    const { rows } = await pool.query('SELECT ip, name, color, device_id FROM users WHERE device_id = $1', [deviceId]);
    if (rows[0]) return rows[0];
  }
  return null;
}

async function createUser(ip, name, color, deviceId) {
  if (deviceId) {
    // Try to update existing device entry first
    const { rowCount } = await pool.query(
      'UPDATE users SET name = $1, color = $2 WHERE device_id = $3',
      [name, color, deviceId]
    );
    if (rowCount === 0) {
      // New device — insert with a unique key (use device_id as ip column to avoid PK conflicts)
      await pool.query(
        'INSERT INTO users (ip, name, color, device_id) VALUES ($1, $2, $3, $4) ON CONFLICT (ip) DO UPDATE SET name = $2, color = $3, device_id = $4',
        [deviceId, name, color, deviceId]
      );
    }
  } else {
    // Fallback to IP-based (legacy)
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

// ─── Cell filler attribution ───────────────────────────────────

async function upsertCellFiller(puzzleDate, row, col, name) {
  const key = `${row},${col}`;
  const existing = await getState(puzzleDate);
  if (!existing) {
    // No state row yet — create one with just the filler
    const fillers = name ? { [key]: name } : {};
    await pool.query(
      `INSERT INTO puzzle_state (puzzle_date, user_grid, cell_fillers, updated_at)
       VALUES ($1, '{}', $2, NOW())`,
      [puzzleDate, JSON.stringify(fillers)]
    );
  } else {
    const fillers = existing.cell_fillers || {};
    if (name) {
      fillers[key] = name;
    } else {
      delete fillers[key];
    }
    await pool.query(
      'UPDATE puzzle_state SET cell_fillers = $1 WHERE puzzle_date = $2',
      [JSON.stringify(fillers), puzzleDate]
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

// ─── Jeopardy queries ──────────────────────────────────────────

async function saveJeopardyGame(gameId, data) {
  await pool.query(
    `INSERT INTO jeopardy_games (game_id, show_number, air_date, season, data)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (game_id) DO UPDATE SET show_number = $2, air_date = $3, season = $4, data = $5`,
    [gameId, data.showNumber, data.airDate, data.season || null, JSON.stringify(data)]
  );
}

async function getJeopardyGame(gameId) {
  const { rows } = await pool.query(
    'SELECT data FROM jeopardy_games WHERE game_id = $1',
    [gameId]
  );
  return rows[0]?.data || null;
}

async function getRandomJeopardyGame() {
  // Prefer games with no progress; fall back to any game if all have progress
  const { rows } = await pool.query(
    `SELECT jg.game_id, jg.data FROM jeopardy_games jg
     LEFT JOIN jeopardy_progress jp ON jp.game_id = jg.game_id
     WHERE jp.game_id IS NULL
     ORDER BY RANDOM() LIMIT 1`
  );
  if (rows[0]) return rows[0];
  // Fallback: any non-completed game
  const { rows: rows2 } = await pool.query(
    `SELECT jg.game_id, jg.data FROM jeopardy_games jg
     LEFT JOIN jeopardy_progress jp ON jp.game_id = jg.game_id
     WHERE jp.completed IS NOT TRUE
     ORDER BY RANDOM() LIMIT 1`
  );
  if (rows2[0]) return rows2[0];
  // Last resort: any game
  const { rows: rows3 } = await pool.query(
    'SELECT game_id, data FROM jeopardy_games ORDER BY RANDOM() LIMIT 1'
  );
  return rows3[0] || null;
}

async function getJeopardySeasons() {
  const { rows } = await pool.query(
    `SELECT jg.season, COUNT(*)::int AS game_count,
            MIN(jg.air_date) AS first_date, MAX(jg.air_date) AS last_date,
            COUNT(jp.game_id) FILTER (WHERE jp.completed) ::int AS completed_count,
            COUNT(jp.game_id) FILTER (WHERE NOT jp.completed) ::int AS in_progress_count
     FROM jeopardy_games jg
     LEFT JOIN jeopardy_progress jp ON jp.game_id = jg.game_id
     GROUP BY jg.season ORDER BY jg.season`
  );
  return rows;
}

async function getJeopardyGamesBySeason(season) {
  const { rows } = await pool.query(
    `SELECT jg.game_id, jg.show_number, jg.air_date, jg.season,
            jp.clues_answered, jp.total_clues, jp.current_round, jp.completed
     FROM jeopardy_games jg
     LEFT JOIN jeopardy_progress jp ON jp.game_id = jg.game_id
     WHERE jg.season = $1 ORDER BY jg.air_date`,
    [season]
  );
  return rows;
}

async function saveJeopardyProgress(gameId, cluesAnswered, totalClues, currentRound, completed) {
  await pool.query(
    `INSERT INTO jeopardy_progress (game_id, clues_answered, total_clues, current_round, completed, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (game_id) DO UPDATE SET clues_answered = $2, total_clues = $3, current_round = $4, completed = $5, updated_at = NOW()`,
    [gameId, cluesAnswered, totalClues, currentRound, completed]
  );
}

async function getJeopardyProgress(gameId) {
  const { rows } = await pool.query(
    'SELECT * FROM jeopardy_progress WHERE game_id = $1',
    [gameId]
  );
  return rows[0] || null;
}

module.exports = { initDb, getState, upsertCell, clearState, savePuzzle, getPuzzle, getAllPuzzleMeta, hasPuzzle, getCalendarData, getProgressSummary, getTimer, saveTimer, getMetadata, setMetadata, getUser, createUser, getUserCount, upsertCellFiller, getCellFillers, getUserColors, addPoints, addGuess, saveJeopardyGame, getJeopardyGame, getRandomJeopardyGame, getJeopardyGamesBySeason, getJeopardySeasons, saveJeopardyProgress, getJeopardyProgress };
