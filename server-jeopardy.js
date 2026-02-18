/**
 * Jeopardy game server module.
 * Manages game rooms, state machine, buzzer logic, scoring, and Final Jeopardy.
 */
const { checkAnswer } = require('./answer-checker');

// Generate 4-char room codes
function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

const COLORS = ['#4CAF50','#2196F3','#FF9800','#E91E63','#9C27B0','#00BCD4','#FF5722','#8BC34A'];

module.exports = function initJeopardy(io, db) {
  const nsp = io.of('/jeopardy');
  const rooms = new Map(); // roomId → room state

  function getRoom(roomId) { return rooms.get(roomId?.toUpperCase()); }

  function playerList(room) {
    const list = [];
    for (const [sid, p] of room.players) {
      list.push({
        socketId: sid, name: p.name, color: p.color, score: p.score,
        isHost: sid === room.hostSocket, isAI: !!p.isAI,
        difficulty: p.difficultyLabel || null,
      });
    }
    return list;
  }

  function broadcastState(room) {
    const state = {
      roomId: room.roomId,
      gameId: room.gameId,
      phase: room.phase,
      currentRound: room.currentRound,
      players: playerList(room),
      controllingPlayer: room.controllingPlayer,
      controllingPlayerName: room.players.get(room.controllingPlayer)?.name || null,
      usedClues: Array.from(room.usedClues),
      currentClue: room.phase === 'readingClue' || room.phase === 'buzzerOpen' ||
                   room.phase === 'playerAnswering' || room.phase === 'showingResult' ||
                   room.phase === 'dailyDoubleWager' || room.phase === 'dailyDoubleAnswer'
        ? { cat: room.currentClue.cat, row: room.currentClue.row, value: room.currentClue.value,
            clue: room.currentClue.clue, dailyDouble: room.currentClue.dailyDouble || false }
        : null,
      gameData: {
        jRound: { categories: room.gameData.jRound?.categories || [] },
        djRound: { categories: room.gameData.djRound?.categories || [] },
        fj: room.gameData.fj ? { category: room.gameData.fj.category } : null,
      },
      answeringPlayer: room.answeringPlayer,
      answeringPlayerName: room.players.get(room.answeringPlayer)?.name || null,
      dailyDoubleWager: room.dailyDoubleWager,
      showNumber: room.gameData.showNumber,
      airDate: room.gameData.airDate,
    };
    nsp.to(room.roomId).emit('room-state', state);
  }

  function getRoundData(room) {
    return room.currentRound === 'jeopardy' ? room.gameData.jRound : room.gameData.djRound;
  }

  function clueKey(cat, row) { return `${cat},${row}`; }

  // Compute missing clue slots for a round (slots that have no clue data)
  function getMissingSlots(roundData) {
    const missing = new Set();
    if (!roundData || !roundData.clues) return missing;
    const present = new Set(roundData.clues.map(c => clueKey(c.cat, c.row)));
    for (let cat = 0; cat < 6; cat++) {
      for (let row = 1; row <= 5; row++) {
        if (!present.has(clueKey(cat, row))) missing.add(clueKey(cat, row));
      }
    }
    return missing;
  }

  function allCluesUsed(room) {
    const roundData = getRoundData(room);
    if (!roundData) return true;
    return roundData.clues.every(c => room.usedClues.has(clueKey(c.cat, c.row)));
  }

  // ─── CPU AI helpers ──────────────────────────────────────────
  const AI_NAMES = ['Watson', 'DeepBlue', 'HAL'];
  const AI_COLORS = ['#9C27B0', '#00BCD4', '#FF5722'];

  const AI_DIFF_MAP = {
    easy:   { buzzSpeed: 0.3, accuracy: 0.5, skipChance: 0.35 },
    medium: { buzzSpeed: 0.5, accuracy: 0.7, skipChance: 0.15 },
    hard:   { buzzSpeed: 0.8, accuracy: 0.9, skipChance: 0.05 },
  };

  function scheduleAIBuzz(room) {
    if (room.phase !== 'buzzerOpen') return;
    for (const [sid, p] of room.players) {
      if (!p.isAI) continue;
      if (room.buzzedPlayers.has(sid)) continue;
      const diff = p.aiDifficulty || AI_DIFF_MAP.medium;

      // Chance to not buzz at all
      if (Math.random() < (diff.skipChance || 0)) continue;

      // Variable delay: 1s minimum, up to ~4.5s for easy
      const baseDelay = Math.max(1.0, 2.0 - diff.buzzSpeed * 1.5);
      const delay = baseDelay + Math.random() * 2.0;

      const timerId = setTimeout(() => {
        if (room.phase !== 'buzzerOpen' || room.buzzedPlayers.has(sid)) return;
        room.buzzedPlayers.add(sid);
        if (room.timers.buzzer) { clearTimeout(room.timers.buzzer); room.timers.buzzer = null; }
        cancelAIBuzzTimers(room);
        room.answeringPlayer = sid;
        room.phase = 'playerAnswering';
        nsp.to(room.roomId).emit('buzzer-result', {
          playerId: sid, playerName: p.name, isAI: true,
        });
        broadcastState(room);
        // AI answers after 1.5s
        room.timers.answer = setTimeout(() => processAIAnswer(room, sid), 1500);
      }, delay * 1000);
      if (!room.timers.aiBuzz) room.timers.aiBuzz = [];
      room.timers.aiBuzz.push(timerId);
    }
  }

  function cancelAIBuzzTimers(room) {
    if (room.timers.aiBuzz) {
      for (const t of room.timers.aiBuzz) clearTimeout(t);
      room.timers.aiBuzz = [];
    }
  }

  function processAIAnswer(room, sid) {
    const p = room.players.get(sid);
    if (!p || !p.isAI) return;
    const diff = p.aiDifficulty || AI_DIFF_MAP.medium;
    const correct = Math.random() < diff.accuracy;
    const answer = correct ? room.currentClue.answer : '';
    handleAnswerResult(room, sid, answer, correct);
  }

  function scheduleAIDailyDouble(room, sid) {
    const p = room.players.get(sid);
    if (!p || !p.isAI) return;
    const diff = p.aiDifficulty || AI_DIFF_MAP.medium;
    const maxForRound = room.currentRound === 'jeopardy' ? 1000 : 2000;
    const maxWager = Math.max(p.score, maxForRound);
    let wager;
    if (p.score <= 0) {
      wager = Math.max(5, maxForRound);
    } else {
      wager = Math.max(5, Math.floor(maxWager * diff.accuracy * (0.7 + Math.random() * 0.3)));
    }
    wager = Math.min(wager, maxWager);

    setTimeout(() => {
      room.dailyDoubleWager = wager;
      room.phase = 'dailyDoubleAnswer';
      nsp.to(room.roomId).emit('clue-selected', {
        cat: room.currentClue.cat, row: room.currentClue.row,
        value: wager, clue: room.currentClue.clue, dailyDouble: true,
      });
      broadcastState(room);
      // AI answers after 1.5s
      room.timers.answer = setTimeout(() => {
        const correct = Math.random() < diff.accuracy;
        handleDailyDoubleAnswer(room, sid, correct ? room.currentClue.answer : '', correct);
      }, 1500);
    }, 1500);
  }

  function scheduleAIFinalWagers(room) {
    for (const [sid, p] of room.players) {
      if (!p.isAI) continue;
      const score = Math.max(0, p.score);
      const wager = score <= 0 ? 0 : Math.floor(score / 4 + Math.random() * (score * 3 / 4));
      room.finalJeopardy.wagers.set(sid, wager);
    }
    checkAllFinalWagers(room);
  }

  function scheduleAIFinalAnswers(room) {
    for (const [sid, p] of room.players) {
      if (!p.isAI) continue;
      const diff = p.aiDifficulty || AI_DIFF_MAP.medium;
      const correct = Math.random() < diff.accuracy;
      room.finalJeopardy.answers.set(sid, correct ? room.gameData.fj.answer : '');
    }
    checkAllFinalAnswers(room);
  }

  function checkAllFinalWagers(room) {
    if (room.finalJeopardy.wagers.size >= room.players.size) {
      room.phase = 'finalClue';
      nsp.to(room.roomId).emit('final-clue', {
        category: room.gameData.fj.category,
        clue: room.gameData.fj.clue,
      });
      broadcastState(room);
      room.timers.finalAnswer = setTimeout(() => finalizeFinalJeopardy(room), 30000);
      setTimeout(() => scheduleAIFinalAnswers(room), 2000);
    }
  }

  function checkAllFinalAnswers(room) {
    if (room.finalJeopardy.answers.size >= room.players.size) {
      clearTimeout(room.timers.finalAnswer);
      room.timers.finalAnswer = null;
      finalizeFinalJeopardy(room);
    }
  }

  // If the controlling player is an AI, have it pick a clue
  function scheduleAIClueSelection(room) {
    const cp = room.players.get(room.controllingPlayer);
    if (!cp || !cp.isAI) return;
    setTimeout(() => {
      if (room.phase !== 'selectingClue') return;
      const roundData = getRoundData(room);
      if (!roundData) return;
      const available = roundData.clues.filter(c => !room.usedClues.has(clueKey(c.cat, c.row)));
      if (available.length === 0) return;
      const pick = available[Math.floor(Math.random() * available.length)];
      room.usedClues.add(clueKey(pick.cat, pick.row));
      room.currentClue = { ...pick };
      if (pick.dailyDouble) {
        room.phase = 'dailyDoubleWager';
        room.answeringPlayer = room.controllingPlayer;
        nsp.to(room.roomId).emit('daily-double', {
          cat: pick.cat, row: pick.row, value: pick.value,
          playerSocketId: room.controllingPlayer,
          playerName: cp.name,
        });
        broadcastState(room);
        scheduleAIDailyDouble(room, room.controllingPlayer);
        return;
      }
      room.phase = 'readingClue';
      nsp.to(room.roomId).emit('clue-selected', {
        cat: pick.cat, row: pick.row, value: pick.value, clue: pick.clue, dailyDouble: false,
      });
      broadcastState(room);
      startBuzzerPhase(room);
    }, 1500);
  }

  // Open buzzer with 5s window — used for initial open and rebuzz
  function startBuzzerPhase(room) {
    room.timers.reading = setTimeout(() => {
      room.phase = 'buzzerOpen';
      nsp.to(room.roomId).emit('phase-change', { phase: 'buzzerOpen' });
      broadcastState(room);
      scheduleAIBuzz(room);
      room.timers.buzzer = setTimeout(() => {
        cancelAIBuzzTimers(room);
        // Check if anyone can still buzz
        const remaining = [...room.players.keys()].filter(sid => !room.buzzedPlayers.has(sid));
        if (remaining.length === 0 || true) {
          // Time's up — reveal answer
          nsp.to(room.roomId).emit('buzzer-expired', { correctAnswer: room.currentClue.answer });
          room.timers.result = setTimeout(() => transitionToClueSelection(room), 3000);
        }
      }, 5000);
    }, room._skipReadingDelay ? 0 : 3000);
    room._skipReadingDelay = false; // reset
  }

  // ─── Answer handling with rebuzz support ───────────────────────

  function handleAnswerResult(room, socketId, playerAnswer, correct) {
    const player = room.players.get(socketId);
    if (!player) return;

    const value = room.currentClue.value;
    const scoreChange = correct ? value : -value;
    player.score += scoreChange;

    const isAI = !!player.isAI;

    nsp.to(room.roomId).emit('answer-result', {
      playerId: socketId,
      playerName: player.name,
      playerAnswer: correct ? playerAnswer : '',
      correctAnswer: correct ? room.currentClue.answer : null,
      correct,
      scoreChange,
      newScore: player.score,
      isAI,
    });
    nsp.to(room.roomId).emit('scores-update', playerList(room));

    if (correct) {
      room.controllingPlayer = socketId;
      room.phase = 'showingResult';
      room.timers.result = setTimeout(() => transitionToClueSelection(room), 2500);
    } else {
      // Check remaining unbuzzed players
      const remaining = [...room.players.keys()].filter(sid => !room.buzzedPlayers.has(sid));
      if (remaining.length > 0) {
        // Reopen buzzer for remaining players after brief delay
        room.phase = 'showingResult';
        room.timers.result = setTimeout(() => {
          room.answeringPlayer = null;
          room._skipReadingDelay = true;
          startBuzzerPhase(room);
        }, 1500);
      } else {
        // No one left — reveal answer and move on
        room.phase = 'showingResult';
        nsp.to(room.roomId).emit('buzzer-expired', {
          correctAnswer: room.currentClue.answer,
        });
        room.timers.result = setTimeout(() => transitionToClueSelection(room), 3000);
      }
    }
  }

  function handleDailyDoubleAnswer(room, socketId, playerAnswer, correct) {
    const player = room.players.get(socketId);
    if (!player) return;

    const wager = room.dailyDoubleWager || 0;
    const scoreChange = correct ? wager : -wager;
    player.score += scoreChange;

    room.phase = 'showingResult';
    nsp.to(room.roomId).emit('answer-result', {
      playerId: socketId,
      playerName: player.name,
      playerAnswer,
      correctAnswer: room.currentClue.answer,
      correct,
      scoreChange,
      newScore: player.score,
      isAI: !!player.isAI,
    });
    nsp.to(room.roomId).emit('scores-update', playerList(room));

    room.timers.result = setTimeout(() => transitionToClueSelection(room), 2500);
  }

  function saveProgress(room, completed = false) {
    const totalClues = (room.gameData.jRound?.clues?.length || 30) +
                       (room.gameData.djRound?.clues?.length || 30);
    db.saveJeopardyProgress(
      room.gameId, room.usedClues.size, totalClues,
      room.currentRound, completed
    ).catch(err => console.error('[jeopardy] Failed to save progress:', err));
  }

  function clearTimers(room) {
    if (room.timers.buzzer) { clearTimeout(room.timers.buzzer); room.timers.buzzer = null; }
    if (room.timers.answer) { clearTimeout(room.timers.answer); room.timers.answer = null; }
    if (room.timers.reading) { clearTimeout(room.timers.reading); room.timers.reading = null; }
    if (room.timers.result) { clearTimeout(room.timers.result); room.timers.result = null; }
    if (room.timers.finalAnswer) { clearTimeout(room.timers.finalAnswer); room.timers.finalAnswer = null; }
    cancelAIBuzzTimers(room);
  }

  function transitionToClueSelection(room) {
    clearTimers(room);
    room.currentClue = null;
    room.answeringPlayer = null;
    room.buzzerQueue = [];
    room.buzzedPlayers = new Set();
    room.dailyDoubleWager = null;
    room._skipReadingDelay = false;
    saveProgress(room);

    if (allCluesUsed(room)) {
      if (room.currentRound === 'jeopardy') {
        room.currentRound = 'doubleJeopardy';
        room.usedClues = new Set();
        for (const key of getMissingSlots(room.gameData.djRound)) room.usedClues.add(key);
        room.phase = 'selectingClue';
        nsp.to(room.roomId).emit('round-change', { round: 'doubleJeopardy' });
        broadcastState(room);
        scheduleAIClueSelection(room);
      } else {
        startFinalJeopardy(room);
      }
      return;
    }

    room.phase = 'selectingClue';
    broadcastState(room);
    scheduleAIClueSelection(room);
  }

  function startFinalJeopardy(room) {
    if (!room.gameData.fj) {
      endGame(room);
      return;
    }
    room.currentRound = 'finalJeopardy';
    room.phase = 'finalCategory';
    room.finalJeopardy = { wagers: new Map(), answers: new Map(), reveals: [] };
    nsp.to(room.roomId).emit('round-change', { round: 'finalJeopardy' });
    nsp.to(room.roomId).emit('final-category', { category: room.gameData.fj.category });
    broadcastState(room);

    room.timers.reading = setTimeout(() => {
      room.phase = 'finalWager';
      nsp.to(room.roomId).emit('phase-change', { phase: 'finalWager' });
      broadcastState(room);
      scheduleAIFinalWagers(room);
    }, 5000);
  }

  function endGame(room) {
    clearTimers(room);
    room.phase = 'gameOver';
    saveProgress(room, true);
    const standings = playerList(room).sort((a, b) => b.score - a.score);
    nsp.to(room.roomId).emit('game-over', { standings });
    broadcastState(room);
    setTimeout(() => { rooms.delete(room.roomId); }, 5 * 60 * 1000);
  }

  function finalizeFinalJeopardy(room) {
    clearTimers(room);
    room.phase = 'finalResults';

    const reveals = [];
    const sorted = [...room.players.entries()]
      .sort((a, b) => a[1].score - b[1].score);

    for (const [sid, player] of sorted) {
      const answer = room.finalJeopardy.answers.get(sid) || '';
      const wager = room.finalJeopardy.wagers.get(sid) || 0;
      const result = checkAnswer(answer, room.gameData.fj.answer);
      const scoreChange = result.correct ? wager : -wager;
      player.score += scoreChange;

      reveals.push({
        playerId: sid,
        playerName: player.name,
        answer,
        wager,
        correct: result.correct,
        scoreChange,
        newScore: player.score,
      });
    }

    room.finalJeopardy.reveals = reveals;

    let delay = 0;
    for (let i = 0; i < reveals.length; i++) {
      delay += 3000;
      setTimeout(() => {
        nsp.to(room.roomId).emit('final-jeopardy-reveal', reveals[i]);
      }, delay);
    }

    setTimeout(() => {
      endGame(room);
    }, delay + 3000);
  }

  // ─── Socket event handlers ─────────────────────────────────────

  nsp.on('connection', (socket) => {
    socket.on('create-room', async (data, cb) => {
      const { playerName, deviceId } = data || {};
      const name = (playerName || 'Player 1').trim().substring(0, 20);

      const row = await db.getRandomJeopardyGame();
      if (!row) {
        if (cb) cb({ error: 'No games available' });
        return;
      }

      let roomId;
      do { roomId = makeRoomId(); } while (rooms.has(roomId));

      const gameData = row.data;
      const room = {
        roomId,
        gameId: row.game_id,
        gameData,
        phase: 'lobby',
        currentRound: 'jeopardy',
        usedClues: new Set(),
        players: new Map(),
        hostSocket: socket.id,
        controllingPlayer: null,
        currentClue: null,
        buzzerQueue: [],
        buzzedPlayers: new Set(),
        answeringPlayer: null,
        dailyDoubleWager: null,
        finalJeopardy: { wagers: new Map(), answers: new Map(), reveals: [] },
        timers: { buzzer: null, answer: null, reading: null, result: null, finalAnswer: null },
        _skipReadingDelay: false,
      };

      const color = COLORS[0];
      room.players.set(socket.id, { name, color, score: 0, deviceId });

      rooms.set(roomId, room);
      socket.join(roomId);
      socket.jeopardyRoom = roomId;

      if (cb) cb({ roomId, gameId: room.gameId });
      broadcastState(room);
    });

    socket.on('join-room', (data, cb) => {
      const { roomId: rawId, playerName, deviceId } = data || {};
      const roomId = rawId?.toUpperCase();
      const room = getRoom(roomId);
      if (!room) {
        if (cb) cb({ error: 'Room not found' });
        return;
      }
      if (room.players.size >= 4) {
        if (cb) cb({ error: 'Room is full' });
        return;
      }

      const name = (playerName || `Player ${room.players.size + 1}`).trim().substring(0, 20);
      const usedColors = new Set([...room.players.values()].map(p => p.color));
      const color = COLORS.find(c => !usedColors.has(c)) || COLORS[room.players.size % COLORS.length];

      room.players.set(socket.id, { name, color, score: 0, deviceId });
      socket.join(roomId);
      socket.jeopardyRoom = roomId;

      if (cb) cb({ roomId, gameId: room.gameId });
      nsp.to(roomId).emit('player-joined', { socketId: socket.id, name, color, score: 0 });
      broadcastState(room);
    });

    socket.on('start-game', () => {
      const room = getRoom(socket.jeopardyRoom);
      if (!room || room.phase !== 'lobby') return;
      if (socket.id !== room.hostSocket) return;

      for (const key of getMissingSlots(room.gameData.jRound)) room.usedClues.add(key);

      room.phase = 'selectingClue';
      room.controllingPlayer = room.hostSocket;
      nsp.to(room.roomId).emit('round-change', { round: 'jeopardy' });
      nsp.to(room.roomId).emit('phase-change', { phase: 'selectingClue' });
      broadcastState(room);
      scheduleAIClueSelection(room);
    });

    socket.on('select-clue', ({ cat, row }) => {
      const room = getRoom(socket.jeopardyRoom);
      if (!room || room.phase !== 'selectingClue') return;
      if (socket.id !== room.controllingPlayer) return;

      const key = clueKey(cat, row);
      if (room.usedClues.has(key)) return;

      const roundData = getRoundData(room);
      const clue = roundData.clues.find(c => c.cat === cat && c.row === row);
      if (!clue) return;

      room.usedClues.add(key);
      room.currentClue = { ...clue };

      if (clue.dailyDouble) {
        room.phase = 'dailyDoubleWager';
        room.answeringPlayer = socket.id;
        nsp.to(room.roomId).emit('daily-double', {
          cat, row, value: clue.value,
          playerSocketId: socket.id,
          playerName: room.players.get(socket.id)?.name,
        });
        broadcastState(room);
        return;
      }

      // Normal clue: show text, then open buzzer
      room.phase = 'readingClue';
      room.buzzedPlayers = new Set();
      nsp.to(room.roomId).emit('clue-selected', {
        cat, row, value: clue.value, clue: clue.clue, dailyDouble: false,
      });
      broadcastState(room);
      startBuzzerPhase(room);
    });

    socket.on('buzz-in', () => {
      const room = getRoom(socket.jeopardyRoom);
      if (!room || room.phase !== 'buzzerOpen') return;
      if (room.buzzedPlayers.has(socket.id)) return;

      room.buzzedPlayers.add(socket.id);
      clearTimeout(room.timers.buzzer);
      room.timers.buzzer = null;
      cancelAIBuzzTimers(room);

      room.answeringPlayer = socket.id;
      room.phase = 'playerAnswering';

      const player = room.players.get(socket.id);
      nsp.to(room.roomId).emit('buzzer-result', {
        playerId: socket.id,
        playerName: player?.name,
        isAI: false,
      });
      broadcastState(room);

      // 10s to answer
      room.timers.answer = setTimeout(() => {
        handleAnswerResult(room, socket.id, '', false);
      }, 10000);
    });

    socket.on('submit-answer', ({ answer }) => {
      const room = getRoom(socket.jeopardyRoom);
      if (!room) return;
      if (socket.id !== room.answeringPlayer) return;

      if (room.phase === 'playerAnswering') {
        clearTimeout(room.timers.answer);
        room.timers.answer = null;

        const result = checkAnswer(answer, room.currentClue.answer);
        handleAnswerResult(room, socket.id, answer, result.correct);
      } else if (room.phase === 'dailyDoubleAnswer') {
        clearTimeout(room.timers.answer);
        room.timers.answer = null;

        const result = checkAnswer(answer, room.currentClue.answer);
        handleDailyDoubleAnswer(room, socket.id, answer, result.correct);
      }
    });

    socket.on('daily-double-wager', ({ amount }) => {
      const room = getRoom(socket.jeopardyRoom);
      if (!room || room.phase !== 'dailyDoubleWager') return;
      if (socket.id !== room.answeringPlayer) return;

      const player = room.players.get(socket.id);
      const maxWager = room.currentRound === 'jeopardy'
        ? Math.max(1000, player.score)
        : Math.max(2000, player.score);
      const wager = Math.max(5, Math.min(Math.floor(amount), maxWager));

      room.dailyDoubleWager = wager;
      room.phase = 'dailyDoubleAnswer';

      nsp.to(room.roomId).emit('clue-selected', {
        cat: room.currentClue.cat,
        row: room.currentClue.row,
        value: wager,
        clue: room.currentClue.clue,
        dailyDouble: true,
      });
      broadcastState(room);

      room.timers.answer = setTimeout(() => {
        handleDailyDoubleAnswer(room, socket.id, '', false);
      }, 10000);
    });

    // ─── Final Jeopardy ─────────────────────────────────────────

    socket.on('final-jeopardy-wager', ({ amount }) => {
      const room = getRoom(socket.jeopardyRoom);
      if (!room || room.phase !== 'finalWager') return;

      const player = room.players.get(socket.id);
      if (!player) return;

      const wager = Math.max(0, Math.min(Math.floor(amount), Math.max(0, player.score)));
      room.finalJeopardy.wagers.set(socket.id, wager);

      nsp.to(room.roomId).emit('final-wager-submitted', {
        playerId: socket.id,
        playerName: player.name,
        total: room.finalJeopardy.wagers.size,
        needed: room.players.size,
      });

      checkAllFinalWagers(room);
    });

    socket.on('final-jeopardy-answer', ({ answer }) => {
      const room = getRoom(socket.jeopardyRoom);
      if (!room || room.phase !== 'finalClue') return;

      room.finalJeopardy.answers.set(socket.id, answer || '');

      nsp.to(room.roomId).emit('final-answer-submitted', {
        playerId: socket.id,
        playerName: room.players.get(socket.id)?.name,
        total: room.finalJeopardy.answers.size,
        needed: room.players.size,
      });

      checkAllFinalAnswers(room);
    });

    // ─── Disconnect ──────────────────────────────────────────────

    socket.on('disconnect', () => {
      const roomId = socket.jeopardyRoom;
      if (!roomId) return;
      const room = getRoom(roomId);
      if (!room) return;

      const wasAnswering = socket.id === room.answeringPlayer;
      const wasPhase = room.phase;

      room.players.delete(socket.id);
      nsp.to(roomId).emit('player-left', { socketId: socket.id });

      if (room.players.size === 0) {
        clearTimers(room);
        rooms.delete(room.roomId);
        return;
      }

      if (socket.id === room.hostSocket) {
        room.hostSocket = room.players.keys().next().value;
      }
      if (socket.id === room.controllingPlayer) {
        room.controllingPlayer = room.hostSocket;
      }

      if (wasAnswering) {
        if (wasPhase === 'playerAnswering') {
          clearTimeout(room.timers.answer);
          // Treat as wrong answer to trigger rebuzz
          room.buzzedPlayers.add(socket.id);
          const remaining = [...room.players.keys()].filter(sid => !room.buzzedPlayers.has(sid));
          if (remaining.length > 0) {
            room.answeringPlayer = null;
            room._skipReadingDelay = true;
            startBuzzerPhase(room);
          } else {
            nsp.to(room.roomId).emit('buzzer-expired', { correctAnswer: room.currentClue?.answer });
            room.timers.result = setTimeout(() => transitionToClueSelection(room), 3000);
          }
        } else if (wasPhase === 'dailyDoubleAnswer') {
          clearTimeout(room.timers.answer);
          transitionToClueSelection(room);
        }
      }

      broadcastState(room);
    });

    socket.on('leave-room', () => {
      const roomId = socket.jeopardyRoom;
      if (!roomId) return;
      socket.leave(roomId);
      socket.jeopardyRoom = null;

      const room = getRoom(roomId);
      if (!room) return;
      room.players.delete(socket.id);
      nsp.to(roomId).emit('player-left', { socketId: socket.id });

      if (room.players.size === 0) {
        clearTimers(room);
        rooms.delete(room.roomId);
      } else {
        if (socket.id === room.hostSocket) {
          room.hostSocket = room.players.keys().next().value;
        }
        if (socket.id === room.controllingPlayer) {
          room.controllingPlayer = room.hostSocket;
        }
        broadcastState(room);
      }
    });

    socket.on('change-game', async ({ gameId }) => {
      const room = getRoom(socket.jeopardyRoom);
      if (!room || room.phase !== 'lobby') return;
      if (socket.id !== room.hostSocket) return;

      const data = await db.getJeopardyGame(gameId);
      if (!data) return;

      room.gameId = gameId;
      room.gameData = data;
      broadcastState(room);
    });

    socket.on('random-game', async () => {
      const room = getRoom(socket.jeopardyRoom);
      if (!room || room.phase !== 'lobby') return;
      if (socket.id !== room.hostSocket) return;

      const row = await db.getRandomJeopardyGame();
      if (!row) return;

      room.gameId = row.game_id;
      room.gameData = row.data;
      broadcastState(room);
    });

    socket.on('add-cpu', ({ difficulty }) => {
      const room = getRoom(socket.jeopardyRoom);
      if (!room || room.phase !== 'lobby') return;
      if (socket.id !== room.hostSocket) return;
      if (room.players.size >= 4) return;

      const aiDiff = AI_DIFF_MAP[difficulty] || AI_DIFF_MAP.medium;
      const label = difficulty || 'medium';

      let aiCount = 0;
      for (const p of room.players.values()) if (p.isAI) aiCount++;
      const aiId = `ai-${Date.now()}-${aiCount}`;
      const name = AI_NAMES[aiCount] || `CPU ${aiCount + 1}`;
      const usedColors = new Set([...room.players.values()].map(p => p.color));
      const color = AI_COLORS[aiCount] || COLORS.find(c => !usedColors.has(c)) || COLORS[0];

      room.players.set(aiId, { name, color, score: 0, isAI: true, aiDifficulty: aiDiff, difficultyLabel: label });
      nsp.to(room.roomId).emit('player-joined', { socketId: aiId, name, color, score: 0, isAI: true, difficulty: label });
      broadcastState(room);
    });

    socket.on('remove-cpu', ({ playerId }) => {
      const room = getRoom(socket.jeopardyRoom);
      if (!room || room.phase !== 'lobby') return;
      if (socket.id !== room.hostSocket) return;
      const p = room.players.get(playerId);
      if (!p || !p.isAI) return;
      room.players.delete(playerId);
      nsp.to(room.roomId).emit('player-left', { socketId: playerId });
      broadcastState(room);
    });
  });
};
