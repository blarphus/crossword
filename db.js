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
}

async function getState(puzzleDate) {
  const { rows } = await pool.query(
    'SELECT user_grid, updated_at FROM puzzle_state WHERE puzzle_date = $1',
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

module.exports = { initDb, getState, upsertCell, clearState };
