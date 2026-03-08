/**
 * One-time migration script: copy all crossword data from the free crossword-db
 * into the crossword schema on polycast-sequel-db.
 *
 * Usage:
 *   OLD_DATABASE_URL="postgres://..." NEW_DATABASE_URL="postgres://..." node migrate-to-polycast.js
 */

const { Pool } = require('pg');

const oldPool = new Pool({
  connectionString: process.env.OLD_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const newPool = new Pool({
  connectionString: process.env.NEW_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function migrateTable(tableName, columns) {
  console.log(`\nMigrating ${tableName}...`);
  const { rows } = await oldPool.query(`SELECT * FROM ${tableName}`);
  console.log(`  Found ${rows.length} rows`);

  if (rows.length === 0) return;

  const client = await newPool.connect();
  try {
    await client.query('SET search_path TO crossword');

    let inserted = 0;
    for (const row of rows) {
      const vals = columns.map(col => row[col]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const colNames = columns.join(', ');

      const { rowCount } = await client.query(
        `INSERT INTO ${tableName} (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        vals
      );
      inserted += rowCount;
    }
    console.log(`  Inserted ${inserted} new rows into crossword.${tableName}`);
  } finally {
    client.release();
  }
}

async function main() {
  if (!process.env.OLD_DATABASE_URL || !process.env.NEW_DATABASE_URL) {
    console.error('Set OLD_DATABASE_URL and NEW_DATABASE_URL environment variables');
    process.exit(1);
  }

  try {
    // Verify connectivity
    await oldPool.query('SELECT 1');
    console.log('Connected to old crossword-db');
    await newPool.query('SELECT 1');
    console.log('Connected to new polycast-sequel-db');

    // Migrate each table
    await migrateTable('puzzles', ['date', 'data', 'created_at']);
    await migrateTable('puzzle_state', [
      'puzzle_date', 'user_grid', 'timer_seconds', 'cell_fillers', 'points', 'guesses', 'updated_at',
    ]);
    await migrateTable('metadata', ['key', 'value']);
    await migrateTable('users', ['ip', 'name', 'color', 'device_id', 'created_at']);
    await migrateTable('jeopardy_games', ['game_id', 'show_number', 'air_date', 'season', 'data', 'created_at']);
    await migrateTable('jeopardy_progress', [
      'game_id', 'clues_answered', 'total_clues', 'current_round', 'completed', 'updated_at',
    ]);

    console.log('\nMigration complete!');
    console.log('Verify with: SELECT count(*) FROM crossword.puzzles;');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await oldPool.end();
    await newPool.end();
  }
}

main();
