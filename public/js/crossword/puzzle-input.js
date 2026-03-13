function showPointFloat(row, col, delta, type, isFireBoosted) {
  if (!delta || !cellEls[row]?.[col]) return;
  const el = cellEls[row][col];
  const float = document.createElement('span');
  if (type === 'combo') {
    float.className = 'point-float combo';
    float.textContent = `+${delta} COMBO`;
  } else if (type === 'word') {
    float.className = 'point-float word';
    float.textContent = `word complete +${delta}`;
  } else {
    float.className = `point-float ${delta > 0 ? 'plus' : 'minus'}`;
    float.textContent = delta > 0 ? `+${delta}` : `${delta}`;
  }
  if (isFireBoosted && delta > 0) float.classList.add('fire-points');
  el.appendChild(float);
  float.addEventListener('animationend', () => float.remove());
}

function checkLocalWordBonus(row, col) {
  if (!PUZZLE) return { bonus: 0, completed: 0, wordCellKeys: [] };
  let completed = 0;
  const wordCellKeys = [];
  for (const dir of ['across', 'down']) {
    const clue = getClueForCell(row, col, dir);
    if (!clue) continue;
    const cells = getWordCells(clue, dir);
    if (cells.every(([r, c]) => isCellCorrect(r, c))) {
      completed++;
      for (const [r, c] of cells) wordCellKeys.push(`${r},${c}`);
    }
  }
  let bonus = 0;
  if (completed >= 2) bonus = 250;
  else if (completed === 1) bonus = 50;
  return { bonus, completed, wordCellKeys };
}

function triggerWordWave(row, col, completerColor) {
  if (!PUZZLE) return;
  const color = completerColor || myColor;
  for (const dir of ['across', 'down']) {
    const clue = getClueForCell(row, col, dir);
    if (!clue) continue;
    const cells = getWordCells(clue, dir);
    if (!cells.every(([r, c]) => isCellCorrect(r, c))) continue;
    cells.forEach(([r, c], i) => {
      const el = cellEls[r]?.[c];
      if (!el) return;
      setTimeout(() => {
        el.classList.remove('wave');
        void el.offsetWidth;
        el.classList.add('wave');
        el.addEventListener('animationend', () => el.classList.remove('wave'), { once: true });
      }, i * 50);
    });
  }
  render();
}

function sendCellUpdate(row, col, letter) {
  if (!currentDate) return;
  const key = `${row},${col}`;
  if (hintCells.has(key)) return;
  if (letter) {
    cellFillers.set(key, { userName: myName, color: myColor });
    if (PUZZLE) {
      const isCorrect = isCellCorrect(row, col, letter);
      sfxType(isCorrect);

      if (!isSoloMode()) {
        const now = Date.now();
        const wasOnFire = myFireActive;

        if (!isCorrect && myFireActive) {
          breakMyFire();
        } else if (!isCorrect && !myFireActive) {
          myRecentWordCompletions = [];
        }

        if (isCorrect) {
          const { bonus: rawWb, completed: wordsCompleted, wordCellKeys } = checkLocalWordBonus(row, col);
          if (rawWb > 0) {
            resetHintTimer();
            sfxWordComplete();
            triggerWordWave(row, col);

            if (myFireActive && wasOnFire) {
              myFireWordsCompleted += wordsCompleted;
              myFireExpiresAt += 5000;
            }

            if (!myFireActive) {
              myRecentWordCompletions.push({ timestamp: now, count: wordsCompleted, wordCells: wordCellKeys });
              myRecentWordCompletions = myRecentWordCompletions.filter(e => now - e.timestamp < 30000);
              const totalCompletions = myRecentWordCompletions.reduce((sum, e) => sum + e.count, 0);
              if (totalCompletions >= 3) {
                myFireWordsCompleted = 0;
                startMyFire([], now + 30000);
                myRecentWordCompletions = [];
              }
            }
          }
        }
      } else if (isCorrect) {
        const { bonus: rawWb } = checkLocalWordBonus(row, col);
        if (rawWb > 0) {
          resetHintTimer();
          sfxWordComplete();
          triggerWordWave(row, col);
        }
      }
    }
  } else {
    cellFillers.delete(key);
  }
  saveSoloState(currentDate);
  const livePayload = getLivePuzzlePayload();
  if (livePayload && socket) {
    socket.emit('cell-update', { ...livePayload, row, col, letter });
  }
}

