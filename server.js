const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const db = require('./db');
const { scrapeDate } = require('./scrape');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PUZZLES_DIR = path.join(__dirname, 'puzzles');

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

// GET /api/state/:date — shared collaborative grid state
app.get('/api/state/:date', async (req, res) => {
  try {
    const state = await db.getState(req.params.date);
    res.json(state ? { userGrid: state.user_grid, updatedAt: state.updated_at } : { userGrid: {} });
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

const puzzleRooms = new Map(); // puzzleDate → Map<socketId, {userId, color, row, col, direction}>
const socketPuzzle = new Map(); // socketId → puzzleDate (which puzzle they're in)
const COLOR_POOL = ['#90EE90','#FFB6C1','#DDA0DD','#FFA500','#ADD8E6','#98FB98','#F0E68C','#FFD700'];

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

  socket.leave(`puzzle:${puzzleDate}`);
  socketPuzzle.delete(socket.id);

  const room = puzzleRooms.get(puzzleDate);
  if (room) {
    room.delete(socket.id);
    if (room.size === 0) {
      puzzleRooms.delete(puzzleDate);
    }
    socket.to(`puzzle:${puzzleDate}`).emit('user-left', {
      userId: socket.handshake.query.userId,
      socketId: socket.id,
    });
    broadcastRoomCount(puzzleDate);
  }
}

// ─── Socket.IO event handlers ────────────────────────────────────

io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId || 'anon';
  socket.join('calendar');

  socket.on('join-puzzle', (puzzleDate) => {
    // Leave previous puzzle room if any
    leaveCurrentPuzzle(socket);

    // Join new puzzle room
    socket.join(`puzzle:${puzzleDate}`);
    socketPuzzle.set(socket.id, puzzleDate);

    if (!puzzleRooms.has(puzzleDate)) {
      puzzleRooms.set(puzzleDate, new Map());
    }
    const room = puzzleRooms.get(puzzleDate);
    const color = getNextColor(room);
    room.set(socket.id, { userId, color, row: 0, col: 0, direction: 'across' });

    // Send room state to joiner (all other users)
    const others = [];
    for (const [sid, info] of room) {
      if (sid !== socket.id) {
        others.push({ socketId: sid, ...info });
      }
    }
    socket.emit('room-state', { users: others, yourColor: color });

    // Broadcast to others
    socket.to(`puzzle:${puzzleDate}`).emit('user-joined', {
      socketId: socket.id,
      userId,
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
      socket.to(`puzzle:${puzzleDate}`).emit('cell-updated', { row, col, letter, userId });
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
      row,
      col,
      direction,
    });
  });

  socket.on('clear-puzzle', async ({ puzzleDate }) => {
    try {
      await db.clearState(puzzleDate);
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

async function seedPuzzlesFromFilesystem() {
  if (!fs.existsSync(PUZZLES_DIR)) {
    console.log('[seed] No puzzles/ directory found, skipping filesystem seed');
    return;
  }
  const files = fs.readdirSync(PUZZLES_DIR).filter(f => f.endsWith('.json'));
  let count = 0;
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(PUZZLES_DIR, f), 'utf8'));
    const dateStr = f.replace('.json', '');
    await db.savePuzzle(dateStr, data);
    count++;
  }
  console.log(`[seed] Seeded ${count} puzzles from filesystem`);
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

async function backfillPuzzles() {
  const done = await db.getMetadata('backfill_complete');
  if (done) {
    console.log('[backfill] Already completed, skipping');
    return;
  }

  console.log('[backfill] Starting one-time historical puzzle backfill...');

  const current = new Date();
  let consecutiveFails = 0;
  let scraped = 0;
  let skipped = 0;

  while (consecutiveFails < 2) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, '0');
    const d = String(current.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    const exists = await db.hasPuzzle(dateStr);
    if (exists) {
      skipped++;
      consecutiveFails = 0;
      current.setDate(current.getDate() - 1);
      continue;
    }

    try {
      await scrapeDate(dateStr);
      scraped++;
      consecutiveFails = 0;
      console.log(`[backfill] ${dateStr} OK (${scraped} scraped, ${skipped} skipped)`);
    } catch (err) {
      consecutiveFails++;
      console.log(`[backfill] ${dateStr} failed (${consecutiveFails}/2 consecutive)`);
    }

    current.setDate(current.getDate() - 1);
    await new Promise(r => setTimeout(r, 1500));
  }

  await db.setMetadata('backfill_complete', new Date().toISOString());
  console.log(`[backfill] Complete! Scraped ${scraped}, skipped ${skipped}`);
}

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await db.initDb();
    await seedPuzzlesFromFilesystem();
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

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      // Run historical backfill in background (non-blocking)
      backfillPuzzles().catch(err => {
        console.error('[backfill] Error:', err.message);
      });
    });
  } catch (err) {
    console.error('Failed to initialize:', err);
    process.exit(1);
  }
})();
