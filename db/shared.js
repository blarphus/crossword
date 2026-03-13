const { Pool } = require('pg');

const isRender = process.env.DATABASE_URL?.includes('render.com') ||
                 process.env.DATABASE_URL?.includes('dpg-');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRender ? { rejectUnauthorized: false } : false,
});

pool.on('connect', (client) => {
  client.query('SET search_path TO crossword, public');
});

async function initDb() {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'crossword' AND table_name = 'puzzles'`
  );
  if (rows.length === 0) {
    throw new Error('crossword.puzzles table not found — run Polycast Sequel migrations first');
  }
}

module.exports = {
  pool,
  initDb,
};
