function getDeviceId() {
  let id = localStorage.getItem('crossword-device-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('crossword-device-id', id);
  }
  return id;
}

function normalizeRoomCode(value) {
  return String(value || '').trim().toUpperCase();
}

function getSoloStateKey(puzzleDate) {
  return `${SOLO_STATE_KEY_PREFIX}${puzzleDate}`;
}

function getSoloCalendarTemplateKey(yearMonth) {
  return `${SOLO_CALENDAR_TEMPLATE_KEY_PREFIX}${yearMonth}`;
}

function getCommunalCalendarSummaryKey(yearMonth) {
  return `${COMMUNAL_CALENDAR_SUMMARY_KEY_PREFIX}${yearMonth}`;
}

function loadSoloState(puzzleDate) {
  try {
    const raw = localStorage.getItem(getSoloStateKey(puzzleDate));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function saveSoloState(puzzleDate) {
  if (!PUZZLE || !puzzleDate) return;
  const existing = loadSoloState(puzzleDate) || {};
  const state = {
    userGrid: getCurrentUserGridMap(),
    checkedCells: getCurrentCheckedCellMap(),
    timerSeconds: getTimerSeconds(),
    manualComplete: !!existing.manualComplete,
    updatedAt: new Date().toISOString(),
    summary: buildSoloProgressInfo(puzzleDate, {
      dimensions: { rows: ROWS, cols: COLS },
      grid: PUZZLE.grid,
      rebus: PUZZLE.rebus,
    }, {
      userGrid: getCurrentUserGridMap(),
      manualComplete: !!existing.manualComplete,
    }),
  };
  localStorage.setItem(getSoloStateKey(puzzleDate), JSON.stringify(state));
  updateCalendarSummaryForCurrentPuzzle();
}

function clearSoloState(puzzleDate) {
  localStorage.removeItem(getSoloStateKey(puzzleDate));
  if (calendarData.has(puzzleDate) && PUZZLE && currentDate === puzzleDate) {
    updateCalendarSummaryForCurrentPuzzle();
  }
}

function buildSoloProgressInfo(date, puzzleData, soloState) {
  const dims = puzzleData.dimensions;
  const grid = puzzleData.grid;
  const rebus = puzzleData.rebus || {};
  const storedGrid = soloState?.userGrid || {};
  const manualComplete = !!soloState?.manualComplete;
  const cells = [];
  let filledCount = 0;
  let totalWhite = 0;
  let isComplete = manualComplete;

  for (let r = 0; r < dims.rows; r++) {
    for (let c = 0; c < dims.cols; c++) {
      if (grid[r][c] === '.') {
        cells.push(0);
        continue;
      }
      totalWhite++;
      const key = `${r},${c}`;
      const correct = rebus[key] || grid[r][c];
      const userLetter = storedGrid[key] || '';
      if (manualComplete) {
        cells.push(2);
        filledCount++;
        continue;
      }
      if (userLetter) {
        cells.push(2);
        filledCount++;
        if (userLetter !== correct) isComplete = false;
      } else {
        cells.push(1);
        isComplete = false;
      }
    }
  }

  if (totalWhite === 0) isComplete = false;

  return {
    date,
    rows: dims.rows,
    cols: dims.cols,
    cells,
    filledCount,
    totalWhite,
    isComplete,
  };
}

function getCurrentUserGridMap() {
  const map = {};
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const val = userGrid[r]?.[c];
      if (val) map[`${r},${c}`] = val;
    }
  }
  return map;
}

function getCurrentCheckedCellMap() {
  const map = {};
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (checkedCells[r]?.[c]) map[`${r},${c}`] = true;
    }
  }
  return map;
}

function updateCalendarSummaryForCurrentPuzzle() {
  if (!PUZZLE || !currentDate) return;
  const existing = loadSoloState(currentDate) || {};
  const summary = buildSoloProgressInfo(currentDate, {
    dimensions: { rows: ROWS, cols: COLS },
    grid: PUZZLE.grid,
    rebus: PUZZLE.rebus,
  }, {
    userGrid: getCurrentUserGridMap(),
    manualComplete: !!existing.manualComplete,
  });
  calendarData.set(currentDate, summary);
  const dayEl = document.querySelector(`.cal-day[data-date="${currentDate}"]`);
  if (dayEl && !dayEl.classList.contains('no-puzzle')) {
    dayEl.classList.toggle('complete', summary.isComplete);
    const canvas = dayEl.querySelector('canvas');
    if (canvas) drawThumbnail(canvas, summary);
  }
}

