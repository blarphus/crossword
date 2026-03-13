const { pool } = require('./shared');

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
  const { rows } = await pool.query(
    `SELECT jg.game_id, jg.data FROM jeopardy_games jg
     LEFT JOIN jeopardy_progress jp ON jp.game_id = jg.game_id
     WHERE jp.game_id IS NULL
     ORDER BY RANDOM() LIMIT 1`
  );
  if (rows[0]) return rows[0];

  const { rows: rows2 } = await pool.query(
    `SELECT jg.game_id, jg.data FROM jeopardy_games jg
     LEFT JOIN jeopardy_progress jp ON jp.game_id = jg.game_id
     WHERE jp.completed IS NOT TRUE
     ORDER BY RANDOM() LIMIT 1`
  );
  if (rows2[0]) return rows2[0];

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

module.exports = {
  saveJeopardyGame,
  getJeopardyGame,
  getRandomJeopardyGame,
  getJeopardySeasons,
  getJeopardyGamesBySeason,
  saveJeopardyProgress,
  getJeopardyProgress,
};
