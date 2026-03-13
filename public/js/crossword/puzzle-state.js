function getCorrectAnswer(r, c) {
  if (!PUZZLE) return '';
  const key = `${r},${c}`;
  return PUZZLE.rebus[key] || PUZZLE.grid[r]?.[c] || '';
}

function isCellCorrect(r, c, val) {
  const v = val !== undefined ? val : userGrid[r]?.[c];
  if (!v) return false;
  return v === getCorrectAnswer(r, c);
}

function hasRebus() {
  return PUZZLE && Object.keys(PUZZLE.rebus).length > 0;
}

function applyCheckedCellMap(checkedMap) {
  checkedCells = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  if (!PUZZLE || !checkedMap) return;
  for (const [key, isChecked] of Object.entries(checkedMap)) {
    if (!isChecked) continue;
    const [r, c] = key.split(',').map(Number);
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS && isCellCorrect(r, c)) {
      checkedCells[r][c] = true;
    }
  }
}

function refreshCheckedCells({ preserveLockedSolo = isLocalSoloMode() } = {}) {
  const nextChecked = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  if (!PUZZLE) {
    checkedCells = nextChecked;
    return;
  }
  if (preserveLockedSolo) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (checkedCells[r]?.[c] && isCellCorrect(r, c)) nextChecked[r][c] = true;
      }
    }
  }
  if (isAutoCheckEnabled()) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (isCellCorrect(r, c)) nextChecked[r][c] = true;
      }
    }
  }
  checkedCells = nextChecked;
}