function populateSoloFillersFromGrid() {
  cellFillers.clear();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (userGrid[r]?.[c]) {
        cellFillers.set(`${r},${c}`, { userName: myName || 'You', color: myColor });
      }
    }
  }
}

function setActiveRoomContext(roomCode, puzzleDate) {
  activeSessionType = 'room';
  activeRoomCode = normalizeRoomCode(roomCode);
  activeRoomPuzzleDate = puzzleDate || '';
  activeSharedPuzzleDate = '';
  if (activeRoomCode && activeRoomPuzzleDate) {
    localStorage.setItem(ACTIVE_SESSION_TYPE_KEY, activeSessionType);
    localStorage.setItem(ACTIVE_ROOM_CODE_KEY, activeRoomCode);
    localStorage.setItem(ACTIVE_ROOM_PUZZLE_KEY, activeRoomPuzzleDate);
    localStorage.removeItem(ACTIVE_SHARED_PUZZLE_KEY);
  } else {
    localStorage.removeItem(ACTIVE_SESSION_TYPE_KEY);
    localStorage.removeItem(ACTIVE_ROOM_CODE_KEY);
    localStorage.removeItem(ACTIVE_ROOM_PUZZLE_KEY);
    localStorage.removeItem(ACTIVE_SHARED_PUZZLE_KEY);
  }
  if (appStarted) updateModeUI();
}

function setActiveSharedContext(puzzleDate) {
  activeSessionType = puzzleDate ? 'shared' : '';
  activeSharedPuzzleDate = puzzleDate || '';
  activeRoomCode = '';
  activeRoomPuzzleDate = '';
  if (activeSharedPuzzleDate) {
    localStorage.setItem(ACTIVE_SESSION_TYPE_KEY, activeSessionType);
    localStorage.setItem(ACTIVE_SHARED_PUZZLE_KEY, activeSharedPuzzleDate);
    localStorage.removeItem(ACTIVE_ROOM_CODE_KEY);
    localStorage.removeItem(ACTIVE_ROOM_PUZZLE_KEY);
  } else {
    localStorage.removeItem(ACTIVE_SESSION_TYPE_KEY);
    localStorage.removeItem(ACTIVE_SHARED_PUZZLE_KEY);
    localStorage.removeItem(ACTIVE_ROOM_CODE_KEY);
    localStorage.removeItem(ACTIVE_ROOM_PUZZLE_KEY);
  }
  if (appStarted) updateModeUI();
}

function setHomeSolveMode(mode) {
  homeSolveMode = mode === 'communal' ? 'communal' : 'local';
  localStorage.setItem(HOME_SOLVE_MODE_KEY, homeSolveMode);
  if (typeof syncCalendarModeTabs === 'function') {
    syncCalendarModeTabs();
  }
}

function clearActiveRoomContext() {
  activeSessionType = '';
  activeRoomCode = '';
  activeRoomPuzzleDate = '';
  activeSharedPuzzleDate = '';
  localStorage.removeItem(ACTIVE_SESSION_TYPE_KEY);
  localStorage.removeItem(ACTIVE_ROOM_CODE_KEY);
  localStorage.removeItem(ACTIVE_ROOM_PUZZLE_KEY);
  localStorage.removeItem(ACTIVE_SHARED_PUZZLE_KEY);
  if (appStarted) updateModeUI();
}

function isManuallyComplete(puzzleDate) {
  return !!loadSoloState(puzzleDate)?.manualComplete;
}

function setManualCompleteStatus(puzzleDate, complete) {
  if (!puzzleDate) return;
  const existing = loadSoloState(puzzleDate) || {};
  const nextState = {
    ...existing,
    manualComplete: !!complete,
  };
  if (PUZZLE && currentDate === puzzleDate) {
    nextState.userGrid = nextState.userGrid || getCurrentUserGridMap();
    nextState.checkedCells = nextState.checkedCells || getCurrentCheckedCellMap();
    nextState.timerSeconds = typeof nextState.timerSeconds === 'number' ? nextState.timerSeconds : getTimerSeconds();
    nextState.updatedAt = new Date().toISOString();
    nextState.summary = buildSoloProgressInfo(puzzleDate, {
      dimensions: { rows: ROWS, cols: COLS },
      grid: PUZZLE.grid,
      rebus: PUZZLE.rebus,
    }, {
      userGrid: nextState.userGrid,
      manualComplete: nextState.manualComplete,
    });
  }
  localStorage.setItem(getSoloStateKey(puzzleDate), JSON.stringify(nextState));
  if (PUZZLE && currentDate === puzzleDate) {
    updateCalendarSummaryForCurrentPuzzle();
  } else {
    fetchAndRenderCalendar();
  }
}