function onCellClick(r, c) {
  if (isBlack(r, c)) return;
  if (rebusMode && rebusBuffer && (r !== selectedRow || c !== selectedCol)) {
    commitRebus();
  }
  if (r === selectedRow && c === selectedCol) {
    direction = direction === 'across' ? 'down' : 'across';
    if (!getClueForCell(r, c, direction)) {
      direction = direction === 'across' ? 'down' : 'across';
    }
  } else {
    selectedRow = r;
    selectedCol = c;
    if (!getClueForCell(r, c, direction)) {
      direction = direction === 'across' ? 'down' : 'across';
    }
  }
  render();
  focusGrid();
}

function advanceCursor(skipFilled = false) {
  if (direction === 'across') {
    let nc = selectedCol + 1;
    while (nc < COLS && !isBlack(selectedRow, nc) && skipFilled && userGrid[selectedRow][nc]) nc++;
    if (nc < COLS && !isBlack(selectedRow, nc)) selectedCol = nc;
  } else {
    let nr = selectedRow + 1;
    while (nr < ROWS && !isBlack(nr, selectedCol) && skipFilled && userGrid[nr][selectedCol]) nr++;
    if (nr < ROWS && !isBlack(nr, selectedCol)) selectedRow = nr;
  }
}

function retreatCursor() {
  if (direction === 'across') {
    let nc = selectedCol - 1;
    while (nc >= 0 && isBlack(selectedRow, nc)) nc--;
    if (nc >= 0) selectedCol = nc;
  } else {
    let nr = selectedRow - 1;
    while (nr >= 0 && isBlack(nr, selectedCol)) nr--;
    if (nr >= 0) selectedRow = nr;
  }
}

function advanceToNextClueIfWordFilled(typedRow, typedCol) {
  if (!isCellCorrect(typedRow, typedCol)) return;
  const clue = getClueForCell(typedRow, typedCol, direction);
  if (!clue) return;
  const cells = getWordCells(clue, direction);
  if (!cells.every(([r, c]) => userGrid[r]?.[c])) return;

  const clues = direction === 'across' ? PUZZLE.clues.across : PUZZLE.clues.down;
  const idx = clues.findIndex(c => c.n === clue.n);
  if (idx === -1) return;

  for (let i = 1; i < clues.length; i++) {
    const next = clues[(idx + i) % clues.length];
    if (isWordSolved(next, direction)) continue;
    const nextCells = getWordCells(next, direction);
    const firstEmpty = nextCells.find(([r, c]) => !userGrid[r]?.[c]);
    [selectedRow, selectedCol] = firstEmpty || [next.row, next.col];
    return;
  }

  const otherDir = direction === 'across' ? 'down' : 'across';
  const otherClues = otherDir === 'across' ? PUZZLE.clues.across : PUZZLE.clues.down;
  for (const next of otherClues) {
    if (isWordSolved(next, otherDir)) continue;
    const nextCells = getWordCells(next, otherDir);
    const firstEmpty = nextCells.find(([r, c]) => !userGrid[r]?.[c]);
    [selectedRow, selectedCol] = firstEmpty || [next.row, next.col];
    direction = otherDir;
    return;
  }
}

function isWordSolved(clue, dir) {
  const cells = getWordCells(clue, dir);
  return cells.every(([r, c]) => isCellCorrect(r, c));
}

function firstUnsolvedCell(clue, dir) {
  const cells = getWordCells(clue, dir);
  for (const [r, c] of cells) {
    if (!isCellCorrect(r, c)) return [r, c];
  }
  return [clue.row, clue.col];
}

