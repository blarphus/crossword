const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const cron = require('node-cron');
const db = require('./db');
const { scrapeDate } = require('./scrape');

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
        const correct = getCorrectAnswer(pData, r, c);
        return userGrid[key] === correct;
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
const COLOR_POOL = ['#4CAF50','#2196F3','#FF9800','#E91E63','#9C27B0','#00BCD4','#FF5722','#8BC34A'];

// Fire streak state (ephemeral, in-memory only)
// socketId → { puzzleDate, userName, color, recentWordCompletions: [{timestamp,row,col},...],
//              onFire, fireExpiresAt, fireCells: [{row,col},...], fireTimer }
const fireStreaks = new Map();

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
  // Broadcast to room
  const roomName = `puzzle:${fs.puzzleDate}`;
  io.to(roomName).emit('fire-expired', {
    socketId,
    userName: fs.userName,
    color: fs.color,
    fireCells,
  });
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
  io.to('calendar').emit('room-count', { puzzleDate, count });
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

  const room = puzzleRooms.get(puzzleDate);
  if (room) {
    room.delete(socket.id);
    if (room.size === 0) {
      puzzleRooms.delete(puzzleDate);
      stopTimer(puzzleDate);
    }
    socket.to(`puzzle:${puzzleDate}`).emit('user-left', {
      userId: socket.handshake.query.userId,
      userName: socket.userName || 'Anonymous',
      socketId: socket.id,
    });
    broadcastRoomCount(puzzleDate);
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
      await db.upsertCell(puzzleDate, row, col, letter);
      await db.upsertCellFiller(puzzleDate, row, col, letter ? userName : '');

      // Score points on letter placement (not on delete)
      let pointDelta = 0;
      let wordBonus = 0;
      let fireEvent = null;
      let guessCorrect = null; // null = no guess (delete), true/false = correct/incorrect
      const now = Date.now();

      // Get or create fire streak state
      let fs = fireStreaks.get(socket.id);
      if (!fs) {
        fs = { puzzleDate, userName, color: userColor, recentWordCompletions: [], onFire: false, fireExpiresAt: 0, fireCells: [], fireTimer: null };
        fireStreaks.set(socket.id, fs);
      }

      if (letter) {
        const pData = await getPuzzleData(puzzleDate);
        const correctAnswer = getCorrectAnswer(pData, row, col);
        if (correctAnswer) {
          const isCorrect = (letter === correctAnswer);
          guessCorrect = isCorrect;
          const wasOnFire = fs.onFire;

          if (isCorrect && fs.onFire) {
            // Correct + on fire: double points (extension happens on word completion only)
            pointDelta = 2;
          } else if (isCorrect && !fs.onFire) {
            pointDelta = 1;
          } else if (!isCorrect && fs.onFire) {
            // Incorrect + on fire: break fire
            if (fs.fireTimer) clearTimeout(fs.fireTimer);
            fireEvent = { type: 'broken', userName, color: userColor, fireCells: fs.fireCells.slice() };
            fs.onFire = false;
            fs.fireExpiresAt = 0;
            fs.fireCells = [];
            fs.fireTimer = null;
            fs.recentWordCompletions = [];
            pointDelta = -1;
          } else {
            // Incorrect + not on fire: reset word completion streak
            fs.recentWordCompletions = [];
            pointDelta = -1;
          }

          await db.addPoints(puzzleDate, userName, pointDelta);
          await db.addGuess(puzzleDate, userName, isCorrect);

          // Check word completions for bonus — all fire logic is gated on wordBonus > 0
          if (isCorrect) {
            const { completed, completedWordCells } = await checkWordCompletions(puzzleDate, row, col, pData);
            if (completed >= 2) wordBonus = 15;
            else if (completed === 1) wordBonus = 5;
            // Double word bonus only if was already on fire (not if fire just started this turn)
            if (wordBonus && wasOnFire) wordBonus *= 2;

            if (wordBonus) {
              await db.addPoints(puzzleDate, userName, wordBonus);

              if (fs.onFire && wasOnFire) {
                // Extend fire on word completion while on fire
                fs.fireExpiresAt += 10000;
                const seen = new Set(fs.fireCells.map(c => `${c.row},${c.col}`));
                for (const c of completedWordCells) {
                  const k = `${c.row},${c.col}`;
                  if (!seen.has(k)) { seen.add(k); fs.fireCells.push(c); }
                }
                if (fs.fireTimer) clearTimeout(fs.fireTimer);
                const remainingMs = fs.fireExpiresAt - now;
                fs.fireTimer = setTimeout(() => expireFire(socket.id), remainingMs);
                fireEvent = { type: 'extended', userName, color: userColor, fireCells: fs.fireCells.slice(), remainingMs };
              } else if (!fs.onFire) {
                // Track word completions toward fire trigger
                fs.recentWordCompletions.push({ timestamp: now, count: completed, wordCells: completedWordCells });
                fs.recentWordCompletions = fs.recentWordCompletions.filter(e => now - e.timestamp < 30000);
                const totalCompletions = fs.recentWordCompletions.reduce((sum, e) => sum + e.count, 0);
                if (totalCompletions >= 3) {
                  const seen = new Set();
                  const allFireCells = [];
                  for (const entry of fs.recentWordCompletions) {
                    for (const c of entry.wordCells) {
                      const k = `${c.row},${c.col}`;
                      if (!seen.has(k)) { seen.add(k); allFireCells.push(c); }
                    }
                  }
                  fs.onFire = true;
                  fs.fireExpiresAt = now + 30000;
                  fs.fireCells = allFireCells;
                  fs.fireTimer = setTimeout(() => expireFire(socket.id), 30000);
                  fireEvent = { type: 'started', userName, color: userColor, fireCells: fs.fireCells.slice(), remainingMs: 30000 };
                  fs.recentWordCompletions = [];
                }
              }
            }
          }
        }
      }

      socket.to(`puzzle:${puzzleDate}`).emit('cell-updated', { row, col, letter, userId, userName, color: userColor, pointDelta, wordBonus, fireEvent, guessCorrect });

      // Send fire update back to originating socket
      if (fireEvent) {
        socket.emit('fire-update', fireEvent);
      }

      debounceProgressBroadcast(puzzleDate);
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

  socket.on('clear-puzzle', async ({ puzzleDate }) => {
    try {
      await db.clearState(puzzleDate);
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

async function checkAndScrapeToday() {
  const today = todayET();
  const exists = await db.hasPuzzle(today);
  if (!exists) {
    console.log(`[startup] Today's puzzle (${today}) not found, attempting scrape...`);
    try {
      await scrapeDate(today);
    } catch (err) {
      console.error(`[startup] Failed to scrape today's puzzle:`, err.message);
    }
  } else {
    console.log(`[startup] Today's puzzle (${today}) already in DB`);
  }
}

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await db.initDb();
    await seedPuzzlesFromBundle();
    await checkAndScrapeToday();

    // Daily scrape at 5:00 AM ET
    cron.schedule('0 5 * * *', async () => {
      const today = todayET();
      console.log(`[cron] Running daily scrape for ${today}`);
      try {
        await scrapeDate(today);
      } catch (err) {
        console.error(`[cron] Failed to scrape:`, err.message);
      }
    });

    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to initialize:', err);
    process.exit(1);
  }
})();
