#!/usr/bin/env node
/**
 * Build jeopardy-bundle.json.gz from scraped game data.
 * Usage: node build-jeopardy-bundle.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const INPUT_PATH = path.join(__dirname, 'jeopardy-scraped.json');
const OUTPUT_PATH = path.join(__dirname, 'jeopardy-bundle.json.gz');

if (!fs.existsSync(INPUT_PATH)) {
  console.error(`Error: ${INPUT_PATH} not found. Run scrape-jeopardy.py first.`);
  process.exit(1);
}

const games = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf8'));
console.log(`Loaded ${games.length} games from ${INPUT_PATH}`);

// Derive Jeopardy season from air date.
// Season 1 started Sep 1984. Each season runs Sep-Jul.
// Season N covers Sep (1983+N) through Jul (1984+N).
function getSeason(airDate) {
  if (!airDate) return null;
  const [year, month] = airDate.split('-').map(Number);
  // Sep (9) through Dec: season = year - 1983
  // Jan through Jul: season = year - 1984
  if (month >= 9) return year - 1983;
  return year - 1984;
}

const bundle = {};
const seasonCounts = {};
for (const game of games) {
  const gameId = game.gameId;
  const season = getSeason(game.airDate);
  if (season) seasonCounts[season] = (seasonCounts[season] || 0) + 1;
  bundle[gameId] = {
    gameId,
    showNumber: game.showNumber,
    airDate: game.airDate,
    season,
    jRound: game.jRound,
    djRound: game.djRound,
    fj: game.fj || null,
  };
}

const seasons = Object.keys(seasonCounts).sort((a, b) => a - b);
console.log(`Seasons: ${seasons.join(', ')} (${seasons.length} total)`);

const total = Object.keys(bundle).length;
console.log(`Total games in bundle: ${total}`);
console.log('Compressing...');

const json = JSON.stringify(bundle);
const compressed = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
fs.writeFileSync(OUTPUT_PATH, compressed);

const sizeMB = (compressed.length / 1024 / 1024).toFixed(1);
console.log(`Written ${OUTPUT_PATH} (${sizeMB} MB)`);
