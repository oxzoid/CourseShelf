const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { exec, spawn } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SQLite setup ──────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'progress.db'));
db.pragma('journal_mode = WAL');   // faster writes, better concurrency
db.pragma('synchronous = NORMAL'); // safe with WAL, much faster than FULL
db.pragma('foreign_keys = ON');
db.exec(`
  -- Parent: one row per unique root folder
  CREATE TABLE IF NOT EXISTS folders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    root       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Child: completion state per file, FK → folders
  CREATE TABLE IF NOT EXISTS progress (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    file_path  TEXT NOT NULL,
    completed  INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(folder_id, file_path)
  );

  -- Child: video resume position per file, FK → folders
  CREATE TABLE IF NOT EXISTS video_positions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    file_path  TEXT NOT NULL,
    position   REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(folder_id, file_path)
  );

  -- Child: last opened file per folder, FK → folders
  CREATE TABLE IF NOT EXISTS last_active (
    folder_id  INTEGER PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
    file_path  TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Indexes for fast lookups by folder_id
  CREATE INDEX IF NOT EXISTS idx_progress_folder       ON progress(folder_id);
  CREATE INDEX IF NOT EXISTS idx_video_positions_folder ON video_positions(folder_id);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ── Helper: get or create folder row, return id ───────────────────────────────
function getFolderId(root) {
  db.prepare(`
    INSERT INTO folders (root) VALUES (?)
    ON CONFLICT(root) DO NOTHING
  `).run(root);
  return db.prepare('SELECT id FROM folders WHERE root = ?').get(root).id;
}

// ── File type helpers ─────────────────────────────────────────────────────────
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.wmv', '.flv']);
const PDF_EXTS   = new Set(['.pdf']);
const TEXT_EXTS  = new Set(['.txt', '.md', '.markdown']);

function fileType(ext) {
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (PDF_EXTS.has(ext))   return 'pdf';
  if (TEXT_EXTS.has(ext))  return 'text';
  return null;
}

// Natural sort: "2. Foo" < "10. Foo"
function naturalSort(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

// ── Recursive directory scanner ───────────────────────────────────────────────
function scanDir(dirPath, prefix) {
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch (_) { return []; }

  const dirs  = entries.filter(e => e.isDirectory()).sort(naturalSort);
  const files = entries.filter(e => e.isFile()).sort(naturalSort);

  const items = [];

  // Folders → numbered sections/subsections
  dirs.forEach((d, i) => {
    const num      = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
    const fullPath = path.join(dirPath, d.name);
    items.push({
      type: 'folder',
      name: d.name,
      path: fullPath,
      number: num,
      children: scanDir(fullPath, num),
    });
  });

  // Files → only supported types
  files.forEach(f => {
    const ext  = path.extname(f.name).toLowerCase();
    const kind = fileType(ext);
    if (!kind) return;
    items.push({
      type:     'file',
      fileType: kind,
      name:     f.name,
      path:     path.join(dirPath, f.name),
      ext,
    });
  });

  return items;
}

// ── API: directory tree ───────────────────────────────────────────────────────
app.get('/api/tree', (req, res) => {
  const root = req.query.root;
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return res.status(400).json({ error: 'Invalid or missing path' });
  }
  res.json({ root, tree: scanDir(root, '') });
});

// ── API: get progress for a root ──────────────────────────────────────────────
app.get('/api/progress', (req, res) => {
  const root = req.query.root;
  if (!root) return res.status(400).json({ error: 'Missing root' });
  const folderId = getFolderId(root);
  const rows = db.prepare('SELECT file_path, completed FROM progress WHERE folder_id = ?').all(folderId);
  const map  = {};
  rows.forEach(r => { map[r.file_path.replace(/\\/g, '/')] = r.completed === 1; });
  res.json(map);
});

// ── API: set progress for one file ────────────────────────────────────────────
app.post('/api/progress', (req, res) => {
  let { root, filePath, completed } = req.body;
  if (!root || !filePath) return res.status(400).json({ error: 'Missing fields' });
  filePath = filePath.replace(/\\/g, '/');
  const folderId = getFolderId(root);
  db.prepare(`
    INSERT INTO progress (folder_id, file_path, completed, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(folder_id, file_path) DO UPDATE
      SET completed = excluded.completed, updated_at = excluded.updated_at
  `).run(folderId, filePath, completed ? 1 : 0);
  res.json({ ok: true });
});

// ── API: get saved video position ────────────────────────────────────────────
app.get('/api/position', (req, res) => {
  let { root, file } = req.query;
  if (!root || !file) return res.status(400).json({ error: 'Missing fields' });
  file = file.replace(/\\/g, '/');
  const folderId = getFolderId(root);
  const row = db.prepare('SELECT position FROM video_positions WHERE folder_id = ? AND file_path = ?').get(folderId, file);
  res.json({ position: row ? row.position : 0 });
});

// ── API: save video position ──────────────────────────────────────────────────
app.post('/api/position', (req, res) => {
  let { root, filePath, position } = req.body;
  if (!root || !filePath || position == null) return res.status(400).json({ error: 'Missing fields' });
  filePath = filePath.replace(/\\/g, '/');
  const folderId = getFolderId(root);
  db.prepare(`
    INSERT INTO video_positions (folder_id, file_path, position, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(folder_id, file_path) DO UPDATE
      SET position = excluded.position, updated_at = excluded.updated_at
  `).run(folderId, filePath, position);
  res.json({ ok: true });
});

// ── API: get all settings ─────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = {};
  rows.forEach(r => { map[r.key] = r.value; });
  res.json(map);
});

// ── API: save a setting ───────────────────────────────────────────────────────
app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  if (!key || value == null) return res.status(400).json({ error: 'Missing fields' });
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
  res.json({ ok: true });
});

// ── API: get last active file for a root ─────────────────────────────────────
app.get('/api/last-active', (req, res) => {
  const root = req.query.root;
  if (!root) return res.status(400).json({ error: 'Missing root' });
  const folderId = getFolderId(root);
  const row = db.prepare('SELECT file_path FROM last_active WHERE folder_id = ?').get(folderId);
  res.json({ filePath: row ? row.file_path : null });
});

// ── API: save last active file for a root ────────────────────────────────────
app.post('/api/last-active', (req, res) => {
  let { root, filePath } = req.body;
  if (!root || !filePath) return res.status(400).json({ error: 'Missing fields' });
  filePath = filePath.replace(/\\/g, '/');
  const folderId = getFolderId(root);
  db.prepare(`
    INSERT INTO last_active (folder_id, file_path, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(folder_id) DO UPDATE
      SET file_path = excluded.file_path, updated_at = excluded.updated_at
  `).run(folderId, filePath);
  res.json({ ok: true });
});

// ── API: open file with system default app ────────────────────────────────────
app.get('/api/open', (req, res) => {
  const file = req.query.file;
  if (!file || !fs.existsSync(file)) return res.status(400).json({ error: 'File not found' });
  const cmd = process.platform === 'darwin' ? `open "${file}"`
            : process.platform === 'win32'  ? `start "" "${file}"`
            : `xdg-open "${file}"`;
  exec(cmd, err => { if (err) console.error('open error:', err); });
  res.json({ ok: true });
});

// ── API: serve file inline (PDF / text) ──────────────────────────────────────
app.get('/api/file', (req, res) => {
  const file = req.query.file;
  if (!file || !fs.existsSync(file)) return res.status(404).send('Not found');
  const ext = path.extname(file).toLowerCase();
  const mimeMap = {
    '.pdf':      'application/pdf',
    '.txt':      'text/plain; charset=utf-8',
    '.md':       'text/plain; charset=utf-8',
    '.markdown': 'text/plain; charset=utf-8',
  };
  const mime = mimeMap[ext];
  if (!mime) return res.status(400).send('Unsupported type');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', 'inline');
  fs.createReadStream(file).pipe(res);
});

// ── API: stream video with range support ──────────────────────────────────────
app.get('/api/video', (req, res) => {
  const file = req.query.file;
  if (!file || !fs.existsSync(file)) return res.status(404).send('Not found');

  const stat     = fs.statSync(file);
  const fileSize = stat.size;
  const range    = req.headers.range;
  const ext      = path.extname(file).toLowerCase();
  const mimeMap  = {
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  };
  const mime = mimeMap[ext] || 'video/mp4';

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   mime,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  }
});

// ── API: probe codec (quick check via ffprobe) ────────────────────────────────
app.get('/api/probe', (req, res) => {
  const file = req.query.file;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  exec(
    `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "${file}"`,
    (err, stdout) => {
      if (err) return res.status(500).json({ error: 'probe failed' });
      res.json({ codec: stdout.trim() });
    }
  );
});

// ── API: transcode → fragmented mp4 stream ────────────────────────────────────
// ?file=...  absolute path
// ?t=...     optional start time in seconds for seeking
app.get('/api/transcode', (req, res) => {
  const file = req.query.file;
  const t    = parseFloat(req.query.t) || 0;

  if (!file || !fs.existsSync(file)) return res.status(404).send('Not found');

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Transfer-Encoding', 'chunked');

  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...(t > 0 ? ['-ss', String(t)] : []),
    '-i', file,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', 'frag_keyframe+empty_moov+faststart',
    '-f', 'mp4',
    'pipe:1',
  ];

  const ff = spawn('ffmpeg', args);
  ff.stdout.pipe(res);
  ff.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) console.error('[ffmpeg]', msg);
  });
  ff.on('error', err => {
    console.error('ffmpeg spawn error:', err);
    if (!res.headersSent) res.status(500).send('ffmpeg error');
  });
  req.on('close', () => ff.kill('SIGKILL'));
});

const PORT = process.env.PORT || 3737;
app.listen(PORT, () => {
  console.log(`\n  Course Viewer → http://localhost:${PORT}\n`);
});