function moveToNextWord(forward) {
  const dirs = [direction, direction === 'across' ? 'down' : 'across'];
  const currentClue = getClueForCell(selectedRow, selectedCol, direction);
  if (!currentClue) return;

  const curClues = dirs[0] === 'across' ? PUZZLE.clues.across : PUZZLE.clues.down;
  const otherClues = dirs[1] === 'across' ? PUZZLE.clues.across : PUZZLE.clues.down;
  const curIdx = curClues.findIndex(c => c.n === currentClue.n);

  const candidates = [];
  if (forward) {
    for (let i = curIdx + 1; i < curClues.length; i++) candidates.push({ clue: curClues[i], dir: dirs[0] });
    for (let i = 0; i < otherClues.length; i++) candidates.push({ clue: otherClues[i], dir: dirs[1] });
    for (let i = 0; i <= curIdx; i++) candidates.push({ clue: curClues[i], dir: dirs[0] });
  } else {
    for (let i = curIdx - 1; i >= 0; i--) candidates.push({ clue: curClues[i], dir: dirs[0] });
    for (let i = otherClues.length - 1; i >= 0; i--) candidates.push({ clue: otherClues[i], dir: dirs[1] });
    for (let i = curClues.length - 1; i >= curIdx; i--) candidates.push({ clue: curClues[i], dir: dirs[0] });
  }

  for (const cand of candidates) {
    if (!isWordSolved(cand.clue, cand.dir)) {
      direction = cand.dir;
      const [r, c] = firstUnsolvedCell(cand.clue, cand.dir);
      selectedRow = r;
      selectedCol = c;
      render();
      return;
    }
  }

  const nextIdx = forward ? (curIdx + 1) % curClues.length : (curIdx - 1 + curClues.length) % curClues.length;
  selectedRow = curClues[nextIdx].row;
  selectedCol = curClues[nextIdx].col;
  render();
}

function moveArrow(dr, dc) {
  const newDir = dc !== 0 ? 'across' : 'down';

  if (newDir !== direction) {
    if (getClueForCell(selectedRow, selectedCol, newDir)) {
      direction = newDir;
      return;
    }
  }

  let r = selectedRow + dr;
  let c = selectedCol + dc;
  while (inBounds(r, c) && isBlack(r, c)) {
    r += dr;
    c += dc;
  }
  if (inBounds(r, c)) {
    selectedRow = r;
    selectedCol = c;
    direction = newDir;
  }
}

function computeAccuracy() {
  const stats = new Map();
  for (const [name, gs] of guessStats) {
    stats.set(name, { correct: gs.total - gs.incorrect, total: gs.total });
  }
  return stats;
}

function showLeaderboard() {
  const titleEl = document.getElementById('congrats-title');
  const msgEl = document.getElementById('congrats-msg');
  const lbEl = document.getElementById('leaderboard');
  const timeStr = formatTimer(getTimerSeconds());

  if (isSoloMode()) {
    titleEl.textContent = 'Congratulations!';
    msgEl.textContent = `Solved in ${timeStr}!`;
    lbEl.innerHTML = '';
    return;
  }

  const filledCells = new Map();
  const playerColors = new Map();
  for (const [key, filler] of cellFillers) {
    const [r, c] = key.split(',').map(Number);
    if (isCellCorrect(r, c)) {
      filledCells.set(filler.userName, (filledCells.get(filler.userName) || 0) + 1);
    }
    if (filler.color && filler.color !== '#ccc') playerColors.set(filler.userName, filler.color);
  }

  const players = [];
  for (const [name, filled] of filledCells) {
    const color = playerColors.get(name) || (name === myName ? myColor : '#ccc');
    players.push({ name, color, filled });
  }
  players.sort((a, b) => b.filled - a.filled);

  if (players.length > 0) {
    titleEl.textContent = `${players[0].name} wins!`;
    msgEl.textContent = `Solved in ${timeStr} — Final standings:`;
  } else {
    titleEl.textContent = 'Congratulations!';
    msgEl.textContent = `Solved in ${timeStr}!`;
  }

  lbEl.innerHTML = '';
  players.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'leaderboard-row';
    row.innerHTML = `
      <span class="leaderboard-rank">${i + 1}.</span>
      <span class="leaderboard-dot" style="background:${p.color}"></span>
      <span class="leaderboard-name">${p.name}</span>
      <span class="leaderboard-pts">${p.filled} squares</span>
    `;
    lbEl.appendChild(row);
  });
}

