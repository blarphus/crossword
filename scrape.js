const { parse: parseHTML } = require('node-html-parser');
const db = require('./db');

const BASE_URL = 'https://www.xwordinfo.com/Crossword';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchPage(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const urlDate = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  const url = `${BASE_URL}?date=${urlDate}`;
  console.log(`[scrape] Fetching ${url}`);

  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

function parsePuzzle(html, dateStr) {
  const root = parseHTML(html);

  // ── Metadata ──
  let author = '', editor = '';
  const ldScript = root.querySelector('script[type="application/ld+json"]');
  if (ldScript) {
    try {
      const ld = JSON.parse(ldScript.textContent);
      author = ld.author?.name || '';
      editor = ld.editor?.name || '';
    } catch {}
  }
  if (!author) {
    const aegrid = root.querySelector('#CPHContent_AEGrid');
    if (aegrid) {
      const divs = aegrid.querySelectorAll('div');
      for (let i = 0; i < divs.length; i++) {
        const txt = divs[i].text.trim();
        if (txt === 'Author:' && i + 1 < divs.length) author = divs[i + 1].text.trim();
        if (txt === 'Editor:' && i + 1 < divs.length) editor = divs[i + 1].text.trim();
      }
    }
  }

  // ── Grid from PuzTable ──
  const table = root.querySelector('#PuzTable');
  if (!table) throw new Error('No PuzTable found');

  const grid = [];
  const cellNumbers = [];
  const circles = [];
  const shades = [];
  const rebus = {};

  let rowIdx = 0;
  for (const tr of table.querySelectorAll('tr')) {
    const rowLetters = [];
    const rowNums = [];
    let colIdx = 0;

    for (const td of tr.querySelectorAll('td')) {
      const classes = (td.getAttribute('class') || '').split(/\s+/);
      const isBlack = classes.includes('black');
      const isShade = classes.includes('shade');
      const isCircle = classes.includes('bigcircle');
      const style = td.getAttribute('style') || '';

      if (isBlack || (!isShade && style.includes('background'))) {
        rowLetters.push('.');
        rowNums.push(0);
      } else {
        const letterDiv = td.querySelector('.letter');
        const substDiv = td.querySelector('.subst') || td.querySelector('.subst2');
        const numDiv = td.querySelector('.num');
        const numText = numDiv ? numDiv.text.trim() : '';

        let letter;
        if (substDiv) {
          const rebusText = substDiv.text.trim().toUpperCase();
          letter = rebusText[0] || '';
          rebus[`${rowIdx},${colIdx}`] = rebusText;
        } else {
          letter = letterDiv ? letterDiv.text.trim() : '';
        }

        rowLetters.push(letter || '.');
        rowNums.push(numText ? parseInt(numText, 10) : 0);

        if (isCircle) circles.push([rowIdx, colIdx]);
        if (isShade) {
          let shadeColor = '#c0c0c0';
          const colorMatch = style.match(/background-color:\s*(#[0-9a-fA-F]{3,6})/);
          if (colorMatch) shadeColor = colorMatch[1];
          shades.push([rowIdx, colIdx, shadeColor]);
        }
      }
      colIdx++;
    }

    if (rowLetters.length > 0) {
      grid.push(rowLetters);
      cellNumbers.push(rowNums);
      rowIdx++;
    }
  }

  if (grid.length === 0) throw new Error('Empty grid');
  const rows = grid.length;
  const cols = grid[0].length;

  // ── Clues ──
  function parseClueSection(panelId) {
    const clues = [];
    const panel = root.querySelector(`#${panelId}`);
    if (!panel) return clues;

    const numclue = panel.querySelector('.numclue');
    if (!numclue) return clues;

    const children = numclue.querySelectorAll(':scope > div');
    for (let i = 0; i < children.length - 1; i += 2) {
      const numText = children[i].text.trim();
      if (!/^\d+$/.test(numText)) continue;
      const num = parseInt(numText, 10);

      const clueDiv = children[i + 1];
      // Extract answer from Finder link
      let answer = '';
      const link = clueDiv.querySelector('a[href*="/Finder?w="]');
      if (link) {
        const href = link.getAttribute('href') || '';
        const m = href.match(/\/Finder\?w=(\w+)/);
        if (m) answer = m[1].toUpperCase();
        link.remove();
      }

      let clueText = clueDiv.text.trim();
      clueText = clueText.replace(/\s*:\s*$/, '');

      clues.push({ number: num, clue: clueText, answer });
    }
    return clues;
  }

  const acrossClues = parseClueSection('ACluesPan');
  const downClues = parseClueSection('DCluesPan');

  if (!acrossClues.length && !downClues.length) throw new Error('No clues found');

  // ── Map clue numbers to grid positions ──
  const numPos = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cellNumbers[r][c] > 0) numPos[cellNumbers[r][c]] = [r, c];
    }
  }
  for (const clue of acrossClues) {
    if (numPos[clue.number]) { clue.row = numPos[clue.number][0]; clue.col = numPos[clue.number][1]; }
  }
  for (const clue of downClues) {
    if (numPos[clue.number]) { clue.row = numPos[clue.number][0]; clue.col = numPos[clue.number][1]; }
  }

  // ── Title ──
  const titleEl = root.querySelector('#PuzTitle');
  const title = titleEl ? titleEl.text.trim() : '';

  const result = {
    date: dateStr,
    title,
    author,
    editor,
    dimensions: { rows, cols },
    grid,
    cellNumbers,
    clues: { across: acrossClues, down: downClues },
  };
  if (circles.length) result.circles = circles;
  if (shades.length) result.shades = shades;
  if (Object.keys(rebus).length) result.rebus = rebus;

  return result;
}

async function scrapeDate(dateStr) {
  console.log(`[scrape] Starting scrape for ${dateStr}`);
  const html = await fetchPage(dateStr);
  const puzzleData = parsePuzzle(html, dateStr);
  await db.savePuzzle(dateStr, puzzleData);
  console.log(`[scrape] Successfully scraped and saved ${dateStr} (${puzzleData.dimensions.rows}x${puzzleData.dimensions.cols}, ${puzzleData.clues.across.length}A + ${puzzleData.clues.down.length}D)`);
}

module.exports = { scrapeDate };
