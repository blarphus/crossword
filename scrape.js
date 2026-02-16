const { execFile } = require('child_process');
const path = require('path');
const db = require('./db');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: __dirname, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function scrapeDate(dateStr) {
  console.log(`[scrape] Starting scrape for ${dateStr}`);

  // Step 1: Download HTML
  await run('python3', [path.join(__dirname, 'download.py'), '--date', dateStr]);

  // Step 2: Parse HTML to JSON on stdout
  const jsonStr = await run('python3', [path.join(__dirname, 'parse.py'), '--date', dateStr, '--stdout']);

  // Step 3: Save to DB
  const puzzleData = JSON.parse(jsonStr);
  await db.savePuzzle(dateStr, puzzleData);

  console.log(`[scrape] Successfully scraped and saved ${dateStr}`);
}

module.exports = { scrapeDate };