function commitRebus() {
  const hadContent = !!rebusBuffer;
  if (rebusBuffer && !checkedCells[selectedRow][selectedCol]) {
    userGrid[selectedRow][selectedCol] = rebusBuffer;
    sendCellUpdate(selectedRow, selectedCol, rebusBuffer);
    if (isAutoCheckEnabled() && isCellCorrect(selectedRow, selectedCol, rebusBuffer)) {
      checkedCells[selectedRow][selectedCol] = true;
    }
  }
  rebusBuffer = '';
  rebusMode = false;
  btnRebus.classList.remove('active');
  render();
  if (hadContent) {
    advanceCursor(true);
    render();
    checkCompletion();
  }
}

function toggleRebus() {
  if (rebusMode) {
    if (rebusBuffer) {
      commitRebus();
    } else {
      rebusMode = false;
      rebusBuffer = '';
      btnRebus.classList.remove('active');
      render();
    }
  } else {
    rebusMode = true;
    rebusBuffer = '';
    btnRebus.classList.add('active');
    render();
  }
}

function pausePuzzle() {
  if (!currentDate || solved) return;
  stopTimerTick();
  saveSoloState(currentDate);
  const livePayload = getLivePuzzlePayload();
  if (livePayload && socket) {
    socket.emit('pause-puzzle', livePayload);
  }
  showPuzzleEntryOverlay(currentDate, true);
}

function initMobileKeyboard() {
  const kb = document.getElementById('mobile-keyboard');
  const rows = [
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['MORE', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'BACK'],
  ];

  rows.forEach(letters => {
    const rowEl = document.createElement('div');
    rowEl.className = 'kb-row';
    letters.forEach(l => {
      const btn = document.createElement('button');
      btn.className = 'kb-key';
      if (l === 'MORE') {
        btn.classList.add('kb-more');
        btn.textContent = 'Rebus';
      } else if (l === 'BACK') {
        btn.classList.add('kb-backspace');
        btn.textContent = '\u232B';
      } else {
        btn.textContent = l;
      }
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (!PUZZLE || solved) return;
        if (l === 'MORE') {
          toggleRebus();
          return;
        }
        if (l === 'BACK') {
          if (rebusMode) {
            rebusBuffer = rebusBuffer.slice(0, -1);
            render();
            return;
          }
          handleBackspace();
        } else {
          handleLetterInput(l);
        }
      });
      rowEl.appendChild(btn);
    });
    kb.appendChild(rowEl);
  });
}

function handleLetterInput(letter) {
  if (rebusMode) {
    rebusBuffer += letter;
    render();
    return;
  }
  if (!checkedCells[selectedRow][selectedCol]) {
    userGrid[selectedRow][selectedCol] = letter;
    sendCellUpdate(selectedRow, selectedCol, letter);
    if (isAutoCheckEnabled() && isCellCorrect(selectedRow, selectedCol, letter)) {
      checkedCells[selectedRow][selectedCol] = true;
    }
  }
  advanceCursor(true);
  render();
  checkCompletion();
}

function handleBackspace() {
  if (checkedCells[selectedRow][selectedCol]) {
    retreatCursor();
  } else if (userGrid[selectedRow][selectedCol]) {
    userGrid[selectedRow][selectedCol] = '';
    sendCellUpdate(selectedRow, selectedCol, '');
  } else {
    retreatCursor();
    if (!checkedCells[selectedRow][selectedCol]) {
      userGrid[selectedRow][selectedCol] = '';
      sendCellUpdate(selectedRow, selectedCol, '');
    }
  }
  render();
}
