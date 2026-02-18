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
      list.push({ socketId: sid, name: p.name, color: p.color, score: p.score, isHost: sid === room.hostSocket });
    }
    return list;
  }

  function broadcastState(room) {
    const state = {
      roomId: room.roomId,
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

  function allCluesUsed(room) {
    const roundData = getRoundData(room);
    if (!roundData) return true;
    return roundData.clues.every(c => room.usedClues.has(clueKey(c.cat, c.row)));
  }

  function clearTimers(room) {
    if (room.timers.buzzer) { clearTimeout(room.timers.buzzer); room.timers.buzzer = null; }
    if (room.timers.answer) { clearTimeout(room.timers.answer); room.timers.answer = null; }
    if (room.timers.reading) { clearTimeout(room.timers.reading); room.timers.reading = null; }
    if (room.timers.result) { clearTimeout(room.timers.result); room.timers.result = null; }
    if (room.timers.finalAnswer) { clearTimeout(room.timers.finalAnswer); room.timers.finalAnswer = null; }
  }

  function transitionToClueSelection(room) {
    clearTimers(room);
    room.currentClue = null;
    room.answeringPlayer = null;
    room.buzzerQueue = [];
    room.buzzedPlayers = new Set();
    room.dailyDoubleWager = null;

    if (allCluesUsed(room)) {
      if (room.currentRound === 'jeopardy') {
        room.currentRound = 'doubleJeopardy';
        room.usedClues = new Set();
        room.phase = 'selectingClue';
        nsp.to(room.roomId).emit('round-change', { round: 'doubleJeopardy' });
        broadcastState(room);
      } else {
        // Double Jeopardy done → Final Jeopardy
        startFinalJeopardy(room);
      }
      return;
    }

    room.phase = 'selectingClue';
    broadcastState(room);
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

    // After 5s showing category, move to wager phase
    room.timers.reading = setTimeout(() => {
      room.phase = 'finalWager';
      nsp.to(room.roomId).emit('phase-change', { phase: 'finalWager' });
      broadcastState(room);
    }, 5000);
  }

  function endGame(room) {
    clearTimers(room);
    room.phase = 'gameOver';
    const standings = playerList(room).sort((a, b) => b.score - a.score);
    nsp.to(room.roomId).emit('game-over', { standings });
    broadcastState(room);

    // Clean up room after 5 minutes
    setTimeout(() => { rooms.delete(room.roomId); }, 5 * 60 * 1000);
  }

  // ─── Socket event handlers ─────────────────────────────────────

  nsp.on('connection', (socket) => {
    socket.on('create-room', async (data, cb) => {
      const { playerName, deviceId } = data || {};
      const name = (playerName || 'Player 1').trim().substring(0, 20);

      // Get a random game
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
      if (room.players.size >= 8) {
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

      room.phase = 'selectingClue';
      room.controllingPlayer = room.hostSocket;
      nsp.to(room.roomId).emit('phase-change', { phase: 'selectingClue' });
      broadcastState(room);
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
      nsp.to(room.roomId).emit('clue-selected', {
        cat, row, value: clue.value, clue: clue.clue, dailyDouble: false,
      });
      broadcastState(room);

      // After 3s reading delay, open buzzer
      room.timers.reading = setTimeout(() => {
        room.phase = 'buzzerOpen';
        room.buzzedPlayers = new Set();
        nsp.to(room.roomId).emit('phase-change', { phase: 'buzzerOpen' });
        broadcastState(room);

        // 5s buzzer window
        room.timers.buzzer = setTimeout(() => {
          // Nobody buzzed — reveal answer and return to selection
          nsp.to(room.roomId).emit('buzzer-expired', {
            correctAnswer: room.currentClue.answer,
          });
          room.timers.result = setTimeout(() => transitionToClueSelection(room), 3000);
        }, 5000);
      }, 3000);
    });

    socket.on('buzz-in', () => {
      const room = getRoom(socket.jeopardyRoom);
      if (!room || room.phase !== 'buzzerOpen') return;
      if (room.buzzedPlayers.has(socket.id)) return;

      room.buzzedPlayers.add(socket.id);
      clearTimeout(room.timers.buzzer);
      room.timers.buzzer = null;

      room.answeringPlayer = socket.id;
      room.phase = 'playerAnswering';

      const player = room.players.get(socket.id);
      nsp.to(room.roomId).emit('buzzer-result', {
        playerId: socket.id,
        playerName: player?.name,
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

      // 10s to answer
      room.timers.answer = setTimeout(() => {
        handleDailyDoubleAnswer(room, socket.id, '', false);
      }, 10000);
    });

    function handleAnswerResult(room, socketId, playerAnswer, correct) {
      const player = room.players.get(socketId);
      if (!player) return;

      const value = room.currentClue.value;
      const scoreChange = correct ? value : -value;
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
      });
      nsp.to(room.roomId).emit('scores-update', playerList(room));

      if (correct) {
        room.controllingPlayer = socketId;
        room.timers.result = setTimeout(() => transitionToClueSelection(room), 2500);
      } else {
        // Reopen buzzer for remaining players (who haven't buzzed)
        const remainingPlayers = [...room.players.keys()].filter(sid => !room.buzzedPlayers.has(sid));
        if (remainingPlayers.length > 0) {
          room.timers.result = setTimeout(() => {
            room.answeringPlayer = null;
            room.phase = 'buzzerOpen';
            nsp.to(room.roomId).emit('phase-change', { phase: 'buzzerOpen' });
            broadcastState(room);

            room.timers.buzzer = setTimeout(() => {
              nsp.to(room.roomId).emit('buzzer-expired', {
                correctAnswer: room.currentClue.answer,
              });
              room.timers.result = setTimeout(() => transitionToClueSelection(room), 3000);
            }, 5000);
          }, 1500);
        } else {
          // Everyone has buzzed — reveal and move on
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
      });
      nsp.to(room.roomId).emit('scores-update', playerList(room));

      // Controlling player stays the same for DD
      room.timers.result = setTimeout(() => transitionToClueSelection(room), 2500);
    }

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

      // Check if all wagers are in
      if (room.finalJeopardy.wagers.size >= room.players.size) {
        room.phase = 'finalClue';
        nsp.to(room.roomId).emit('final-clue', {
          category: room.gameData.fj.category,
          clue: room.gameData.fj.clue,
        });
        broadcastState(room);

        // 30s to answer
        room.timers.finalAnswer = setTimeout(() => {
          finalizeFinalJeopardy(room);
        }, 30000);
      }
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

      if (room.finalJeopardy.answers.size >= room.players.size) {
        clearTimeout(room.timers.finalAnswer);
        room.timers.finalAnswer = null;
        finalizeFinalJeopardy(room);
      }
    });

    function finalizeFinalJeopardy(room) {
      clearTimers(room);
      room.phase = 'finalResults';

      const reveals = [];
      // Reveal in order of score (lowest first for drama)
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

      // Reveal one by one with delays
      let delay = 0;
      for (let i = 0; i < reveals.length; i++) {
        delay += 3000;
        setTimeout(() => {
          nsp.to(room.roomId).emit('final-jeopardy-reveal', reveals[i]);
        }, delay);
      }

      // After all reveals, end game
      setTimeout(() => {
        endGame(room);
      }, delay + 3000);
    }

    // ─── Disconnect ──────────────────────────────────────────────

    socket.on('disconnect', () => {
      const roomId = socket.jeopardyRoom;
      if (!roomId) return;
      const room = getRoom(roomId);
      if (!room) return;

      room.players.delete(socket.id);
      nsp.to(roomId).emit('player-left', { socketId: socket.id });

      if (room.players.size === 0) {
        clearTimers(room);
        rooms.delete(room.roomId);
        return;
      }

      // If host left, reassign
      if (socket.id === room.hostSocket) {
        room.hostSocket = room.players.keys().next().value;
      }

      // If controlling player left, reassign
      if (socket.id === room.controllingPlayer) {
        room.controllingPlayer = room.hostSocket;
      }

      // If answering player left during their turn, handle gracefully
      if (socket.id === room.answeringPlayer) {
        if (room.phase === 'playerAnswering') {
          clearTimeout(room.timers.answer);
          handleAnswerResult(room, socket.id, '', false);
        } else if (room.phase === 'dailyDoubleAnswer') {
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

    // Choose a specific game (from lobby)
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
  });
};
