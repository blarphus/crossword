const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const cron = require('node-cron');
const db = require('./db');
const { scrapeDate } = require('./scrape');
const initJeopardy = require('./server-jeopardy');

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── IP helpers ─────────────────────────────────────────────────
function getIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}
function getSocketIp(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || socket.handshake.address || 'unknown';
}

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── REST endpoints ──────────────────────────────────────────────

// GET /api/puzzles — puzzle index
app.get('/api/puzzles', async (req, res) => {
  try {
    const rows = await db.getAllPuzzleMeta();
    const index = rows.map(r => ({
      date: r.date,
      title: r.title,
      author: r.author,
      editor: r.editor,
      dimensions: r.dimensions,
    }));
    res.json(index);
  } catch (err) {
    console.error('GET /api/puzzles error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/puzzles/:date — full puzzle data
app.get('/api/puzzles/:date', async (req, res) => {
  try {
    const data = await db.getPuzzle(req.params.date);
    if (!data) return res.status(404).json({ error: 'Puzzle not found' });
    res.json(data);
  } catch (err) {
    console.error('GET /api/puzzles/:date error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/calendar/:yearMonth — calendar thumbnail data
app.get('/api/calendar/:yearMonth', async (req, res) => {
  const ym = req.params.yearMonth;
  if (!/^\d{4}-\d{2}$/.test(ym)) {
    return res.status(400).json({ error: 'Invalid format, use YYYY-MM' });
  }
  try {
    const data = await db.getCalendarData(ym);
    res.json(data);
  } catch (err) {
    console.error('GET /api/calendar error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/me — look up current user by device ID
app.get('/api/me', async (req, res) => {
  try {
    const deviceId = req.headers['x-device-id'];
    const user = await db.getUser(deviceId);
    if (user) {
      res.json({ name: user.name, color: user.color });
    } else {
      res.json({ name: null });
    }
  } catch (err) {
    console.error('GET /api/me error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/me — register or update user name/color
app.post('/api/me', async (req, res) => {
  try {
    const ip = getIp(req);
    const deviceId = req.headers['x-device-id'];
    const { name, color: requestedColor } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const trimmedName = name.trim().substring(0, 20);
    // Use requested color if valid, otherwise assign one
    let color;
    if (requestedColor && COLOR_POOL.includes(requestedColor)) {
      color = requestedColor;
    } else {
      const count = await db.getUserCount();
      color = COLOR_POOL[count % COLOR_POOL.length];
    }
    await db.createUser(ip, trimmedName, color, deviceId);
    res.json({ name: trimmedName, color });
  } catch (err) {
    console.error('POST /api/me error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/state/:date — shared collaborative grid state
app.get('/api/state/:date', async (req, res) => {
  try {
    const state = await db.getState(req.params.date);
    if (!state) {
      return res.json({ userGrid: {}, cellFillers: {}, points: {}, userColors: {} });
    }
    // Look up colors for all filler names
    const fillers = state.cell_fillers || {};
    const uniqueNames = [...new Set(Object.values(fillers).filter(Boolean))];
    const userColors = await db.getUserColors(uniqueNames);
    res.json({
      userGrid: state.user_grid,
      cellFillers: fillers,
      points: state.points || {},
      guesses: state.guesses || {},
      userColors,
      updatedAt: state.updated_at,
    });
  } catch (err) {
    console.error('GET /api/state error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/state/:date — update single cell (fallback)
app.put('/api/state/:date', async (req, res) => {
  const { row, col, letter } = req.body;
  if (row == null || col == null || letter == null) {
    return res.status(400).json({ error: 'Missing row, col, or letter' });
  }
  try {
    await db.upsertCell(req.params.date, row, col, letter);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/state error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/state/:date — clear entire puzzle state (fallback)
app.delete('/api/state/:date', async (req, res) => {
  try {
    await db.clearState(req.params.date);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/state error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/scrape/:date — manually trigger scrape for a date
app.post('/api/scrape/:date', async (req, res) => {
  const dateStr = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return res.status(400).json({ error: 'Invalid date format, use YYYY-MM-DD' });
  }
  try {
    await scrapeDate(dateStr);
    res.json({ ok: true, date: dateStr });
  } catch (err) {
    console.error(`POST /api/scrape error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Jeopardy REST endpoints ─────────────────────────────────
app.get('/api/jeopardy/random', async (req, res) => {
  try {
    const row = await db.getRandomJeopardyGame();
    if (!row) return res.status(404).json({ error: 'No games available' });
    res.json({ gameId: row.game_id });
  } catch (err) {
    console.error('GET /api/jeopardy/random error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/jeopardy/seasons', async (req, res) => {
  try {
    const seasons = await db.getJeopardySeasons();
    res.json(seasons);
  } catch (err) {
    console.error('GET /api/jeopardy/seasons error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/jeopardy/seasons/:season', async (req, res) => {
  try {
    const games = await db.getJeopardyGamesBySeason(parseInt(req.params.season, 10));
    res.json(games);
  } catch (err) {
    console.error('GET /api/jeopardy/seasons/:season error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/jeopardy/games/:gameId', async (req, res) => {
  try {
    const data = await db.getJeopardyGame(req.params.gameId);
    if (!data) return res.status(404).json({ error: 'Game not found' });
    res.json(data);
  } catch (err) {
    console.error('GET /api/jeopardy/games/:gameId error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// SPA catch-all: serve index.html for non-API routes (e.g. /2025-02-15)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
  if (req.path.startsWith('/jeopardy')) {
    return res.sendFile(path.join(__dirname, 'public', 'jeopardy.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── In-memory user presence ─────────────────────────────────────

const puzzleDataCache = new Map(); // puzzleDate → { grid, rebus, clues, dimensions }

async function getPuzzleData(puzzleDate) {
  if (puzzleDataCache.has(puzzleDate)) return puzzleDataCache.get(puzzleDate);
  const data = await db.getPuzzle(puzzleDate);
  if (!data) return null;
  const cached = { grid: data.grid, rebus: data.rebus || {}, clues: data.clues, dimensions: data.dimensions };
  puzzleDataCache.set(puzzleDate, cached);
  return cached;
}

function getCorrectAnswer(puzzleData, row, col) {
  if (!puzzleData) return null;
  const key = `${row},${col}`;
  if (puzzleData.rebus[key]) return puzzleData.rebus[key];
  if (puzzleData.grid[row] && puzzleData.grid[row][col] !== '.') return puzzleData.grid[row][col];
  return null;
}

// Check if cell value matches the correct answer (rebus requires full answer)
function isCellCorrectServer(pData, row, col, val) {
  if (!val) return false;
  const correct = getCorrectAnswer(pData, row, col);
  return val === correct;
}

function getServerWordCells(pData, clue, dir) {
  const cells = [];
  let r = clue.row, c = clue.col;
  const maxR = pData.dimensions.rows, maxC = pData.dimensions.cols;
  while (r < maxR && c < maxC && pData.grid[r][c] !== '.') {
    cells.push([r, c]);
    if (dir === 'across') c++; else r++;
  }
  return cells;
}

async function checkWordCompletions(puzzleDate, row, col, pData) {
  const state = await db.getState(puzzleDate);
  const userGrid = state?.user_grid || {};
  let completed = 0;
  const completedWordCells = []; // {row, col} for all cells in completed words

  for (const dir of ['across', 'down']) {
    for (const clue of pData.clues[dir]) {
      const cells = getServerWordCells(pData, clue, dir);
      if (!cells.some(([r, c]) => r === row && c === col)) continue;
      const allCorrect = cells.every(([r, c]) => {
        const key = `${r},${c}`;
        return isCellCorrectServer(pData, r, c, userGrid[key]);
      });
      if (allCorrect) {
        completed++;
        for (const [r, c] of cells) completedWordCells.push({ row: r, col: c });
      }
    }
  }
  return { completed, completedWordCells };
}

const puzzleRooms = new Map(); // puzzleDate → Map<socketId, {userId, userName, color, row, col, direction}>
const socketPuzzle = new Map(); // socketId → puzzleDate (which puzzle they're in)
const COLOR_POOL = ['#4CAF50','#222222','#FF9800','#E91E63','#9C27B0','#FF00FF'];

// Fire streak state (ephemeral, in-memory only)
// socketId → { puzzleDate, userName, color, recentWordCompletions: [{timestamp,row,col},...],
//              onFire, fireExpiresAt, fireCells: [{row,col},...], fireTimer }
const fireStreaks = new Map();

// ─── AI Bot state ─────────────────────────────────────────────
const aiBots = new Map();   // puzzleDate → Map<botId, botState>
let aiBotCounter = 0;

// Target solve times in seconds: [dayOfWeek][difficultyIndex]
const AI_TARGET_TIMES = [
  [2940, 2390, 1835, 1560, 1195], // Sun
  [630,  510,  395,  335,  255],   // Mon
  [770,  625,  480,  410,  310],   // Tue
  [1320, 1075, 825,  700,  535],   // Wed
  [1680, 1365, 1050, 890,  680],   // Thu
  [2000, 1625, 1250, 1065, 810],   // Fri
  [2400, 1950, 1500, 1275, 975],   // Sat
];

// Multiplier ranges per difficulty
const AI_MULTIPLIER_RANGES = [
  [0.85, 1.25], // Easy
  [0.90, 1.18], // Standard-
  [0.92, 1.15], // Standard
  [0.94, 1.12], // Standard+
  [0.96, 1.08], // Expert
];

const AI_NAMES = ['Cleo', 'Atlas', 'Mira', 'Rex', 'Nova', 'Sage', 'Orion', 'Luna'];
const AI_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#F0E68C', '#87CEEB'];
const AI_DIFFICULTY_LABELS = ['Easy', 'Standard-', 'Standard', 'Standard+', 'Expert'];

function expireFire(socketId) {
  const fs = fireStreaks.get(socketId);
  if (!fs || !fs.onFire) return;
  if (fs.fireTimer) clearTimeout(fs.fireTimer);
  const fireCells = fs.fireCells.slice();
  fs.onFire = false;
  fs.fireExpiresAt = 0;
  fs.fireCells = [];
  fs.fireTimer = null;
  fs.recentWordCompletions = [];
  fs.fireMultiplier = 1.5;
  fs.fireWordsCompleted = 0;
  // Broadcast to room
  const roomName = `puzzle:${fs.puzzleDate}`;
  io.to(roomName).emit('fire-expired', {
    socketId,
    userName: fs.userName,
    color: fs.color,
    fireCells,
  });
}

// Hint system state (ephemeral, in-memory)
// puzzleDate → { votes: Set<socketId>, hintCells: Set<"r,c">, available: bool }
const hintState = new Map();

function getHintState(puzzleDate) {
  if (!hintState.has(puzzleDate)) {
    hintState.set(puzzleDate, { votes: new Set(), hintCells: new Set(), available: false, loaded: false });
  }
  return hintState.get(puzzleDate);
}

// Load hint cells from DB (cell_fillers with value '(hint)')
async function loadHintCellsFromDb(puzzleDate) {
  const hs = getHintState(puzzleDate);
  if (hs.loaded) return hs;
  hs.loaded = true;
  try {
    const fillers = await db.getCellFillers(puzzleDate);
    for (const [key, name] of Object.entries(fillers)) {
      if (name === '(hint)') hs.hintCells.add(key);
    }
  } catch (e) { /* ignore */ }
  return hs;
}

function getNextColor(room) {
  const usedColors = new Set();
  for (const user of room.values()) {
    usedColors.add(user.color);
  }
  for (const color of COLOR_POOL) {
    if (!usedColors.has(color)) return color;
  }
  return COLOR_POOL[room.size % COLOR_POOL.length];
}

// ─── Pause tracking (per puzzle room) ────────────────────────────
const pausedSockets = new Map(); // puzzleDate → Set<socketId>

function areAllPaused(puzzleDate) {
  const room = puzzleRooms.get(puzzleDate);
  const paused = pausedSockets.get(puzzleDate);
  if (!room || room.size === 0) return false;
  const realCount = getRealPlayerCount(puzzleDate);
  if (realCount === 0) return false;
  return paused && paused.size >= realCount;
}

// ─── Puzzle solve timers (only tick when someone is in the room) ──
const puzzleTimerState = new Map(); // puzzleDate → { accumulated, startedAt }

function getElapsedSeconds(puzzleDate) {
  const state = puzzleTimerState.get(puzzleDate);
  if (!state) return 0;
  const running = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
  return Math.floor(state.accumulated + running);
}

async function startTimer(puzzleDate) {
  if (puzzleTimerState.has(puzzleDate)) return; // already running
  const accumulated = await db.getTimer(puzzleDate);
  puzzleTimerState.set(puzzleDate, { accumulated, startedAt: Date.now() });
}

async function stopTimer(puzzleDate) {
  const state = puzzleTimerState.get(puzzleDate);
  if (!state) return;
  const elapsed = state.accumulated + (state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0);
  puzzleTimerState.delete(puzzleDate);
  try {
    await db.saveTimer(puzzleDate, elapsed);
  } catch (err) {
    console.error('[timer] Failed to save timer:', err);
  }
}

// Debounce timers for progress broadcasts
const progressTimers = new Map();

function debounceProgressBroadcast(puzzleDate) {
  if (progressTimers.has(puzzleDate)) {
    clearTimeout(progressTimers.get(puzzleDate));
  }
  progressTimers.set(puzzleDate, setTimeout(async () => {
    progressTimers.delete(puzzleDate);
    try {
      const summary = await db.getProgressSummary(puzzleDate);
      if (summary) {
        io.to('calendar').emit('puzzle-progress', summary);
      }
    } catch (err) {
      console.error('[ws] progress broadcast error:', err);
    }
  }, 200));
}

function broadcastRoomCount(puzzleDate) {
  const room = puzzleRooms.get(puzzleDate);
  const count = room ? room.size : 0;
  const botCount = (aiBots.get(puzzleDate) || new Map()).size;
  io.to('calendar').emit('room-count', { puzzleDate, count, botCount });
}

function leaveCurrentPuzzle(socket) {
  const puzzleDate = socketPuzzle.get(socket.id);
  if (!puzzleDate) return;

  // Clean up fire state
  const fs = fireStreaks.get(socket.id);
  if (fs && fs.onFire) {
    if (fs.fireTimer) clearTimeout(fs.fireTimer);
    io.to(`puzzle:${puzzleDate}`).emit('fire-expired', {
      socketId: socket.id,
      userName: fs.userName,
      color: fs.color,
      fireCells: fs.fireCells,
    });
  }
  fireStreaks.delete(socket.id);

  socket.leave(`puzzle:${puzzleDate}`);
  socketPuzzle.delete(socket.id);

  // Clean up hint votes and pause state
  const hs = hintState.get(puzzleDate);
  if (hs) {
    hs.votes.delete(socket.id);
  }
  const paused = pausedSockets.get(puzzleDate);
  if (paused) paused.delete(socket.id);

  const room = puzzleRooms.get(puzzleDate);
  if (room) {
    room.delete(socket.id);
    // Check if only bots remain
    if (getRealPlayerCount(puzzleDate) === 0) {
      removeAllAiBots(puzzleDate);
      // Re-check room after bot cleanup
      if (room.size === 0) {
        puzzleRooms.delete(puzzleDate);
        hintState.delete(puzzleDate);
        pausedSockets.delete(puzzleDate);
        stopTimer(puzzleDate);
      }
    } else if (room.size === 0) {
      puzzleRooms.delete(puzzleDate);
      hintState.delete(puzzleDate);
      pausedSockets.delete(puzzleDate);
      stopTimer(puzzleDate);
    } else {
      // If remaining real players are all paused, stop timer
      if (areAllPaused(puzzleDate)) stopTimer(puzzleDate);
      if (hs && hs.available && hs.votes.size > 0) {
        const realCount = getRealPlayerCount(puzzleDate);
        io.to(`puzzle:${puzzleDate}`).emit('hint-vote-update', { votes: hs.votes.size, total: realCount });
      }
    }
    socket.to(`puzzle:${puzzleDate}`).emit('user-left', {
      userId: socket.handshake.query.userId,
      userName: socket.userName || 'Anonymous',
      socketId: socket.id,
    });
    broadcastRoomCount(puzzleDate);
  }
}

// ─── Extracted cell-update logic (shared by real players and AI bots) ────
async function processCellUpdate({ puzzleDate, row, col, letter, socketId, userName, userColor, isBot }) {
  const room = `puzzle:${puzzleDate}`;
  let pointDelta = 0;
  let wordBonus = 0;
  let fireEvent = null;
  let guessCorrect = null;
  const now = Date.now();

  await db.upsertCell(puzzleDate, row, col, letter);
  await db.upsertCellFiller(puzzleDate, row, col, letter ? userName : '');

  // Get or create fire streak state
  let fs = fireStreaks.get(socketId);
  if (!fs) {
    fs = { puzzleDate, userName, color: userColor, recentWordCompletions: [], onFire: false, fireExpiresAt: 0, fireCells: [], fireTimer: null, fireMultiplier: 1.5, fireWordsCompleted: 0 };
    fireStreaks.set(socketId, fs);
  }

  // Check if this cell is a hint cell (no scoring for hints)
  const hs = await loadHintCellsFromDb(puzzleDate);
  const isHintCell = hs.hintCells.has(`${row},${col}`);

  if (letter && !isHintCell) {
    const pData = await getPuzzleData(puzzleDate);
    const correctAnswer = getCorrectAnswer(pData, row, col);
    if (correctAnswer) {
      const isCorrect = isCellCorrectServer(pData, row, col, letter);
      const isRebus = !!pData.rebus[`${row},${col}`] && letter.length > 1;
      const basePts = isRebus ? 50 : 10;
      guessCorrect = isCorrect;
      const wasOnFire = fs.onFire;

      if (isCorrect && fs.onFire) {
        pointDelta = Math.round(basePts * fs.fireMultiplier);
      } else if (isCorrect && !fs.onFire) {
        pointDelta = basePts;
      } else if (!isCorrect && fs.onFire) {
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

      await db.addPoints(puzzleDate, userName, pointDelta);
      await db.addGuess(puzzleDate, userName, isCorrect);

      if (isCorrect) {
        const { completed, completedWordCells } = await checkWordCompletions(puzzleDate, row, col, pData);
        if (completed >= 2) wordBonus = 250;
        else if (completed === 1) wordBonus = 50;
        if (wordBonus && wasOnFire) wordBonus = Math.round(wordBonus * fs.fireMultiplier);

        if (wordBonus) {
          await db.addPoints(puzzleDate, userName, wordBonus);
          const hintSt = getHintState(puzzleDate);
          hintSt.available = false;
          hintSt.votes.clear();

          const fillers = await db.getCellFillers(puzzleDate);
          const userFireCells = [];
          for (const [key, filler] of Object.entries(fillers)) {
            const fillerName = typeof filler === 'object' ? filler.userName : filler;
            if (fillerName === userName) {
              const [r, c] = key.split(',').map(Number);
              userFireCells.push({ row: r, col: c });
            }
          }

          if (fs.onFire && wasOnFire) {
            fs.fireWordsCompleted += completed;
            fs.fireMultiplier = 1.5 + Math.floor(fs.fireWordsCompleted / 3) * 0.5;
            fs.fireExpiresAt += 5000;
            fs.fireCells = userFireCells;
            if (fs.fireTimer) clearTimeout(fs.fireTimer);
            const remainingMs = fs.fireExpiresAt - now;
            fs.fireTimer = setTimeout(() => expireFire(socketId), remainingMs);
            fireEvent = { type: 'extended', userName, color: userColor, fireCells: userFireCells, remainingMs, fireMultiplier: fs.fireMultiplier };
          } else if (!fs.onFire) {
            fs.recentWordCompletions.push({ timestamp: now, count: completed, wordCells: completedWordCells });
            fs.recentWordCompletions = fs.recentWordCompletions.filter(e => now - e.timestamp < 30000);
            const totalCompletions = fs.recentWordCompletions.reduce((sum, e) => sum + e.count, 0);
            if (totalCompletions >= 3) {
              fs.onFire = true;
              fs.fireExpiresAt = now + 30000;
              fs.fireCells = userFireCells;
              fs.fireMultiplier = 1.5;
              fs.fireWordsCompleted = 0;
              fs.fireTimer = setTimeout(() => expireFire(socketId), 30000);
              fireEvent = { type: 'started', userName, color: userColor, fireCells: userFireCells, remainingMs: 30000, fireMultiplier: 1.5 };
              fs.recentWordCompletions = [];
            }
          }
        }
      }
    }
  }

  // Check if puzzle is now fully solved
  let lastSquareBonus = 0;
  if (letter && guessCorrect) {
    const pData = await getPuzzleData(puzzleDate);
    const state = await db.getState(puzzleDate);
    if (pData && state) {
      const grid = state.user_grid;
      const rows = pData.dimensions.rows;
      const cols = pData.dimensions.cols;
      let complete = true;
      for (let r = 0; r < rows && complete; r++) {
        for (let c = 0; c < cols && complete; c++) {
          if (pData.grid[r][c] === '.') continue;
          if (grid[`${r},${c}`] !== getCorrectAnswer(pData, r, c)) complete = false;
        }
      }
      if (complete) {
        lastSquareBonus = 250;
        await db.addPoints(puzzleDate, userName, lastSquareBonus);
        // Clean up all AI bots on puzzle completion
        removeAllAiBots(puzzleDate);
      }
    }
  }

  // Broadcast to room
  const payload = { row, col, letter, userId: socketId, userName, color: userColor, pointDelta, wordBonus, fireEvent, guessCorrect, lastSquareBonus };
  if (isBot) {
    // Bots have no real socket — broadcast to entire room
    io.to(room).emit('cell-updated', payload);
  }
  // For real players, the caller handles emit

  debounceProgressBroadcast(puzzleDate);

  return { pointDelta, wordBonus, fireEvent, guessCorrect, lastSquareBonus, payload };
}

// ─── AI Bot lifecycle and solving ─────────────────────────────────

function getRealPlayerCount(puzzleDate) {
  const room = puzzleRooms.get(puzzleDate);
  if (!room) return 0;
  let count = 0;
  for (const [, info] of room) {
    if (!info.isBot) count++;
  }
  return count;
}

function addAiBot(puzzleDate, difficultyIndex) {
  const botId = `ai-bot-${++aiBotCounter}`;
  const roomBots = aiBots.get(puzzleDate) || new Map();

  // Pick available name
  const usedNames = new Set();
  for (const [, b] of roomBots) usedNames.add(b.name);
  const name = AI_NAMES.find(n => !usedNames.has(n)) || `Bot-${aiBotCounter}`;
  const colorIdx = roomBots.size % AI_COLORS.length;
  const color = AI_COLORS[colorIdx];

  // Calculate final solve time
  const dateObj = new Date(puzzleDate + 'T12:00:00');
  const dow = dateObj.getDay();
  const baseTime = AI_TARGET_TIMES[dow][difficultyIndex];
  const [lo, hi] = AI_MULTIPLIER_RANGES[difficultyIndex];
  const mult = lo + Math.random() * (hi - lo);
  const finalSolveTime = baseTime * mult;

  const bot = {
    botId, name, color, difficultyIndex,
    puzzleDate, finalSolveTime,
    timers: [], started: false,
  };

  roomBots.set(botId, bot);
  aiBots.set(puzzleDate, roomBots);

  // Register in puzzleRooms
  if (!puzzleRooms.has(puzzleDate)) puzzleRooms.set(puzzleDate, new Map());
  puzzleRooms.get(puzzleDate).set(botId, {
    userId: botId, userName: name, color, row: 0, col: 0, direction: 'across', isBot: true,
  });

  // Initialize fire streak entry
  fireStreaks.set(botId, {
    puzzleDate, userName: name, color,
    recentWordCompletions: [],
    onFire: false, fireExpiresAt: 0, fireCells: [], fireTimer: null,
    fireMultiplier: 1.5, fireWordsCompleted: 0,
  });

  // Broadcast join
  io.to(`puzzle:${puzzleDate}`).emit('user-joined', {
    socketId: botId, userId: botId, userName: name, color,
    row: 0, col: 0, direction: 'across', isBot: true,
  });

  broadcastRoomCount(puzzleDate);
  return bot;
}

function removeAiBot(puzzleDate, botId) {
  const roomBots = aiBots.get(puzzleDate);
  if (!roomBots) return;
  const bot = roomBots.get(botId);
  if (!bot) return;

  // Cancel all pending timers
  for (const t of bot.timers) clearTimeout(t);
  bot.timers = [];

  // Clean up fire state
  const fs = fireStreaks.get(botId);
  if (fs && fs.onFire) {
    if (fs.fireTimer) clearTimeout(fs.fireTimer);
    io.to(`puzzle:${puzzleDate}`).emit('fire-expired', {
      socketId: botId, userName: bot.name, color: bot.color, fireCells: fs.fireCells,
    });
  }
  fireStreaks.delete(botId);

  // Remove from puzzleRooms
  const room = puzzleRooms.get(puzzleDate);
  if (room) room.delete(botId);

  // Remove from bot map
  roomBots.delete(botId);
  if (roomBots.size === 0) aiBots.delete(puzzleDate);

  // Broadcast leave
  io.to(`puzzle:${puzzleDate}`).emit('user-left', {
    userId: botId, userName: bot.name, socketId: botId,
  });

  broadcastRoomCount(puzzleDate);
}

function removeAllAiBots(puzzleDate) {
  const roomBots = aiBots.get(puzzleDate);
  if (!roomBots) return;
  const botIds = [...roomBots.keys()];
  for (const botId of botIds) removeAiBot(puzzleDate, botId);
}

function getAiBotList(puzzleDate) {
  const roomBots = aiBots.get(puzzleDate);
  if (!roomBots) return [];
  return [...roomBots.values()].map(b => ({
    botId: b.botId, name: b.name, color: b.color,
    difficultyIndex: b.difficultyIndex,
    difficultyLabel: AI_DIFFICULTY_LABELS[b.difficultyIndex],
    started: b.started,
  }));
}

function buildAiWordQueue(pData) {
  const words = [];
  for (const dir of ['across', 'down']) {
    for (const clue of pData.clues[dir]) {
      const cells = getServerWordCells(pData, clue, dir);
      words.push({ dir, clue, cells });
    }
  }
  // Fisher-Yates shuffle — fully random order
  for (let i = words.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [words[i], words[j]] = [words[j], words[i]];
  }
  return words;
}

function distributeAiTiming(cellCount, finalSolveTime, wordCount) {
  if (cellCount === 0) return { thinkTimes: [], cellTimes: [] };
  const totalMs = finalSolveTime * 1000;

  // Split into bursts: some words solved quickly in succession (hot streak),
  // others with long pauses (thinking / reading clues / scanning grid).
  // ~25% of time is think pauses, ~75% is typing, but with high variance.

  const rawThink = [];
  for (let i = 0; i < wordCount; i++) {
    // Mix of short pauses (quick succession) and long pauses (stuck/scanning)
    const r = Math.random();
    if (r < 0.25) {
      // Long pause: reading a clue, scanning grid (3-10x base)
      rawThink.push(3 + Math.random() * 7);
    } else if (r < 0.55) {
      // Medium pause: moving to next word (0.8-3x base)
      rawThink.push(0.8 + Math.random() * 2.2);
    } else {
      // Quick succession: barely any pause (0.1-0.8x base)
      rawThink.push(0.1 + Math.random() * 0.7);
    }
  }
  const thinkSum = rawThink.reduce((s, v) => s + v, 0);
  const thinkTimes = rawThink.map(v => Math.max(40, (v / thinkSum) * totalMs * 0.25));

  // Cell times: burst typing with variable speed
  // Group cells into "streaks" — fast bursts followed by hesitations
  const rawCell = [];
  let streakLen = 0;
  let streakSpeed = 1;
  for (let i = 0; i < cellCount; i++) {
    if (streakLen <= 0) {
      // Start a new streak: 2-8 cells at a particular speed
      streakLen = 2 + Math.floor(Math.random() * 7);
      // Speed varies widely: 0.3 (fast) to 4.0 (slow/hesitant)
      const r = Math.random();
      if (r < 0.3) streakSpeed = 0.2 + Math.random() * 0.4;    // fast burst
      else if (r < 0.7) streakSpeed = 0.5 + Math.random() * 1;  // normal
      else streakSpeed = 1.5 + Math.random() * 2.5;              // slow/careful
    }
    // Add per-cell jitter within the streak
    rawCell.push(streakSpeed * (0.6 + Math.random() * 0.8));
    streakLen--;
  }
  const cellSum = rawCell.reduce((s, v) => s + v, 0);
  const cellTimes = rawCell.map(v => Math.max(40, (v / cellSum) * totalMs * 0.75));

  return { thinkTimes, cellTimes };
}

// Chance of doing another random cursor hop before settling on the next word.
// Higher = more wandering. Easy bots look around a lot, expert bots beeline.
const AI_WANDER_CHANCE = [0.75, 0.65, 0.55, 0.40, 0.25];

// Generate a single random cursor hop (2-5 squares in a random direction)
function randomHop(pData, fromR, fromC) {
  const maxR = pData.dimensions.rows;
  const maxC = pData.dimensions.cols;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const dist = 2 + Math.floor(Math.random() * 4);
  const angle = Math.random() * Math.PI * 2;
  return [
    clamp(Math.round(fromR + Math.sin(angle) * dist), 0, maxR - 1),
    clamp(Math.round(fromC + Math.cos(angle) * dist), 0, maxC - 1),
  ];
}

async function startAiSolving(puzzleDate) {
  const roomBots = aiBots.get(puzzleDate);
  if (!roomBots) return;

  const pData = await getPuzzleData(puzzleDate);
  if (!pData) return;

  // Track starting words so every bot begins at a different one
  const usedStartWords = new Set();

  for (const [, bot] of roomBots) {
    if (bot.started) continue;
    bot.started = true;

    const wordQueue = buildAiWordQueue(pData);

    // Rotate queue so this bot starts on a word no other bot is starting on
    if (usedStartWords.size > 0 && wordQueue.length > 1) {
      let rotateBy = 0;
      for (let i = 0; i < wordQueue.length; i++) {
        const key = `${wordQueue[i].cells[0][0]},${wordQueue[i].cells[0][1]}`;
        if (!usedStartWords.has(key)) { rotateBy = i; break; }
      }
      if (rotateBy > 0) {
        const head = wordQueue.splice(0, rotateBy);
        wordQueue.push(...head);
      }
    }
    if (wordQueue.length > 0) {
      usedStartWords.add(`${wordQueue[0].cells[0][0]},${wordQueue[0].cells[0][1]}`);
    }

    // Pre-build all word cells with correct answers
    const allWords = wordQueue.map(word => ({
      cells: word.cells.map(([r, c]) => ({ row: r, col: c, letter: getCorrectAnswer(pData, r, c) })),
      dir: word.dir,
    }));

    // Estimate total cells for timing (used for initial timing budget)
    let estCells = 0;
    for (const w of allWords) estCells += w.cells.length;
    const timing = distributeAiTiming(estCells, bot.finalSolveTime, allWords.length);

    // Cursor emit helper
    const emitCursor = (r, c, dir) => {
      const room = puzzleRooms.get(puzzleDate);
      if (!room || !room.has(bot.botId)) return;
      const info = room.get(bot.botId);
      info.row = r; info.col = c; info.direction = dir;
      io.to(`puzzle:${puzzleDate}`).emit('cursor-moved', {
        socketId: bot.botId, userId: bot.botId, userName: bot.name,
        row: r, col: c, direction: dir,
      });
    };

    // Alive check
    const isAlive = () => {
      const currentBots = aiBots.get(puzzleDate);
      return currentBots && currentBots.has(bot.botId);
    };

    let cursorR = allWords[0].cells[0].row;
    let cursorC = allWords[0].cells[0].col;
    let cellIdx = 0; // index into timing.cellTimes

    // Recursive chain: process one word at a time
    const processWord = (wi) => {
      if (!isAlive() || wi >= allWords.length) return;

      const word = allWords[wi];
      const thinkTime = timing.thinkTimes[wi] || 200;

      // Wander cursor with recursive coin-flip, then fill
      const wanderChance = AI_WANDER_CHANCE[bot.difficultyIndex] || 0.55;
      // Budget a base step time from the think time (at least 1 hop + landing)
      const baseStepTime = thinkTime / 3;
      let wanderR = cursorR, wanderC = cursorC;

      const doWander = () => {
        if (!isAlive()) return;
        if (Math.random() < wanderChance) {
          // Do a random hop, then flip again
          const [hr, hc] = randomHop(pData, wanderR, wanderC);
          wanderR = hr; wanderC = hc;
          emitCursor(hr, hc, Math.random() < 0.5 ? 'across' : 'down');
          const hopDelay = baseStepTime * (0.4 + Math.random() * 1.2);
          const t = setTimeout(doWander, hopDelay);
          bot.timers.push(t);
        } else {
          // Done wandering — land on target and start filling
          emitCursor(word.cells[0].row, word.cells[0].col, word.dir);
          const landDelay = baseStepTime * (0.3 + Math.random() * 0.7);
          const t = setTimeout(() => startFillingWord(wi, 0), landDelay);
          bot.timers.push(t);
        }
      };

      const t = setTimeout(doWander, stepTime);
      bot.timers.push(t);

      const startFillingWord = async (wi, ci) => {
        if (!isAlive()) return;

        // Get live grid state to check which cells still need filling
        let currentGrid = {};
        try {
          const currentState = await db.getState(puzzleDate);
          currentGrid = currentState?.user_grid || {};
        } catch (e) { /* continue with empty grid */ }

        // Find next unfilled cell in this word starting from ci
        let nextCi = ci;
        while (nextCi < word.cells.length) {
          const cell = word.cells[nextCi];
          if (currentGrid[`${cell.row},${cell.col}`] !== cell.letter) break;
          nextCi++;
          cellIdx++; // consume the timing slot
        }

        if (nextCi >= word.cells.length) {
          // Word is fully filled — skip to next word immediately
          cursorR = word.cells[word.cells.length - 1].row;
          cursorC = word.cells[word.cells.length - 1].col;
          processWord(wi + 1);
          return;
        }

        // Fill this cell
        const cell = word.cells[nextCi];
        const fillTime = timing.cellTimes[cellIdx] || 100;
        cellIdx++;

        const t = setTimeout(async () => {
          if (!isAlive()) return;
          try {
            emitCursor(cell.row, cell.col, word.dir);
            await processCellUpdate({
              puzzleDate, row: cell.row, col: cell.col, letter: cell.letter,
              socketId: bot.botId, userName: bot.name, userColor: bot.color, isBot: true,
            });
          } catch (err) {
            console.error('[ai] fill error:', err);
          }
          // Continue to next cell in this word
          startFillingWord(wi, nextCi + 1);
        }, fillTime);
        bot.timers.push(t);
      };
    };

    // Kick off the chain
    processWord(0);
  }
}

// ─── Socket.IO event handlers ────────────────────────────────────

io.on('connection', async (socket) => {
  const userId = socket.handshake.query.userId || 'anon';
  const deviceId = socket.handshake.query.deviceId;

  // Look up user by device ID
  const dbUser = await db.getUser(deviceId);
  const userName = dbUser?.name || 'Anonymous';
  const userColor = dbUser?.color || null;
  socket.userName = userName;
  socket.userColor = userColor;

  socket.join('calendar');

  socket.on('join-puzzle', async (puzzleDate) => {
    // Leave previous puzzle room if any
    leaveCurrentPuzzle(socket);

    // Join new puzzle room
    socket.join(`puzzle:${puzzleDate}`);
    socketPuzzle.set(socket.id, puzzleDate);

    if (!puzzleRooms.has(puzzleDate)) {
      puzzleRooms.set(puzzleDate, new Map());
    }
    const room = puzzleRooms.get(puzzleDate);
    const color = userColor || getNextColor(room);
    room.set(socket.id, { userId, userName, color, row: 0, col: 0, direction: 'across' });

    // Initialize fire streak tracking
    fireStreaks.set(socket.id, {
      puzzleDate, userName, color,
      recentWordCompletions: [],
      onFire: false, fireExpiresAt: 0, fireCells: [], fireTimer: null,
      fireMultiplier: 1.5, fireWordsCompleted: 0,
    });

    // Start timer when first user joins
    await startTimer(puzzleDate);

    // Send room state to joiner (all other users)
    const others = [];
    for (const [sid, info] of room) {
      if (sid !== socket.id) {
        others.push({ socketId: sid, ...info });
      }
    }
    socket.emit('room-state', { users: others, yourColor: color, yourName: userName });

    // Send current timer value
    socket.emit('timer-sync', { seconds: getElapsedSeconds(puzzleDate) });

    // Broadcast to others
    socket.to(`puzzle:${puzzleDate}`).emit('user-joined', {
      socketId: socket.id,
      userId,
      userName,
      color,
      row: 0,
      col: 0,
      direction: 'across',
    });

    broadcastRoomCount(puzzleDate);
  });

  socket.on('cell-update', async ({ puzzleDate, row, col, letter }) => {
    try {
      const result = await processCellUpdate({
        puzzleDate, row, col, letter,
        socketId: socket.id, userName, userColor, isBot: false,
      });
      // For real players: broadcast to others (not self) and send fire update to self
      socket.to(`puzzle:${puzzleDate}`).emit('cell-updated', result.payload);
      if (result.fireEvent) {
        socket.emit('fire-update', result.fireEvent);
      }
    } catch (err) {
      console.error('[ws] cell-update error:', err);
    }
  });

  socket.on('cursor-move', ({ puzzleDate, row, col, direction }) => {
    const room = puzzleRooms.get(puzzleDate);
    if (room && room.has(socket.id)) {
      const info = room.get(socket.id);
      info.row = row;
      info.col = col;
      info.direction = direction;
    }
    socket.to(`puzzle:${puzzleDate}`).emit('cursor-moved', {
      socketId: socket.id,
      userId,
      userName,
      row,
      col,
      direction,
    });
  });

  // ─── Pause / Resume ──────────────────────────────────────────────
  socket.on('pause-puzzle', async ({ puzzleDate }) => {
    if (!pausedSockets.has(puzzleDate)) pausedSockets.set(puzzleDate, new Set());
    pausedSockets.get(puzzleDate).add(socket.id);
    // If all players are now paused, stop the timer
    if (areAllPaused(puzzleDate)) {
      await stopTimer(puzzleDate);
    }
  });

  socket.on('resume-puzzle', async ({ puzzleDate }) => {
    const paused = pausedSockets.get(puzzleDate);
    if (paused) paused.delete(socket.id);
    // If timer was stopped (all were paused), restart it
    if (!puzzleTimerState.has(puzzleDate)) {
      await startTimer(puzzleDate);
      io.to(`puzzle:${puzzleDate}`).emit('timer-sync', { seconds: getElapsedSeconds(puzzleDate) });
    }
  });

  // ─── Hint voting ───────────────────────────────────────────────
  socket.on('hint-vote', async ({ puzzleDate }) => {
    try {
      const room = puzzleRooms.get(puzzleDate);
      if (!room) return;
      const hs = getHintState(puzzleDate);
      hs.votes.add(socket.id);
      const totalPlayers = getRealPlayerCount(puzzleDate);
      const voteCount = hs.votes.size;

      // Broadcast vote update to all players in room
      io.to(`puzzle:${puzzleDate}`).emit('hint-vote-update', { votes: voteCount, total: totalPlayers });

      // If all real players voted, reveal hints
      if (voteCount >= totalPlayers) {
        const pData = await getPuzzleData(puzzleDate);
        const state = await db.getState(puzzleDate);
        if (!pData || !state) return;
        const grid = state.user_grid || {};

        // Find unfilled/incorrect cells that aren't already hints
        const candidates = [];
        for (let r = 0; r < pData.dimensions.rows; r++) {
          for (let c = 0; c < pData.dimensions.cols; c++) {
            if (pData.grid[r][c] === '.') continue;
            const key = `${r},${c}`;
            if (hs.hintCells.has(key)) continue;
            const correct = getCorrectAnswer(pData, r, c);
            if (grid[key] !== correct) {
              candidates.push({ row: r, col: c, letter: correct });
            }
          }
        }

        // Shuffle and pick up to 5
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        const chosen = candidates.slice(0, 5);

        // Apply hint cells to DB and track them
        for (const { row: r, col: c, letter } of chosen) {
          const key = `${r},${c}`;
          hs.hintCells.add(key);
          await db.upsertCell(puzzleDate, r, c, letter);
          await db.upsertCellFiller(puzzleDate, r, c, '(hint)');
        }

        // Broadcast reveal to all players
        io.to(`puzzle:${puzzleDate}`).emit('hint-reveal', { cells: chosen });

        // Reset votes for next hint
        hs.votes.clear();
        hs.available = false;
        debounceProgressBroadcast(puzzleDate);
      }
    } catch (err) {
      console.error('[ws] hint-vote error:', err);
    }
  });

  socket.on('hint-available', ({ puzzleDate }) => {
    // Server acknowledges hint availability — broadcast to room
    const hs = getHintState(puzzleDate);
    if (!hs.available) {
      hs.available = true;
      hs.votes.clear();
      io.to(`puzzle:${puzzleDate}`).emit('hint-available');
    }
  });

  socket.on('clear-puzzle', async ({ puzzleDate }) => {
    try {
      removeAllAiBots(puzzleDate);
      await db.clearState(puzzleDate);
      // Reset hint state
      hintState.delete(puzzleDate);
      // Reset timer
      puzzleTimerState.delete(puzzleDate);
      await startTimer(puzzleDate); // restart from 0 (clearState deleted the row)
      io.to(`puzzle:${puzzleDate}`).emit('timer-sync', { seconds: 0 });
      socket.to(`puzzle:${puzzleDate}`).emit('puzzle-cleared', { userId });
      debounceProgressBroadcast(puzzleDate);
    } catch (err) {
      console.error('[ws] clear-puzzle error:', err);
    }
  });

  // ─── AI bot handlers ──────────────────────────────────────────
  socket.on('add-ai', ({ puzzleDate, difficultyIndex }) => {
    const roomBots = aiBots.get(puzzleDate);
    if (roomBots && roomBots.size >= 5) return; // max 5 bots
    const di = Math.max(0, Math.min(4, difficultyIndex || 2));
    addAiBot(puzzleDate, di);
    io.to(`puzzle:${puzzleDate}`).emit('ai-bot-list', getAiBotList(puzzleDate));
  });

  socket.on('remove-ai', ({ puzzleDate, botId }) => {
    removeAiBot(puzzleDate, botId);
    io.to(`puzzle:${puzzleDate}`).emit('ai-bot-list', getAiBotList(puzzleDate));
  });

  socket.on('start-ai', ({ puzzleDate }) => {
    startAiSolving(puzzleDate);
  });

  socket.on('get-ai-bots', ({ puzzleDate }) => {
    socket.emit('ai-bot-list', getAiBotList(puzzleDate));
  });

  socket.on('leave-puzzle', () => {
    leaveCurrentPuzzle(socket);
  });

  socket.on('disconnect', () => {
    leaveCurrentPuzzle(socket);
  });
});

// ─── Startup ─────────────────────────────────────────────────────

async function seedPuzzlesFromBundle() {
  const bundlePath = path.join(__dirname, 'puzzles-bundle.json.gz');
  if (!fs.existsSync(bundlePath)) {
    console.log('[seed] No puzzles-bundle.json.gz found, skipping');
    return;
  }

  // Check if we've already seeded this bundle
  const BUNDLE_VERSION = '3';  // bump to re-seed (v3: rebus support)
  const seeded = await db.getMetadata('bundle_seeded_v');
  if (seeded === BUNDLE_VERSION) {
    console.log('[seed] Bundle already seeded (v' + BUNDLE_VERSION + '), skipping');
    return;
  }

  console.log('[seed] Loading puzzles from bundle...');
  const compressed = fs.readFileSync(bundlePath);
  const json = zlib.gunzipSync(compressed).toString('utf8');
  const bundle = JSON.parse(json);
  const dates = Object.keys(bundle);
  let count = 0;

  for (const dateStr of dates) {
    await db.savePuzzle(dateStr, bundle[dateStr]);
    count++;
    if (count % 200 === 0) console.log(`[seed] ${count}/${dates.length} puzzles seeded...`);
  }

  await db.setMetadata('bundle_seeded_v', BUNDLE_VERSION);
  console.log(`[seed] Seeded ${count} puzzles from bundle`);
}

async function seedJeopardyFromBundle() {
  const bundlePath = path.join(__dirname, 'jeopardy-bundle.json.gz');
  if (!fs.existsSync(bundlePath)) {
    console.log('[seed] No jeopardy-bundle.json.gz found, skipping');
    return;
  }

  const BUNDLE_VERSION = '3';  // v3: season data derived from air date
  const seeded = await db.getMetadata('jeopardy_bundle_seeded_v');
  if (seeded === BUNDLE_VERSION) {
    console.log('[seed] Jeopardy bundle already seeded (v' + BUNDLE_VERSION + '), skipping');
    return;
  }

  console.log('[seed] Loading Jeopardy games from bundle...');
  const compressed = fs.readFileSync(bundlePath);
  const json = zlib.gunzipSync(compressed).toString('utf8');
  const bundle = JSON.parse(json);
  const gameIds = Object.keys(bundle);
  let count = 0;

  for (const gameId of gameIds) {
    await db.saveJeopardyGame(gameId, bundle[gameId]);
    count++;
    if (count % 500 === 0) console.log(`[seed] ${count}/${gameIds.length} Jeopardy games seeded...`);
  }

  await db.setMetadata('jeopardy_bundle_seeded_v', BUNDLE_VERSION);
  console.log(`[seed] Seeded ${count} Jeopardy games from bundle`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeRecentMissing() {
  // Scrape any missing puzzles from the last 7 days
  const today = new Date();
  const missing = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const exists = await db.hasPuzzle(dateStr);
    if (!exists) missing.push(dateStr);
  }
  if (missing.length === 0) {
    console.log(`[startup] All recent puzzles present`);
    return;
  }
  console.log(`[startup] Missing ${missing.length} recent puzzles: ${missing.join(', ')}`);
  for (const dateStr of missing) {
    try {
      await scrapeDate(dateStr);
    } catch (err) {
      console.error(`[startup] Failed to scrape ${dateStr}:`, err.message);
    }
    // Delay between requests to avoid rate limiting
    if (missing.indexOf(dateStr) < missing.length - 1) {
      await sleep(2000);
    }
  }
}

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await db.initDb();
    await seedPuzzlesFromBundle();
    await seedJeopardyFromBundle();
    initJeopardy(io, db);
    await scrapeRecentMissing();

    // Scrape every hour to catch new puzzles and recover from failures
    cron.schedule('0 * * * *', async () => {
      const today = todayET();
      const exists = await db.hasPuzzle(today);
      if (!exists) {
        console.log(`[cron] Today's puzzle (${today}) not found, scraping...`);
        try {
          await scrapeDate(today);
        } catch (err) {
          console.error(`[cron] Failed to scrape ${today}:`, err.message);
        }
      }
    });

    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to initialize:', err);
    process.exit(1);
  }
})();
