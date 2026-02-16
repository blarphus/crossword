const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PUZZLES_DIR = path.join(__dirname, 'puzzles');

// GET /api/puzzles — puzzle index for dropdown
app.get('/api/puzzles', (req, res) => {
  const files = fs.readdirSync(PUZZLES_DIR).filter(f => f.endsWith('.json')).sort().reverse();
  const index = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(PUZZLES_DIR, f), 'utf8'));
    return {
      date: data.date,
      title: data.title,
      author: data.author,
      editor: data.editor,
      dimensions: data.dimensions,
    };
  });
  res.json(index);
});

// GET /api/puzzles/:date — full puzzle data
app.get('/api/puzzles/:date', (req, res) => {
  const file = path.join(PUZZLES_DIR, `${req.params.date}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Puzzle not found' });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  res.json(data);
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

// PUT /api/state/:date — update single cell
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

// DELETE /api/state/:date — clear entire puzzle state
app.delete('/api/state/:date', async (req, res) => {
  try {
    await db.clearState(req.params.date);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/state error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

const PORT = process.env.PORT || 3000;

db.initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
