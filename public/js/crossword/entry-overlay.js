function renderAiBotList() {
  const listEl = document.getElementById('entry-ai-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  for (const bot of aiBotList) {
    const item = document.createElement('div');
    item.className = 'entry-ai-item';
    item.innerHTML = `<span class="ai-dot" style="background:${bot.color}"></span><span class="ai-name">${bot.name}</span><span class="ai-badge">BOT</span><span class="ai-difficulty">${bot.difficultyLabel}</span><button class="ai-remove" data-bot-id="${bot.botId}">&times;</button>`;
    listEl.appendChild(item);
  }
  listEl.querySelectorAll('.ai-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      if (socket && currentDate && activeRoomCode) {
        socket.emit('remove-ai', { roomCode: activeRoomCode, botId: btn.dataset.botId });
      }
    });
  });
}

function showPuzzleEntryOverlay(dateStr, paused) {
  const overlay = document.getElementById('puzzle-entry-overlay');
  const dateEl = document.getElementById('entry-date');
  const weekdayEl = document.getElementById('entry-weekday');
  const metaEl2 = document.getElementById('entry-meta');
  const playersEl = document.getElementById('entry-players');
  const userPreviewEl = document.getElementById('entry-user-preview');
  const roomCodeEl = document.getElementById('entry-room-code');
  const aiSectionEl = document.getElementById('entry-ai-section');
  const baseStartBtn = document.getElementById('entry-start-btn');
  const baseChangeNameBtn = document.getElementById('entry-change-name');
  const baseMultiplayerBtn = document.getElementById('entry-multiplayer-btn');
  const baseMarkCompleteBtn = document.getElementById('entry-mark-complete');
  const baseCopyCodeBtn = document.getElementById('entry-copy-code');
  const baseAddBotBtn = document.getElementById('entry-ai-add-btn');
  const startBtn = baseStartBtn.cloneNode(true);
  const changeNameBtn = baseChangeNameBtn.cloneNode(true);
  const multiplayerBtn = baseMultiplayerBtn.cloneNode(true);
  const markCompleteBtn = baseMarkCompleteBtn.cloneNode(true);
  const copyCodeBtn = baseCopyCodeBtn.cloneNode(true);
  const addBotBtn = baseAddBotBtn.cloneNode(true);
  baseStartBtn.parentNode.replaceChild(startBtn, baseStartBtn);
  baseChangeNameBtn.parentNode.replaceChild(changeNameBtn, baseChangeNameBtn);
  baseMultiplayerBtn.parentNode.replaceChild(multiplayerBtn, baseMultiplayerBtn);
  baseMarkCompleteBtn.parentNode.replaceChild(markCompleteBtn, baseMarkCompleteBtn);
  baseCopyCodeBtn.parentNode.replaceChild(copyCodeBtn, baseCopyCodeBtn);
  baseAddBotBtn.parentNode.replaceChild(addBotBtn, baseAddBotBtn);
  const isRoomMode = !!activeRoomCode && activeRoomPuzzleDate === dateStr;
  startBtn.textContent = paused
    ? (isRoomMode ? 'Resume Room' : 'Resume Solo')
    : (isRoomMode ? 'Start Room' : 'Start Solo');

  const [y, m, d] = dateStr.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const weekday = DAYS[dateObj.getDay()];
  const monthName = MONTH_NAMES[m - 1];

  weekdayEl.textContent = weekday;
  dateEl.textContent = `${monthName} ${d}, ${y}`;
  metaEl2.textContent = '';

  if (myName) {
    userPreviewEl.innerHTML = `<span class="entry-user-dot" style="background:${myColor}"></span>Playing as ${myName}`;
    userPreviewEl.style.display = '';
  } else {
    userPreviewEl.style.display = 'none';
  }

  playersEl.innerHTML = '';
  if (!isRoomMode) {
    playersEl.innerHTML = '<div class="entry-no-players">Solo mode saves progress in this browser only</div>';
  } else {
    const count = remoteUsers.size + 1;
    if (count > 0) {
      const el = document.createElement('div');
      el.className = 'entry-player';
      el.innerHTML = `<span class="entry-player-dot" style="background:#2a6dd4"></span>${count} player${count > 1 ? 's' : ''} in room`;
      playersEl.appendChild(el);
    } else {
      playersEl.innerHTML = '<div class="entry-no-players">Waiting for players to join</div>';
    }
  }

  roomCodeEl.style.display = isRoomMode ? '' : 'none';
  roomCodeEl.textContent = isRoomMode ? `ROOM ${activeRoomCode}` : '';

  overlay.classList.add('show');
  aiSectionEl.style.display = isRoomMode ? '' : 'none';
  multiplayerBtn.style.display = isRoomMode ? 'none' : '';
  copyCodeBtn.style.display = isRoomMode ? '' : 'none';
  markCompleteBtn.textContent = isManuallyComplete(dateStr) ? 'Mark Incomplete' : 'Mark Complete';

  if (isRoomMode && socket && activeRoomCode) {
    socket.emit('get-ai-bots', { roomCode: activeRoomCode });
  }

  const diffSelect = document.getElementById('entry-ai-difficulty');
  const handleAddBot = () => {
    if (isRoomMode && socket && activeRoomCode) {
      socket.emit('add-ai', { roomCode: activeRoomCode, difficultyIndex: parseInt(diffSelect.value, 10) });
    }
  };
  addBotBtn.addEventListener('click', handleAddBot);

  fetch('/api/puzzles').then(r => r.json()).then(puzzles => {
    const puzzle = puzzles.find(p => p.date === dateStr);
    if (puzzle) {
      const parts = [];
      if (puzzle.author) parts.push(`By ${puzzle.author}`);
      if (puzzle.editor) parts.push(`Edited by ${puzzle.editor}`);
      metaEl2.textContent = parts.join(' \u00B7 ');
    }
  }).catch(() => {});

  const handleStart = () => {
    overlay.classList.remove('show');
    if (paused && isLocalSoloMode()) {
      timerBaseTime = Date.now();
      startTimerTick();
    } else if (paused && socket && currentDate && activeRoomCode) {
      socket.emit('resume-puzzle', { roomCode: activeRoomCode });
      startTimerTick();
    } else if (isRoomMode && socket && activeRoomCode && aiBotList.length > 0) {
      socket.emit('start-ai', { roomCode: activeRoomCode });
    }
    setTimeout(() => focusGrid(), 50);
  };

  const handleChangeName = () => {
    showNameModal(true);
    const observer = new MutationObserver(() => {
      if (!document.getElementById('name-modal').classList.contains('show')) {
        observer.disconnect();
        if (myName) {
          userPreviewEl.innerHTML = `<span class="entry-user-dot" style="background:${myColor}"></span>Playing as ${myName}`;
          userPreviewEl.style.display = '';
        }
      }
    });
    observer.observe(document.getElementById('name-modal'), { attributes: true, attributeFilter: ['class'] });
  };

  const handleMakeMultiplayer = async () => {
    try {
      const seedState = loadSoloState(dateStr) || {
        userGrid: currentDate === dateStr ? getCurrentUserGridMap() : {},
        checkedCells: currentDate === dateStr ? getCurrentCheckedCellMap() : {},
        timerSeconds: currentDate === dateStr ? getTimerSeconds() : 0,
      };
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID },
        body: JSON.stringify({ puzzleDate: dateStr, seedState }),
      });
      if (!res.ok) {
        alert('Failed to create room');
        return;
      }
      const data = await res.json();
      setActiveRoomContext(data.roomCode, data.puzzleDate);
      ensureSocketState();
      await loadPuzzle(dateStr);
      showPuzzleEntryOverlay(dateStr, paused);
    } catch (err) {
      alert('Failed to create room');
    }
  };

  const handleCopyCode = async () => {
    if (!activeRoomCode) return;
    try {
      await navigator.clipboard.writeText(activeRoomCode);
      copyCodeBtn.textContent = 'Copied';
      setTimeout(() => { copyCodeBtn.textContent = 'Copy Room Code'; }, 1200);
    } catch (err) {
      copyCodeBtn.textContent = activeRoomCode;
    }
  };

  const handleToggleManualComplete = () => {
    setManualCompleteStatus(dateStr, !isManuallyComplete(dateStr));
    markCompleteBtn.textContent = isManuallyComplete(dateStr) ? 'Mark Incomplete' : 'Mark Complete';
  };

  startBtn.addEventListener('click', handleStart);
  changeNameBtn.addEventListener('click', handleChangeName);
  multiplayerBtn.addEventListener('click', handleMakeMultiplayer);
  copyCodeBtn.addEventListener('click', handleCopyCode);
  markCompleteBtn.addEventListener('click', handleToggleManualComplete);
}
