function startHintTimer() {
  lastWordCompletionTime = Date.now();
  hintVoted = false;
  if (hintCheckInterval) clearInterval(hintCheckInterval);
  hintCheckInterval = setInterval(() => {
    if (solved) {
      hideHintBtn();
      return;
    }
    const elapsed = Date.now() - lastWordCompletionTime;
    if (elapsed >= 60000) {
      showHintBtn();
      const payload = getLivePuzzlePayload();
      if (payload && socket) {
        socket.emit('hint-available', payload);
      }
    }
  }, 5000);
}

function resetHintTimer() {
  lastWordCompletionTime = Date.now();
  hintVoted = false;
  hideHintBtn();
}

function showHintBtn() {
  const btn = document.getElementById('hint-btn');
  if (btn) {
    btn.classList.add('show');
    btn.classList.toggle('voted', hintVoted);
    updateHintVoteText(0, 0);
  }
}

function hideHintBtn() {
  const btn = document.getElementById('hint-btn');
  if (btn) {
    btn.classList.remove('show');
    btn.classList.remove('voted');
  }
  hintVoted = false;
}

function updateHintVoteText(votes, total) {
  const el = document.getElementById('hint-votes');
  if (!el) return;
  if (votes > 0 || total > 0) {
    el.textContent = `${votes}/${total}`;
  } else {
    el.textContent = 'Hint';
  }
}

function voteForHint() {
  if (!PUZZLE || !currentDate || hintVoted) return;
  hintVoted = true;
  const btn = document.getElementById('hint-btn');
  if (btn) btn.classList.add('voted');
  if (isLocalSoloMode()) {
    const candidates = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (isBlack(r, c)) continue;
        const key = `${r},${c}`;
        if (hintCells.has(key)) continue;
        const correct = getCorrectAnswer(r, c);
        if (userGrid[r][c] !== correct) {
          candidates.push({ row: r, col: c, letter: correct });
        }
      }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    applyHintReveal(candidates.slice(0, 5));
    return;
  }
  const payload = getLivePuzzlePayload();
  if (payload && socket) socket.emit('hint-vote', payload);
}

function applyHintReveal(cells) {
  lastWordCompletionTime = Date.now();
  hintVoted = false;

  const btn = document.getElementById('hint-btn');
  const btnRect = btn ? btn.getBoundingClientRect() : null;
  const btnX = btnRect ? btnRect.left + btnRect.width / 2 : 0;
  const btnY = btnRect ? btnRect.top + btnRect.height / 2 : 0;

  hideHintBtn();

  const cellSize = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cell-size'), 10) || 32;

  cells.forEach(({ row: r, col: c, letter }, i) => {
    const key = `${r},${c}`;
    hintCells.add(key);
    userGrid[r][c] = letter;

    const cellEl = cellEls[r]?.[c];
    if (!cellEl || !btnRect) return;

    const targetRect = cellEl.getBoundingClientRect();
    const flyer = document.createElement('div');
    flyer.className = 'hint-flyer';
    flyer.textContent = letter;
    flyer.style.width = `${cellSize}px`;
    flyer.style.height = `${cellSize}px`;
    flyer.style.fontSize = `${cellSize * 0.5}px`;
    flyer.style.left = `${btnX - cellSize / 2}px`;
    flyer.style.top = `${btnY - cellSize / 2}px`;
    flyer.style.transform = 'scale(0.3)';
    flyer.style.opacity = '0.6';
    document.body.appendChild(flyer);

    let glitterInterval;
    setTimeout(() => {
      flyer.style.left = `${targetRect.left}px`;
      flyer.style.top = `${targetRect.top}px`;
      flyer.style.transform = 'scale(1)';
      flyer.style.opacity = '1';
      glitterInterval = setInterval(() => {
        const rect = flyer.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        for (let p = 0; p < 2; p++) {
          const spark = document.createElement('div');
          spark.className = 'hint-glitter';
          const ox = (Math.random() - 0.5) * cellSize;
          const oy = (Math.random() - 0.5) * cellSize;
          spark.style.left = `${cx + ox}px`;
          spark.style.top = `${cy + oy}px`;
          spark.style.setProperty('--dx', `${(Math.random() - 0.5) * 20}px`);
          spark.style.setProperty('--dy', `${(Math.random() - 0.5) * 20}px`);
          spark.style.width = `${3 + Math.random() * 5}px`;
          spark.style.height = spark.style.width;
          document.body.appendChild(spark);
          spark.addEventListener('animationend', () => spark.remove());
        }
      }, 40);
    }, i * 100);

    setTimeout(() => {
      if (glitterInterval) clearInterval(glitterInterval);
      flyer.remove();
      render();
    }, i * 100 + 650);
  });

  setTimeout(() => {
    refreshCheckedCells();
    if (isLocalSoloMode()) populateSoloFillersFromGrid();
    saveSoloState(currentDate);
    render();
    checkCompletion();
  }, cells.length * 100 + 700);
}
