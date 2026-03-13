function computeUserPoints() {
  if (!PUZZLE) return new Map();
  const points = new Map();

  function ensure(name, color) {
    if (!points.has(name)) points.set(name, { color: color || '#ccc', pts: 0 });
    const p = points.get(name);
    if (color && color !== '#ccc') p.color = color;
    return p;
  }

  for (const [name, pts] of persistedPoints) {
    ensure(name, null).pts = pts;
  }

  for (const [, filler] of cellFillers) {
    ensure(filler.userName, filler.color);
  }

  return points;
}

function renderPresenceBar() {
  presenceBarEl.innerHTML = '';

  const allUsers = [{ name: myName, color: myColor, label: myName || 'You', isBot: false }];
  const seenNames = new Set([myName]);
  for (const [sid, user] of remoteUsers) {
    if (!seenNames.has(user.userName)) {
      const isBotUser = user.isBot || sid.startsWith('ai-bot-');
      allUsers.push({ name: user.userName, color: user.color, label: user.userName, isBot: isBotUser });
      seenNames.add(user.userName);
    }
  }
  for (const [, filler] of cellFillers) {
    if (!seenNames.has(filler.userName)) {
      allUsers.push({ name: filler.userName, color: filler.color || '#ccc', label: filler.userName });
      seenNames.add(filler.userName);
    }
  }

  if (isSoloMode()) {
    presenceBarEl.style.display = 'none';
    return;
  }
  presenceBarEl.style.display = '';

  const filledCounts = new Map();
  for (const [key, filler] of cellFillers) {
    const [r, c] = key.split(',').map(Number);
    if (isCellCorrect(r, c)) {
      filledCounts.set(filler.userName, (filledCounts.get(filler.userName) || 0) + 1);
    }
  }

  for (const u of allUsers) {
    const filled = filledCounts.get(u.name) || 0;
    const el = document.createElement('div');
    el.className = 'presence-user';
    el.dataset.username = u.name;

    let isOnFire = false;
    if (u.name === myName) {
      isOnFire = myFireActive;
    } else {
      for (const [, rs] of remoteFireStates) {
        if (rs.userName === u.name && rs.expiresAt > Date.now()) {
          isOnFire = true;
          break;
        }
      }
    }
    if (isOnFire) el.classList.add('on-fire');

    const filledStr = filled > 0 ? ` <span class="presence-filled">${filled}</span>` : '';
    const botBadge = u.isBot ? ' <span class="presence-bot-badge">BOT</span>' : '';
    el.innerHTML =
      `<div class="presence-fire-header">` +
        `<div class="presence-flames"></div>` +
        `<div class="presence-fire-timer">` +
          `<div class="presence-fire-timer-fill"></div>` +
          `<span class="presence-fire-timer-label">ON FIRE</span>` +
        `</div>` +
      `</div>` +
      `<div class="presence-user-info">` +
        `<span class="presence-dot" style="background:${u.color}"></span>${u.label}${botBadge}${filledStr}` +
      `</div>`;
    if (u.name === myName) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => showNameModal(true));
    }
    presenceBarEl.appendChild(el);
  }

  updatePresenceFireTimers();
}

function isBlack(r, c) {
  return PUZZLE.grid[r]?.[c] === '.';
}

function inBounds(r, c) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS;
}

function getClueForCell(r, c, dir) {
  const clues = dir === 'across' ? PUZZLE.clues.across : PUZZLE.clues.down;
  for (let i = clues.length - 1; i >= 0; i--) {
    const cl = clues[i];
    if (dir === 'across') {
      if (cl.row === r && cl.col <= c && cl.col + getWordLen(cl, 'across') > c) return cl;
    } else if (cl.col === c && cl.row <= r && cl.row + getWordLen(cl, 'down') > r) {
      return cl;
    }
  }
  return null;
}

