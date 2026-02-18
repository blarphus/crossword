#!/usr/bin/env node
/**
 * One-time script to build jeopardy-bundle.json.gz from season JSON files.
 * Usage: node build-jeopardy-bundle.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SEASONS_DIR = '/Users/Patron/Desktop/Projects/Jeopardy/data/seasons';
const OUTPUT_PATH = path.join(__dirname, 'jeopardy-bundle.json.gz');

const files = fs.readdirSync(SEASONS_DIR)
  .filter(f => f.startsWith('season_') && f.endsWith('.json'))
  .sort();

console.log(`Found ${files.length} season files`);

const bundle = {};
let total = 0;

for (const file of files) {
  const season = parseInt(file.match(/season_(\d+)/)[1], 10);
  const games = JSON.parse(fs.readFileSync(path.join(SEASONS_DIR, file), 'utf8'));
  for (const game of games) {
    const gameId = game.gameId;
    bundle[gameId] = {
      gameId,
      showNumber: game.showNumber,
      airDate: game.airDate,
      season,
      jRound: game.jRound,
      djRound: game.djRound,
      fj: game.fj || null,
    };
    total++;
  }
  console.log(`  ${file}: ${games.length} games (season ${season})`);
}

console.log(`Total games: ${total}`);
console.log('Compressing...');

const json = JSON.stringify(bundle);
const compressed = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
fs.writeFileSync(OUTPUT_PATH, compressed);

const sizeMB = (compressed.length / 1024 / 1024).toFixed(1);
console.log(`Written ${OUTPUT_PATH} (${sizeMB} MB)`);
