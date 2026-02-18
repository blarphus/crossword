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

const bundle = {};
for (const game of games) {
  const gameId = game.gameId;
  bundle[gameId] = {
    gameId,
    showNumber: game.showNumber,
    airDate: game.airDate,
    jRound: game.jRound,
    djRound: game.djRound,
    fj: game.fj || null,
  };
}

const total = Object.keys(bundle).length;
console.log(`Total games in bundle: ${total}`);
console.log('Compressing...');

const json = JSON.stringify(bundle);
const compressed = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
fs.writeFileSync(OUTPUT_PATH, compressed);

const sizeMB = (compressed.length / 1024 / 1024).toFixed(1);
console.log(`Written ${OUTPUT_PATH} (${sizeMB} MB)`);