function getWordLen(clue, dir) {
  if (clue.answer) return clue.answer.length;
  let len = 0;
  if (dir === 'across') {
    for (let c = clue.col; c < COLS && !isBlack(clue.row, c); c++) len++;
  } else {
    for (let r = clue.row; r < ROWS && !isBlack(r, clue.col); r++) len++;
  }
  return len;
}

function parseReferencedClues(clueText) {
  const refs = [];
  const explicitRegex = /(\d+)[-\s]?([Aa]cross|[Dd]own)/g;
  let m;
  while ((m = explicitRegex.exec(clueText)) !== null) {
    refs.push({ n: parseInt(m[1], 10), dir: m[2].toLowerCase() });
  }
  const groupRegex = /(?:(\d+)-[\s,]+(?:and\s+)?)+(\d+)[-\s]?([Aa]cross|[Dd]own)/g;
  while ((m = groupRegex.exec(clueText)) !== null) {
    const dir = m[3].toLowerCase();
    const fragment = m[0];
    const nums = [...fragment.matchAll(/(\d+)/g)].map(x => parseInt(x[1], 10));
    for (const n of nums) {
      if (!refs.some(r => r.n === n && r.dir === dir)) {
        refs.push({ n, dir });
      }
    }
  }
  return refs;
}

function getWordCells(clue, dir) {
  const cells = [];
  const len = getWordLen(clue, dir);
  for (let i = 0; i < len; i++) {
    if (dir === 'across') cells.push([clue.row, clue.col + i]);
    else cells.push([clue.row + i, clue.col]);
  }
  return cells;
}

let cellEls = [];

function buildGrid() {
  gridScale = 1;
  gridTx = 0;
  gridTy = 0;
  gridEl.style.transform = '';
  gridEl.innerHTML = '';
  gridEl.style.gridTemplateColumns = `repeat(${COLS}, var(--cell-size))`;
  gridEl.style.gridTemplateRows = `repeat(${ROWS}, var(--cell-size))`;

  cellEls = [];
  for (let r = 0; r < ROWS; r++) {
    cellEls[r] = [];
    for (let c = 0; c < COLS; c++) {
      const cell = document.createElement('div');
      cell.className = `cell${isBlack(r, c) ? ' black' : ''}`;

      const num = PUZZLE.cellNumbers[r][c];
      if (num > 0) {
        const numSpan = document.createElement('span');
        numSpan.className = 'number';
        numSpan.textContent = num;
        cell.appendChild(numSpan);
      }

      if (!isBlack(r, c)) {
        const letterSpan = document.createElement('span');
        letterSpan.className = 'letter';
        cell.appendChild(letterSpan);

        const key = `${r},${c}`;
        if (PUZZLE.circles.has(key)) {
          cell.classList.add('circled');
        }

        const shadeColor = PUZZLE.shades.get(key);
        if (shadeColor) {
          cell.classList.add('shaded');
          cell.style.setProperty('--shade-color', shadeColor);
        }

        if (PUZZLE.rebus[key]) {
          cell.classList.add('rebus-cell');
        }
      }

      cell.addEventListener('click', () => onCellClick(r, c));
      gridEl.appendChild(cell);
      cellEls[r][c] = cell;
    }
  }

  if (!IS_MOBILE) {
    const gridH = ROWS * parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cell-size'), 10) + 4;
    cluePanelEl.style.maxHeight = `${gridH}px`;
    for (const sec of cluePanelEl.querySelectorAll('.clue-section')) {
      sec.style.maxHeight = `${gridH}px`;
    }
  } else {
    cluePanelEl.style.maxHeight = '300px';
  }
}

let clueItemEls = {};

