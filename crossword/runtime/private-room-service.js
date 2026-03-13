function createPrivateRoomService({
  db,
  io,
  fireStreaks,
  chatThrottle,
  getPuzzleData,
  getCorrectAnswer,
  isCellCorrectServer,
  getServerWordCells,
  colorPool,
  aiTargetTimes,
  aiMultiplierRanges,
  aiNames,
  aiDifficultyLabels,
  buildAiWordQueue,
  distributeAiTiming,
  randomHop,
}) {
  const privateRooms = new Map();
  const socketPrivateRoom = new Map();
  let privateRoomCodeCounter = 0;
  let privateAiBotCounter = 0;

  function normalizeRoomCode(raw) {
    return String(raw || '').trim().toUpperCase();
  }

  function privateRoomChannel(roomCode) {
    return `room:${roomCode}`;
  }

  function generatePrivateRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      if (!privateRooms.has(code)) return code;
    }
    return `R${(++privateRoomCodeCounter).toString(36).toUpperCase().padStart(5, '0')}`.slice(0, 6);
  }

  function sanitizeRoomSeedState(seedState, userName) {
    const sanitizedGrid = {};
    const rawGrid = seedState?.userGrid && typeof seedState.userGrid === 'object' ? seedState.userGrid : {};
    for (const [key, val] of Object.entries(rawGrid)) {
      if (typeof val === 'string' && val) sanitizedGrid[key] = val;
    }

    const checkedCells = {};
    const rawChecked = seedState?.checkedCells && typeof seedState.checkedCells === 'object' ? seedState.checkedCells : {};
    for (const [key, val] of Object.entries(rawChecked)) {
      if (val) checkedCells[key] = true;
    }

    const cellFillers = {};
    for (const key of Object.keys(sanitizedGrid)) {
      cellFillers[key] = userName;
    }

    return {
      userGrid: sanitizedGrid,
      checkedCells,
      cellFillers,
      points: {},
      guesses: {},
      timerSeconds: Math.max(0, Math.floor(seedState?.timerSeconds || 0)),
    };
  }

  function buildPrivateRoomUserColors(room) {
    const colors = {};
    for (const [, member] of room.members) {
      if (member.userName) colors[member.userName] = member.color;
    }
    for (const fillerName of Object.values(room.cellFillers)) {
      if (!colors[fillerName]) {
        for (const [, member] of room.members) {
          if (member.userName === fillerName) {
            colors[fillerName] = member.color;
            break;
          }
        }
      }
    }
    return colors;
  }

  function getPrivateRoomElapsedSeconds(room) {
    if (!room) return 0;
    const running = room.timerStartedAt ? (Date.now() - room.timerStartedAt) / 1000 : 0;
    return Math.floor(room.timerAccumulated + running);
  }

  function getPrivateRealPlayerCount(room) {
    if (!room) return 0;
    let count = 0;
    for (const [, member] of room.members) {
      if (!member.isBot) count++;
    }
    return count;
  }

  function buildPrivateRoomSnapshot(room) {
    return {
      roomCode: room.roomCode,
      puzzleDate: room.puzzleDate,
      userGrid: { ...room.userGrid },
      cellFillers: { ...room.cellFillers },
      points: { ...room.points },
      guesses: JSON.parse(JSON.stringify(room.guesses)),
      checkedCells: { ...room.checkedCells },
      userColors: buildPrivateRoomUserColors(room),
      timerSeconds: getPrivateRoomElapsedSeconds(room),
      playerCount: getPrivateRealPlayerCount(room),
    };
  }

  function createPrivateRoom({ puzzleDate, userName, userColor, seedState }) {
    const roomCode = generatePrivateRoomCode();
    const seeded = sanitizeRoomSeedState(seedState, userName);
    const room = {
      roomCode,
      puzzleDate,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userGrid: seeded.userGrid,
      checkedCells: seeded.checkedCells,
      cellFillers: seeded.cellFillers,
      points: seeded.points,
      guesses: seeded.guesses,
      timerAccumulated: seeded.timerSeconds,
      timerStartedAt: 0,
      members: new Map(),
      pausedSockets: new Set(),
      hintState: { votes: new Set(), hintCells: new Set(), available: false },
      aiBots: new Map(),
      creatorName: userName,
      creatorColor: userColor,
    };
    privateRooms.set(roomCode, room);
    return room;
  }

  function startPrivateRoomTimer(room) {
    if (!room || room.timerStartedAt) return;
    room.timerStartedAt = Date.now();
  }

  function stopPrivateRoomTimer(room) {
    if (!room || !room.timerStartedAt) return;
    room.timerAccumulated = getPrivateRoomElapsedSeconds(room);
    room.timerStartedAt = 0;
  }

  function areAllPrivatePlayersPaused(room) {
    if (!room || room.members.size === 0) return false;
    const realCount = getPrivateRealPlayerCount(room);
    if (realCount === 0) return false;
    return room.pausedSockets.size >= realCount;
  }

  function checkPrivateWordCompletions(room, row, col, puzzleData) {
    const userGrid = room.userGrid || {};
    let completed = 0;
    const completedWordCells = [];

    for (const dir of ['across', 'down']) {
      for (const clue of puzzleData.clues[dir]) {
        const cells = getServerWordCells(puzzleData, clue, dir);
        if (!cells.some(([r, c]) => r === row && c === col)) continue;
        const allCorrect = cells.every(([r, c]) => isCellCorrectServer(puzzleData, r, c, userGrid[`${r},${c}`]));
        if (allCorrect) {
          completed++;
          for (const [r, c] of cells) completedWordCells.push({ row: r, col: c });
        }
      }
    }

    return { completed, completedWordCells };
  }

  function getNextColorFromMembers(members) {
    const usedColors = new Set();
    for (const user of members.values()) {
      usedColors.add(user.color);
    }
    for (const color of colorPool) {
      if (!usedColors.has(color)) return color;
    }
    return colorPool[members.size % colorPool.length];
  }

  function expirePrivateFire(socketId) {
    const fs = fireStreaks.get(socketId);
    if (!fs || !fs.onFire || !fs.roomCode) return;
    if (fs.fireTimer) clearTimeout(fs.fireTimer);
    const fireCells = fs.fireCells.slice();
    fs.onFire = false;
    fs.fireExpiresAt = 0;
    fs.fireCells = [];
    fs.fireTimer = null;
    fs.recentWordCompletions = [];
    fs.fireMultiplier = 1.5;
    fs.fireWordsCompleted = 0;
    io.to(privateRoomChannel(fs.roomCode)).emit('fire-expired', {
      socketId,
      userName: fs.userName,
      color: fs.color,
      fireCells,
    });
  }

  function addPrivatePoints(room, userName, delta) {
    if (!delta) return;
    room.points[userName] = (room.points[userName] || 0) + delta;
  }

  function addPrivateGuess(room, userName, isCorrect) {
    if (!room.guesses[userName]) room.guesses[userName] = { total: 0, incorrect: 0 };
    room.guesses[userName].total++;
    if (!isCorrect) room.guesses[userName].incorrect++;
  }

  function deletePrivateRoom(roomCode) {
    const room = privateRooms.get(roomCode);
    if (!room) return;
    removeAllPrivateAiBots(roomCode);
    privateRooms.delete(roomCode);
  }

  async function processPrivateRoomCellUpdate({ roomCode, row, col, letter, socketId, userName, userColor, isBot }) {
    const room = privateRooms.get(roomCode);
    if (!room) return { pointDelta: 0, wordBonus: 0, fireEvent: null, guessCorrect: null, lastSquareBonus: 0, payload: null };
    const puzzleData = await getPuzzleData(room.puzzleDate);
    if (!puzzleData) return { pointDelta: 0, wordBonus: 0, fireEvent: null, guessCorrect: null, lastSquareBonus: 0, payload: null };

    const correctAnswer = getCorrectAnswer(puzzleData, row, col);
    if (correctAnswer) {
      const currentLetter = room.userGrid[`${row},${col}`];
      if (currentLetter === correctAnswer && letter !== correctAnswer) {
        return { pointDelta: 0, wordBonus: 0, fireEvent: null, guessCorrect: null, lastSquareBonus: 0, payload: null };
      }
    }

    let pointDelta = 0;
    let wordBonus = 0;
    let fireEvent = null;
    let guessCorrect = null;
    const now = Date.now();
    const cellKey = `${row},${col}`;

    if (letter === '') {
      delete room.userGrid[cellKey];
      delete room.cellFillers[cellKey];
      delete room.checkedCells[cellKey];
    } else {
      room.userGrid[cellKey] = letter;
      room.cellFillers[cellKey] = userName;
      if (correctAnswer && letter === correctAnswer) room.checkedCells[cellKey] = true;
    }
    room.updatedAt = now;

    let fs = fireStreaks.get(socketId);
    if (!fs) {
      fs = {
        roomCode,
        puzzleDate: room.puzzleDate,
        userName,
        color: userColor,
        recentWordCompletions: [],
        onFire: false,
        fireExpiresAt: 0,
        fireCells: [],
        fireTimer: null,
        fireMultiplier: 1.5,
        fireWordsCompleted: 0,
      };
      fireStreaks.set(socketId, fs);
    }

    const isHintCell = room.hintState.hintCells.has(cellKey);
    if (letter && !isHintCell) {
      const isCorrect = isCellCorrectServer(puzzleData, row, col, letter);
      const isRebus = !!puzzleData.rebus[cellKey] && letter.length > 1;
      const basePts = isRebus ? 50 : 10;
      guessCorrect = isCorrect;
      const wasOnFire = fs.onFire;

      if (isCorrect && fs.onFire) {
        pointDelta = Math.round(basePts * fs.fireMultiplier);
        fs.fireCells.push({ row, col });
      } else if (isCorrect) {
        pointDelta = basePts;
      } else if (fs.onFire) {
        if (fs.fireTimer) clearTimeout(fs.fireTimer);
        fireEvent = { type: 'broken', userName, color: userColor, fireCells: fs.fireCells.slice() };
        fs.onFire = false;
        fs.fireExpiresAt = 0;
        fs.fireCells = [];
        fs.fireTimer = null;
        fs.recentWordCompletions = [];
        fs.fireMultiplier = 1.5;
        fs.fireWordsCompleted = 0;
        pointDelta = -30;
      } else {
        fs.recentWordCompletions = [];
        pointDelta = -30;
      }

      addPrivatePoints(room, userName, pointDelta);
      addPrivateGuess(room, userName, isCorrect);

      if (isCorrect) {
        const { completed, completedWordCells } = checkPrivateWordCompletions(room, row, col, puzzleData);
        if (completed >= 2) wordBonus = 250;
        else if (completed === 1) wordBonus = 50;
        if (wordBonus && wasOnFire) wordBonus = Math.round(wordBonus * fs.fireMultiplier);

        if (wordBonus) {
          addPrivatePoints(room, userName, wordBonus);
          room.hintState.available = false;
          room.hintState.votes.clear();

          if (fs.onFire && wasOnFire) {
            fs.fireWordsCompleted += completed;
            fs.fireMultiplier = 1.5 + Math.floor(fs.fireWordsCompleted / 3) * 0.5;
            fs.fireExpiresAt = Math.min(fs.fireExpiresAt + 5000, now + 30000);
            for (const wc of completedWordCells) fs.fireCells.push(wc);
            if (fs.fireTimer) clearTimeout(fs.fireTimer);
            const remainingMs = fs.fireExpiresAt - now;
            fs.fireTimer = setTimeout(() => expirePrivateFire(socketId), remainingMs);
            fireEvent = { type: 'extended', userName, color: userColor, fireCells: fs.fireCells.slice(), remainingMs, fireMultiplier: fs.fireMultiplier };
          } else if (!fs.onFire) {
            fs.recentWordCompletions.push({ timestamp: now, count: completed, wordCells: completedWordCells });
            fs.recentWordCompletions = fs.recentWordCompletions.filter(entry => now - entry.timestamp < 30000);
            const totalCompletions = fs.recentWordCompletions.reduce((sum, entry) => sum + entry.count, 0);
            if (totalCompletions >= 3) {
              fs.onFire = true;
              fs.fireExpiresAt = now + 30000;
              fs.fireCells = [];
              fs.fireMultiplier = 1.5;
              fs.fireWordsCompleted = 0;
              fs.fireTimer = setTimeout(() => expirePrivateFire(socketId), 30000);
              fireEvent = { type: 'started', userName, color: userColor, fireCells: [], remainingMs: 30000, fireMultiplier: 1.5 };
              fs.recentWordCompletions = [];
            }
          }
        }
      }
    }

    let lastSquareBonus = 0;
    if (letter && guessCorrect) {
      let complete = true;
      for (let r = 0; r < puzzleData.dimensions.rows && complete; r++) {
        for (let c = 0; c < puzzleData.dimensions.cols && complete; c++) {
          if (puzzleData.grid[r][c] === '.') continue;
          if (room.userGrid[`${r},${c}`] !== getCorrectAnswer(puzzleData, r, c)) complete = false;
        }
      }
      if (complete) {
        lastSquareBonus = 250;
        addPrivatePoints(room, userName, lastSquareBonus);
        stopPrivateRoomTimer(room);
        io.to(privateRoomChannel(roomCode)).emit('timer-sync', { seconds: getPrivateRoomElapsedSeconds(room) });
        removeAllPrivateAiBots(roomCode);
      }
    }

    const payload = {
      roomCode,
      puzzleDate: room.puzzleDate,
      row,
      col,
      letter,
      userId: socketId,
      userName,
      color: userColor,
      pointDelta,
      wordBonus,
      fireEvent,
      guessCorrect,
      lastSquareBonus,
    };
    if (isBot) {
      io.to(privateRoomChannel(roomCode)).emit('cell-updated', payload);
    }

    return { pointDelta, wordBonus, fireEvent, guessCorrect, lastSquareBonus, payload };
  }

  function getPrivateAiBotList(roomCode) {
    const room = privateRooms.get(roomCode);
    if (!room) return [];
    return [...room.aiBots.values()].map(bot => ({
      botId: bot.botId,
      name: bot.name,
      color: bot.color,
      difficultyIndex: bot.difficultyIndex,
      difficultyLabel: aiDifficultyLabels[bot.difficultyIndex],
      started: bot.started,
    }));
  }

  function addPrivateAiBot(roomCode, difficultyIndex) {
    const room = privateRooms.get(roomCode);
    if (!room) return null;
    const botId = `ai-room-bot-${++privateAiBotCounter}`;
    const usedNames = new Set();
    for (const [, bot] of room.aiBots) usedNames.add(bot.name);
    const name = aiNames.find(candidate => !usedNames.has(candidate)) || `Bot-${privateAiBotCounter}`;
    const color = getNextColorFromMembers(room.members);
    const dateObj = new Date(`${room.puzzleDate}T12:00:00`);
    const dow = dateObj.getDay();
    const baseTime = aiTargetTimes[dow][difficultyIndex];
    const [lo, hi] = aiMultiplierRanges[difficultyIndex];
    const finalSolveTime = baseTime * (lo + Math.random() * (hi - lo));

    const bot = {
      botId,
      name,
      color,
      difficultyIndex,
      roomCode,
      puzzleDate: room.puzzleDate,
      finalSolveTime,
      timers: [],
      started: false,
      paused: false,
    };
    room.aiBots.set(botId, bot);
    room.members.set(botId, {
      userId: botId,
      userName: name,
      color,
      row: 0,
      col: 0,
      direction: 'across',
      isBot: true,
    });
    fireStreaks.set(botId, {
      roomCode,
      puzzleDate: room.puzzleDate,
      userName: name,
      color,
      recentWordCompletions: [],
      onFire: false,
      fireExpiresAt: 0,
      fireCells: [],
      fireTimer: null,
      fireMultiplier: 1.5,
      fireWordsCompleted: 0,
    });

    io.to(privateRoomChannel(roomCode)).emit('user-joined', {
      socketId: botId,
      userId: botId,
      userName: name,
      color,
      row: 0,
      col: 0,
      direction: 'across',
      isBot: true,
    });
    return bot;
  }

  function removePrivateAiBot(roomCode, botId) {
    const room = privateRooms.get(roomCode);
    if (!room) return;
    const bot = room.aiBots.get(botId);
    if (!bot) return;
    for (const timer of bot.timers) clearTimeout(timer);
    const fs = fireStreaks.get(botId);
    if (fs?.onFire) {
      if (fs.fireTimer) clearTimeout(fs.fireTimer);
      io.to(privateRoomChannel(roomCode)).emit('fire-expired', {
        socketId: botId,
        userName: bot.name,
        color: bot.color,
        fireCells: fs.fireCells,
      });
    }
    fireStreaks.delete(botId);
    room.aiBots.delete(botId);
    room.members.delete(botId);
    io.to(privateRoomChannel(roomCode)).emit('user-left', {
      userId: botId,
      userName: bot.name,
      socketId: botId,
    });
  }

  function removeAllPrivateAiBots(roomCode) {
    const room = privateRooms.get(roomCode);
    if (!room) return;
    for (const botId of [...room.aiBots.keys()]) removePrivateAiBot(roomCode, botId);
  }

  function pauseAllPrivateAiBots(roomCode) {
    const room = privateRooms.get(roomCode);
    if (!room) return;
    for (const [, bot] of room.aiBots) {
      for (const timer of bot.timers) clearTimeout(timer);
      bot.timers = [];
      bot.started = false;
      bot.paused = true;
    }
  }

  async function startPrivateAiSolving(roomCode) {
    const room = privateRooms.get(roomCode);
    if (!room) return;
    const puzzleData = await getPuzzleData(room.puzzleDate);
    if (!puzzleData) return;

    const usedStartWords = new Set();
    for (const [, bot] of room.aiBots) {
      if (bot.started) continue;
      bot.started = true;

      const wordQueue = buildAiWordQueue(puzzleData);
      if (usedStartWords.size > 0 && wordQueue.length > 1) {
        let rotateBy = 0;
        for (let i = 0; i < wordQueue.length; i++) {
          const key = `${wordQueue[i].cells[0][0]},${wordQueue[i].cells[0][1]}`;
          if (!usedStartWords.has(key)) {
            rotateBy = i;
            break;
          }
        }
        if (rotateBy > 0) {
          const head = wordQueue.splice(0, rotateBy);
          wordQueue.push(...head);
        }
      }
      if (wordQueue.length > 0) {
        usedStartWords.add(`${wordQueue[0].cells[0][0]},${wordQueue[0].cells[0][1]}`);
      }

      const allWords = wordQueue.map(word => ({
        cells: word.cells.map(([r, c]) => ({ row: r, col: c, letter: getCorrectAnswer(puzzleData, r, c) })),
        dir: word.dir,
      }));

      let estCells = 0;
      for (const word of allWords) estCells += word.cells.length;
      const timing = distributeAiTiming(estCells, bot.finalSolveTime);
      let cursorR = allWords[0]?.cells[0]?.row || 0;
      let cursorC = allWords[0]?.cells[0]?.col || 0;
      let cellIdx = 0;
      const dateObj = new Date(`${room.puzzleDate}T12:00:00`);
      const dow = dateObj.getDay();

      const isAlive = () => {
        const latestRoom = privateRooms.get(roomCode);
        return latestRoom && latestRoom.aiBots.has(bot.botId) && !bot.paused;
      };

      const emitCursor = (r, c, dir) => {
        const member = room.members.get(bot.botId);
        if (!member) return;
        member.row = r;
        member.col = c;
        member.direction = dir;
        io.to(privateRoomChannel(roomCode)).emit('cursor-moved', {
          socketId: bot.botId,
          userId: bot.botId,
          userName: bot.name,
          row: r,
          col: c,
          direction: dir,
        });
      };

      const baseWanderMs = [5000, 6000, 5000, 4000, 3500, 2500, 2000][dow];
      const wanderChanceByDifficulty = [
        [0.78, 0.52, 0.65, 0.61, 0.25],
        [0.40, 0.78, 0.75, 0.14, 0.36],
        [0.75, 0.80, 0.25, 0.42, 0.18],
        [0.72, 0.40, 0.74, 0.46, 0.27],
        [0.75, 0.78, 0.45, 0.46, 0.50],
        [0.75, 0.72, 0.75, 0.67, 0.50],
        [0.84, 0.80, 0.74, 0.55, 0.74],
      ];
      const wanderTimeByDifficulty = [
        [5712, 7221, 4537, 4166, 8000],
        [4291, 1839, 1519, 6958, 2130],
        [2871, 2267, 5684, 2913, 5328],
        [5256, 8000, 3368, 4682, 6319],
        [6611, 5332, 7292, 6119, 4486],
        [8000, 7104, 5357, 5161, 5496],
        [8000, 8000, 6867, 8000, 4711],
      ];

      const doWanderFor = (duration, cb) => {
        let wanderR = cursorR;
        let wanderC = cursorC;
        let elapsed = 0;
        const step = () => {
          if (!isAlive()) return;
          const hopDelay = 1500 + Math.random() * 2000;
          if (elapsed + hopDelay < duration) {
            const [hr, hc] = randomHop(puzzleData, wanderR, wanderC);
            wanderR = hr;
            wanderC = hc;
            emitCursor(hr, hc, Math.random() < 0.5 ? 'across' : 'down');
            elapsed += hopDelay;
            const timer = setTimeout(step, hopDelay);
            bot.timers.push(timer);
          } else {
            const timer = setTimeout(cb, Math.max(0, duration - elapsed));
            bot.timers.push(timer);
          }
        };
        const timer = setTimeout(step, 100);
        bot.timers.push(timer);
      };

      const processWord = (wordIndex) => {
        if (!isAlive() || wordIndex >= allWords.length) return;
        if (bot.timers.length > 100) bot.timers = bot.timers.slice(-50);

        const word = allWords[wordIndex];
        const startFilling = () => {
          emitCursor(word.cells[0].row, word.cells[0].col, word.dir);
          const timer = setTimeout(() => {
            startFillingWord(wordIndex, 0).catch(err => {
              console.error('[ai] room startFillingWord error:', err);
              processWord(wordIndex + 1);
            });
          }, 100);
          bot.timers.push(timer);
        };

        const base = baseWanderMs * (0.75 + Math.random() * 0.5);
        const extra = Math.random() < wanderChanceByDifficulty[dow][bot.difficultyIndex]
          ? wanderTimeByDifficulty[dow][bot.difficultyIndex]
          : (400 + Math.random() * 800);
        doWanderFor(base + extra, startFilling);

        const startFillingWord = async (wi, ci) => {
          if (!isAlive()) return;
          let nextCi = ci;
          while (nextCi < word.cells.length) {
            const cell = word.cells[nextCi];
            if (room.userGrid[`${cell.row},${cell.col}`] !== cell.letter) break;
            nextCi++;
            cellIdx++;
          }
          if (nextCi >= word.cells.length) {
            cursorR = word.cells[word.cells.length - 1].row;
            cursorC = word.cells[word.cells.length - 1].col;
            processWord(wi + 1);
            return;
          }
          const cell = word.cells[nextCi];
          const fillTime = timing.cellTimes[cellIdx] || 100;
          cellIdx++;
          const timer = setTimeout(async () => {
            if (!isAlive()) return;
            emitCursor(cell.row, cell.col, word.dir);
            await processPrivateRoomCellUpdate({
              roomCode,
              row: cell.row,
              col: cell.col,
              letter: cell.letter,
              socketId: bot.botId,
              userName: bot.name,
              userColor: bot.color,
              isBot: true,
            });
            startFillingWord(wi, nextCi + 1).catch(err => {
              console.error('[ai] room startFillingWord error:', err);
              processWord(wi + 1);
            });
          }, fillTime);
          bot.timers.push(timer);
        };
      };

      if (allWords.length) {
        doWanderFor(2000, () => processWord(0));
      }
    }
  }

  function resumeAllPrivateAiBots(roomCode) {
    const room = privateRooms.get(roomCode);
    if (!room) return;
    let resumed = false;
    for (const [, bot] of room.aiBots) {
      if (bot.paused) {
        bot.paused = false;
        resumed = true;
      }
    }
    if (resumed) {
      startPrivateAiSolving(roomCode).catch(err => console.error('[ai] startPrivateAiSolving error:', err));
    }
  }

  function leaveCurrentPrivateRoom(socket) {
    const roomCode = socketPrivateRoom.get(socket.id);
    if (!roomCode) return;
    const room = privateRooms.get(roomCode);
    socket.leave(privateRoomChannel(roomCode));
    socketPrivateRoom.delete(socket.id);
    chatThrottle.delete(socket.id);

    const fs = fireStreaks.get(socket.id);
    if (fs?.onFire) {
      if (fs.fireTimer) clearTimeout(fs.fireTimer);
      io.to(privateRoomChannel(roomCode)).emit('fire-expired', {
        socketId: socket.id,
        userName: fs.userName,
        color: fs.color,
        fireCells: fs.fireCells,
      });
    }
    fireStreaks.delete(socket.id);

    if (!room) return;
    room.hintState.votes.delete(socket.id);
    room.pausedSockets.delete(socket.id);
    room.members.delete(socket.id);

    socket.to(privateRoomChannel(roomCode)).emit('user-left', {
      userId: socket.handshake.query.userId,
      userName: socket.userName || 'Anonymous',
      socketId: socket.id,
    });

    if (getPrivateRealPlayerCount(room) === 0) {
      removeAllPrivateAiBots(roomCode);
      stopPrivateRoomTimer(room);
      if (room.members.size === 0) {
        deletePrivateRoom(roomCode);
        return;
      }
    } else if (areAllPrivatePlayersPaused(room)) {
      stopPrivateRoomTimer(room);
      pauseAllPrivateAiBots(roomCode);
    }

    if (room.hintState.available && room.hintState.votes.size > 0) {
      io.to(privateRoomChannel(roomCode)).emit('hint-vote-update', {
        votes: room.hintState.votes.size,
        total: getPrivateRealPlayerCount(room),
      });
    }
  }

  return {
    privateRooms,
    socketPrivateRoom,
    normalizeRoomCode,
    privateRoomChannel,
    createPrivateRoom,
    buildPrivateRoomSnapshot,
    getPrivateRoomElapsedSeconds,
    startPrivateRoomTimer,
    stopPrivateRoomTimer,
    getPrivateRealPlayerCount,
    areAllPrivatePlayersPaused,
    processPrivateRoomCellUpdate,
    getPrivateAiBotList,
    addPrivateAiBot,
    removePrivateAiBot,
    removeAllPrivateAiBots,
    pauseAllPrivateAiBots,
    resumeAllPrivateAiBots,
    startPrivateAiSolving,
    leaveCurrentPrivateRoom,
  };
}

module.exports = { createPrivateRoomService };