function formatTimer(s) {
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function getTimerSeconds() {
  if (!timerBaseTime) return timerBaseSeconds;
  return timerBaseSeconds + Math.floor((Date.now() - timerBaseTime) / 1000);
}

function updateTimerDisplay() {
  timerEl.textContent = formatTimer(getTimerSeconds());
}

function startTimerTick() {
  if (!timerBaseTime) timerBaseTime = Date.now();
  if (timerInterval) return;
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopTimerTick() {
  timerBaseSeconds = getTimerSeconds();
  timerBaseTime = 0;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

async function loadPuzzle(dateStr) {
  currentDate = dateStr;
  localStorage.setItem('crossword-current-puzzle', dateStr);
  remoteUsers.clear();
  cellFillers.clear();
  persistedPoints.clear();
  guessStats.clear();
  resetChatState();

  lastCursorKey = '';
  resetFireState();
  hintCells.clear();
  hideHintBtn();
  if (hintCheckInterval) clearInterval(hintCheckInterval);

  let data;
  let stateData;
  try {
    const puzzleRes = await fetch(`/api/puzzles/${dateStr}`);
    if (!puzzleRes.ok) {
      alert('Puzzle not found');
      showCalendar();
      return;
    }
    data = await puzzleRes.json();

    if (isRoomMode()) {
      const roomRes = await fetch(`/api/rooms/${encodeURIComponent(activeRoomCode)}`);
      if (!roomRes.ok) {
        clearActiveRoomContext();
        stateData = loadSoloState(dateStr) || {};
      } else {
        const roomData = await roomRes.json();
        if (roomData.puzzleDate !== dateStr) {
          setActiveRoomContext(roomData.roomCode, roomData.puzzleDate);
        }
        stateData = roomData.snapshot || {};
      }
    } else if (isSharedGridMode()) {
      const sharedRes = await fetch(`/api/state/${dateStr}`);
      if (!sharedRes.ok) {
        clearActiveRoomContext();
        stateData = loadSoloState(dateStr) || {};
      } else {
        stateData = await sharedRes.json();
      }
    } else {
      stateData = loadSoloState(dateStr) || {};
    }
  } catch (e) {
    alert('Failed to load puzzle');
    showCalendar();
    return;
  }

  ROWS = data.dimensions.rows;
  COLS = data.dimensions.cols;

  const mapClues = (arr) => arr.map(c => ({
    n: c.number,
    clue: c.clue,
    answer: c.answer,
    row: c.row,
    col: c.col,
  }));

  const circleSet = new Set();
  if (data.circles) {
    for (const [r, c] of data.circles) circleSet.add(`${r},${c}`);
  }
  const shadeMap = new Map();
  if (data.shades) {
    for (const [r, c, color] of data.shades) shadeMap.set(`${r},${c}`, color);
  }

  PUZZLE = {
    rows: ROWS,
    cols: COLS,
    grid: data.grid,
    cellNumbers: data.cellNumbers,
    circles: circleSet,
    shades: shadeMap,
    rebus: data.rebus || {},
    clues: {
      across: mapClues(data.clues.across),
      down: mapClues(data.clues.down),
    },
  };

  userGrid = Array.from({ length: ROWS }, () => Array(COLS).fill(''));
  checkedCells = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  solved = false;
  direction = 'across';
  rebusMode = false;
  rebusBuffer = '';
  congratsEl.classList.remove('show');

  btnRebus.style.display = hasRebus() ? '' : 'none';
  btnRebus.classList.remove('active');

  applySharedState(
    stateData.userGrid || {},
    stateData.cellFillers || {},
    stateData.points || {},
    stateData.userColors || {},
    stateData.guesses || {},
  );
  timerBaseSeconds = stateData.timerSeconds || 0;
  timerBaseTime = Date.now();
  updateTimerDisplay();
  startTimerTick();
  if (isLocalSoloMode()) {
    populateSoloFillersFromGrid();
    if (Object.keys(stateData.userGrid || {}).length > 0 && !stateData.summary) {
      saveSoloState(dateStr);
    }
  } else {
    saveSoloState(dateStr);
  }

  applyCheckedCellMap(stateData.checkedCells || {});
  refreshCheckedCells();

  const d = new Date(`${dateStr}T12:00:00`);
  const dayName = DAYS[d.getDay()];
  const prettyDate = `${dayName}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  titleEl.textContent = data.title || 'The New York Times Crossword';
  metaEl.textContent = `${prettyDate} \u00B7 By ${data.author} \u00B7 Edited by ${data.editor}`;
  document.getElementById('rebus-indicator').style.display = hasRebus() ? '' : 'none';
  document.title = `Crossword \u2014 ${prettyDate}`;

  computeAndApplyCellSize();
  window.removeEventListener('resize', computeAndApplyCellSize);
  window.addEventListener('resize', computeAndApplyCellSize);

  buildGrid();
  buildCluePanel();

  selectedRow = 0;
  selectedCol = 0;
  for (let r = 0; r < ROWS; r++) {
    let found = false;
    for (let c = 0; c < COLS; c++) {
      if (!isBlack(r, c)) {
        selectedRow = r;
        selectedCol = c;
        found = true;
        break;
      }
    }
    if (found) break;
  }

  render();
  focusGrid();

  if (isRoomMode() && socket && socket.connected && activeRoomCode) {
    socket.emit('join-room', { roomCode: activeRoomCode });
  } else if (isSharedGridMode() && socket && socket.connected) {
    socket.emit('join-puzzle', dateStr);
  }

  startHintTimer();
}

function applySharedState(gridMap, fillersMap, pointsMap, userColorsMap, guessesMap) {
  for (const [key, letter] of Object.entries(gridMap)) {
    const [r, c] = key.split(',').map(Number);
    if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
      userGrid[r][c] = letter;
    }
  }
  if (fillersMap) {
    for (const [key, name] of Object.entries(fillersMap)) {
      if (name) {
        if (name === '(hint)') {
          hintCells.add(key);
        } else {
          const color = (userColorsMap && userColorsMap[name]) || (name === myName ? myColor : '#ccc');
          cellFillers.set(key, { userName: name, color });
        }
      }
    }
  }
  if (pointsMap) {
    for (const [name, pts] of Object.entries(pointsMap)) {
      persistedPoints.set(name, pts);
    }
  }
  if (guessesMap) {
    for (const [name, stats] of Object.entries(guessesMap)) {
      guessStats.set(name, { total: stats.total || 0, incorrect: stats.incorrect || 0 });
    }
  }
}

function checkCompletion() {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!isBlack(r, c) && !isCellCorrect(r, c)) return;
    }
  }
  if (!solved) {
    sfxVictory();
  }
  solved = true;
  stopTimerTick();
  saveSoloState(currentDate);
  showLeaderboard();
  congratsEl.classList.add('show');
}

function focusGrid() {
  if (IS_MOBILE && chatOpen) {
    chatInputEl.focus();
    return;
  }
  if (IS_MOBILE) {
    mobileInput.focus();
  } else {
    gridEl.focus();
  }
}