function buildCluePanel() {
  cluePanelEl.innerHTML = '';
  clueItemEls = {};

  for (const dir of ['across', 'down']) {
    const section = document.createElement('div');
    section.className = 'clue-section';
    const h2 = document.createElement('h2');
    h2.textContent = dir.charAt(0).toUpperCase() + dir.slice(1);
    section.appendChild(h2);

    for (const clue of PUZZLE.clues[dir]) {
      const item = document.createElement('div');
      item.className = 'clue-item';

      const numSpan = document.createElement('span');
      numSpan.className = 'clue-num';
      numSpan.textContent = clue.n;
      item.appendChild(numSpan);

      const textSpan = document.createElement('span');
      textSpan.className = 'clue-text';
      textSpan.textContent = clue.clue;
      item.appendChild(textSpan);

      item.addEventListener('click', () => {
        direction = dir;
        selectedRow = clue.row;
        selectedCol = clue.col;
        render();
        focusGrid();
      });

      section.appendChild(item);
      clueItemEls[`${dir}-${clue.n}`] = item;
    }
    cluePanelEl.appendChild(section);
  }
}

function render({ scrollClues = true } = {}) {
  if (!PUZZLE) return;
  const autoCheckEnabled = isAutoCheckEnabled();
  const useSoloCheckedBlue = isLocalSoloMode() && autoCheckEnabled;
  const currentClue = getClueForCell(selectedRow, selectedCol, direction);
  const wordCells = currentClue ? getWordCells(currentClue, direction) : [];
  const wordSet = new Set(wordCells.map(([r, c]) => `${r},${c}`));

  const refCellSet = new Set();
  if (currentClue) {
    for (const ref of parseReferencedClues(currentClue.clue)) {
      const clues = PUZZLE.clues[ref.dir];
      if (clues) {
        const refClue = clues.find(c => c.n === ref.n);
        if (refClue) {
          for (const [rr, cc] of getWordCells(refClue, ref.dir)) refCellSet.add(`${rr},${cc}`);
        }
      }
    }
    if (/starred/i.test(currentClue.clue)) {
      for (const dir of ['across', 'down']) {
        for (const clue of PUZZLE.clues[dir]) {
          if (/^\s*\*/.test(clue.clue)) {
            for (const [rr, cc] of getWordCells(clue, dir)) refCellSet.add(`${rr},${cc}`);
          }
        }
      }
    }
  }

  const remoteCursorCells = new Map();
  const remoteWordCells = new Map();
  if (showTrails) {
    for (const [, user] of remoteUsers) {
      if (!PUZZLE) break;
      const hlColor = user.color === '#222222' ? '#888888' : user.color;
      const rClue = getClueForCell(user.row, user.col, user.direction);
      if (rClue) {
        const rWordCells = getWordCells(rClue, user.direction);
        for (const [wr, wc] of rWordCells) {
          const key = `${wr},${wc}`;
          if (!remoteWordCells.has(key)) remoteWordCells.set(key, hlColor);
        }
      }
      remoteCursorCells.set(`${user.row},${user.col}`, hlColor);
    }
  }

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const el = cellEls[r][c];
      if (isBlack(r, c)) continue;

      const key = `${r},${c}`;
      const isMyWord = wordSet.has(key);
      const isMyCell = r === selectedRow && c === selectedCol;

      el.classList.toggle('highlight-word', isMyWord);
      el.classList.toggle('highlight-ref', refCellSet.has(key) && !isMyWord && !isMyCell);
      el.classList.toggle('highlight-cell', isMyCell);

      const letterEl = el.querySelector('.letter');
      if (letterEl) {
        const displayText = (rebusMode && isMyCell && rebusBuffer) ? rebusBuffer : userGrid[r][c];
        letterEl.textContent = displayText;
        letterEl.classList.toggle('rebus-text', displayText.length > 1);
      }

      el.classList.toggle('rebus-active', rebusMode && isMyCell);
      el.classList.toggle('hint-cell', hintCells.has(key));
      el.classList.toggle('checked', checkedCells[r][c]);

      const filler = cellFillers.get(key);
      if (filler && filler.color) {
        el.style.setProperty('--filler-color', filler.color);
      } else {
        el.style.removeProperty('--filler-color');
      }
      if (checkedCells[r][c] && isLocalSoloMode()) {
        el.style.setProperty('--checked-color', useSoloCheckedBlue ? '#2a6dd4' : '#222');
      } else {
        el.style.removeProperty('--checked-color');
      }
      if (autoCheckEnabled && userGrid[r][c] && !checkedCells[r][c]) {
        el.classList.toggle('error', !isCellCorrect(r, c));
      } else {
        el.classList.remove('error');
      }

      const isHint = hintCells.has(key);
      const isRefHighlight = refCellSet.has(key) && !isMyWord && !isMyCell;
      const remoteCursorColor = remoteCursorCells.get(key);
      const remoteWordColor = remoteWordCells.get(key);

      if (isHint || isMyCell || isMyWord || isRefHighlight) {
        el.style.backgroundColor = '';
        el.style.background = '';
      } else if (remoteCursorColor) {
        el.style.background = '';
        el.style.backgroundColor = '#FFA500';
      } else if (remoteWordColor) {
        const hex = remoteWordColor.replace('#', '');
        const rr = parseInt(hex.substring(0, 2), 16);
        const gg = parseInt(hex.substring(2, 4), 16);
        const bb = parseInt(hex.substring(4, 6), 16);
        el.style.background = '';
        el.style.backgroundColor = `rgba(${rr},${gg},${bb},0.25)`;
      } else {
        el.style.backgroundColor = '';
        el.style.background = '';
      }

      el.style.boxShadow = '';
    }
  }

  const clueBarTextEl = clueBarEl.querySelector('#clue-bar-text');
  if (currentClue) {
    const dirLabel = direction === 'across' ? 'A' : 'D';
    clueBarTextEl.textContent = `${currentClue.n}${dirLabel}: ${currentClue.clue}`;
  } else {
    clueBarTextEl.innerHTML = '&nbsp;';
  }

  const refClueKeys = new Set();
  if (currentClue) {
    for (const ref of parseReferencedClues(currentClue.clue)) {
      refClueKeys.add(`${ref.dir}-${ref.n}`);
    }
  }
  const showStarred = currentClue && /starred/i.test(currentClue.clue);

  for (const k in clueItemEls) {
    clueItemEls[k].classList.remove('active', 'ref-active', 'starred');
  }
  if (currentClue) {
    const k = `${direction}-${currentClue.n}`;
    if (clueItemEls[k]) {
      clueItemEls[k].classList.add('active');
      if (scrollClues) {
        const el = clueItemEls[k];
        const section = el.closest('.clue-section');
        if (section) {
          const stickyH = section.querySelector('h2');
          const headerHeight = stickyH ? stickyH.offsetHeight : 0;
          const sectionRect = section.getBoundingClientRect();
          const elRect = el.getBoundingClientRect();
          const visibleTop = sectionRect.top + headerHeight;
          if (elRect.top < visibleTop) {
            section.scrollTop += elRect.top - visibleTop;
          } else if (elRect.bottom > sectionRect.bottom) {
            section.scrollTop += elRect.bottom - sectionRect.bottom;
          }
        }
      }
    }
    for (const refKey of refClueKeys) {
      if (clueItemEls[refKey]) clueItemEls[refKey].classList.add('ref-active');
    }
    if (showStarred) {
      for (const dir of ['across', 'down']) {
        for (const clue of PUZZLE.clues[dir]) {
          if (/^\s*\*/.test(clue.clue)) {
            const sk = `${dir}-${clue.n}`;
            if (clueItemEls[sk]) clueItemEls[sk].classList.add('starred');
          }
        }
      }
    }
  }

  for (const dir of ['across', 'down']) {
    for (const clue of PUZZLE.clues[dir]) {
      const k = `${dir}-${clue.n}`;
      const el = clueItemEls[k];
      if (!el) continue;
      const wCells = getWordCells(clue, dir);
      const isSolved = wCells.length > 0 && wCells.every(([wr, wc]) => isCellCorrect(wr, wc));
      el.classList.toggle('solved', isSolved);
    }
  }

  renderPresenceBar();
  broadcastCursor();
}
