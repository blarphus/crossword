function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function syncCalendarModeTabs() {
  const isCommunal = homeSolveMode === 'communal';
  calendarModeLocalEl.classList.toggle('active', !isCommunal);
  calendarModeLocalEl.setAttribute('aria-selected', String(!isCommunal));
  calendarModeCommunalEl.classList.toggle('active', isCommunal);
  calendarModeCommunalEl.setAttribute('aria-selected', String(isCommunal));
}

function openPuzzleFromCalendar(dateStr) {
  if (homeSolveMode === 'communal') {
    setActiveSharedContext(dateStr);
  } else if (!isRoomMode()) {
    clearActiveRoomContext();
  }
  showPuzzle(dateStr, true, true);
}

function cloneCalendarSummary(summary) {
  return {
    ...summary,
    cells: Array.isArray(summary.cells) ? summary.cells.slice() : [],
  };
}

function normalizeSoloCalendarTemplateItem(item) {
  return {
    date: item.date,
    rows: item.rows,
    cols: item.cols,
    cells: item.cells.map(cell => cell === 0 ? 0 : 1),
    filledCount: 0,
    totalWhite: item.totalWhite,
    isComplete: false,
  };
}

async function getSoloCalendarTemplate(yearMonth) {
  if (soloCalendarTemplateCache.has(yearMonth)) {
    return soloCalendarTemplateCache.get(yearMonth);
  }

  const stored = localStorage.getItem(getSoloCalendarTemplateKey(yearMonth));
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      soloCalendarTemplateCache.set(yearMonth, parsed);
      return parsed;
    } catch (err) {
      localStorage.removeItem(getSoloCalendarTemplateKey(yearMonth));
    }
  }

  const res = await fetch(`/api/calendar/${yearMonth}`);
  const data = await res.json();
  const normalized = data.map(normalizeSoloCalendarTemplateItem);
  soloCalendarTemplateCache.set(yearMonth, normalized);
  localStorage.setItem(getSoloCalendarTemplateKey(yearMonth), JSON.stringify(normalized));
  return normalized;
}

function initCalendarNav() {
  const monthSel = document.getElementById('cal-month');
  const yearSel = document.getElementById('cal-year');

  for (let m = 0; m < 12; m++) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = MONTH_NAMES[m];
    monthSel.appendChild(opt);
  }

  const thisYear = new Date().getFullYear();
  for (let y = thisYear - 5; y <= thisYear + 1; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    yearSel.appendChild(opt);
  }

  const savedYM = localStorage.getItem('crossword-calendar-month');
  const now = new Date();
  if (savedYM) {
    const [sy, sm] = savedYM.split('-').map(Number);
    calendarYear = sy;
    calendarMonth = sm;
  } else {
    calendarYear = now.getFullYear();
    calendarMonth = now.getMonth();
  }
  monthSel.value = calendarMonth;
  yearSel.value = calendarYear;
  syncCalendarModeTabs();

  calendarModeLocalEl.addEventListener('click', () => setHomeSolveMode('local'));
  calendarModeCommunalEl.addEventListener('click', () => setHomeSolveMode('communal'));

  monthSel.addEventListener('change', () => {
    calendarMonth = parseInt(monthSel.value, 10);
    fetchAndRenderCalendar();
  });
  yearSel.addEventListener('change', () => {
    calendarYear = parseInt(yearSel.value, 10);
    fetchAndRenderCalendar();
  });

  document.getElementById('cal-prev').addEventListener('click', () => {
    calendarMonth--;
    if (calendarMonth < 0) {
      calendarMonth = 11;
      calendarYear--;
    }
    syncCalendarSelects();
    fetchAndRenderCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    calendarMonth++;
    if (calendarMonth > 11) {
      calendarMonth = 0;
      calendarYear++;
    }
    syncCalendarSelects();
    fetchAndRenderCalendar();
  });
  document.getElementById('cal-today').addEventListener('click', () => {
    const nowDate = new Date();
    calendarYear = nowDate.getFullYear();
    calendarMonth = nowDate.getMonth();
    syncCalendarSelects();
    fetchAndRenderCalendar();
  });

  const joinRoom = async () => {
    const roomCode = normalizeRoomCode(roomCodeInputEl.value);
    if (!roomCode) return;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomCode)}`);
      if (!res.ok) {
        alert('Room not found');
        return;
      }
      const data = await res.json();
      setActiveRoomContext(data.roomCode, data.puzzleDate);
      roomCodeInputEl.value = '';
      showPuzzle(data.puzzleDate, true, true);
    } catch (err) {
      alert('Failed to join room');
    }
  };

  roomCodeSubmitEl.addEventListener('click', joinRoom);
  roomCodeInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });
}

function syncCalendarSelects() {
  document.getElementById('cal-month').value = calendarMonth;
  document.getElementById('cal-year').value = calendarYear;
  const now = new Date();
  const isCurrent = calendarYear === now.getFullYear() && calendarMonth === now.getMonth();
  document.getElementById('cal-today').disabled = isCurrent;
}

async function fetchAndRenderCalendar() {
  localStorage.setItem('crossword-calendar-month', `${calendarYear}-${calendarMonth}`);
  const ym = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}`;
  for (const [key] of calendarData) {
    if (key.startsWith(ym)) calendarData.delete(key);
  }

  try {
    const template = await getSoloCalendarTemplate(ym);
    for (const item of template) {
      const localSummary = loadSoloState(item.date)?.summary;
      calendarData.set(item.date, cloneCalendarSummary(localSummary || item));
    }
  } catch (e) {
    // Ignore calendar fetch failures so the rest of the app can still render.
  }
  renderCalendar();
  syncCalendarSelects();
}

function renderCalendar() {
  calendarGridEl.innerHTML = '';

  const today = todayET();
  const firstDay = new Date(calendarYear, calendarMonth, 1).getDay();
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();

  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    calendarGridEl.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const info = calendarData.get(dateStr);

    const dayEl = document.createElement('div');
    dayEl.className = 'cal-day';
    dayEl.dataset.date = dateStr;

    if (dateStr === today) dayEl.classList.add('today');

    const numEl = document.createElement('span');
    numEl.className = 'day-number';
    numEl.textContent = day;
    dayEl.appendChild(numEl);

    if (info) {
      if (info.isComplete) dayEl.classList.add('complete');

      const canvas = document.createElement('canvas');
      canvas.width = info.cols;
      canvas.height = info.rows;
      drawThumbnail(canvas, info);
      dayEl.appendChild(canvas);

      const star = document.createElement('div');
      star.className = 'star-overlay';
      star.textContent = '\u2B50';
      dayEl.appendChild(star);

      dayEl.addEventListener('click', () => openPuzzleFromCalendar(dateStr));
    } else {
      dayEl.classList.add('no-puzzle');
    }

    calendarGridEl.appendChild(dayEl);
  }
}

function drawThumbnail(canvas, info) {
  const ctx = canvas.getContext('2d');
  const { rows, cols, cells, filledCount, isComplete } = info;
  const hasProgress = filledCount > 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const val = cells[r * cols + c];
      if (val === 0) {
        ctx.fillStyle = '#4a4a4a';
      } else if (isComplete) {
        ctx.fillStyle = val === 2 ? '#2a5599' : '#4a7abf';
      } else if (hasProgress) {
        ctx.fillStyle = val === 2 ? '#5b9bd5' : '#ffffff';
      } else {
        ctx.fillStyle = '#c8c8c8';
      }
      ctx.fillRect(c, r, 1, 1);
    }
  }
}
