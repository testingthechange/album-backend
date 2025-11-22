console.log('server.js is running...');

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.use(cors());
app.use(express.json());

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/projects/:projectId/meta', async (req, res) => {
  res.json({ ok: true, message: 'Meta save stub' });
});

app.get('/api/projects/:projectId/meta', async (req, res) => {
  res.json({ ok: true, meta: null, message: 'Meta load stub' });
});

app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
});
