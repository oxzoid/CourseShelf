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
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.wmv', '.flv', '.ts']);
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

// ── HLS segmented transcode system ───────────────────────────────────────────
const crypto   = require('crypto');
const TEMP_DIR = path.join(__dirname, 'temp');

// Clean and recreate temp dir on startup
if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR);

// jobs: id → { status, segmentCount, ff, dir, filePath }
// status: 'starting' | 'streaming' | 'done' | 'error'
const jobs = {};

function hashFile(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex');
}

// ── API: start HLS transcode job ──────────────────────────────────────────────
app.post('/api/transcode-start', (req, res) => {
  const { file } = req.body;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });

  const id  = hashFile(file);
  const dir = path.join(TEMP_DIR, id);

  // Reuse if already running or done
  if (jobs[id]?.status === 'streaming' || jobs[id]?.status === 'done') {
    return res.json({ jobId: id, status: jobs[id].status, segmentCount: jobs[id].segmentCount, duration: jobs[id].duration || 0 });
  }

  // Fresh start — get duration synchronously via ffprobe before starting ffmpeg
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);

  exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`, (_, stdout) => {
    const duration = parseFloat(stdout) || 0;
    jobs[id] = { status: 'starting', segmentCount: 0, dir, filePath: file, duration, seekBase: 0 };

    const playlist = path.join(dir, 'index.m3u8');
    const segPat   = path.join(dir, 'seg%04d.ts');

  // Start immediately with stream copy (no probe delay)
  // If copy fails (non-h264), retry with re-encode
  function startFfmpeg(useEncode) {
    const args = useEncode ? [
      '-hide_banner', '-loglevel', 'error',
      '-i', file,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', '28', '-threads', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_playlist_type', 'event',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', segPat,
      playlist,
    ] : [
      '-hide_banner', '-loglevel', 'error',
      '-i', file,
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
      '-hls_playlist_type', 'event',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', segPat,
      playlist,
    ];

    const ff = spawn('ffmpeg', args);
    jobs[id].ff = ff;
    console.log(`[hls] ${useEncode ? 'RE-ENCODE' : 'COPY'}: ${path.basename(file)}`);

    const segPoller = setInterval(() => {
      if (!jobs[id]) { clearInterval(segPoller); return; }
      try {
        const count = fs.readdirSync(dir).filter(f => f.endsWith('.ts')).length;
        jobs[id].segmentCount = count;
        if (count > 0 && jobs[id].status === 'starting') jobs[id].status = 'streaming';
      } catch (_) {}
    }, 200);

    ff.on('close', code => {
      clearInterval(segPoller);
      if (code !== 0 && !useEncode) {
        // Copy failed — wipe partial files and retry with encode
        console.log(`[hls] copy failed, retrying with encode: ${path.basename(file)}`);
        try { fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f))); } catch (_) {}
        jobs[id].segmentCount = 0;
        jobs[id].status = 'starting';
        startFfmpeg(true);
        return;
      }
      try {
        jobs[id].segmentCount = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter(f => f.endsWith('.ts')).length : 0;
      } catch (_) {}
      jobs[id].status = code === 0 ? 'done' : 'error';
      if (code !== 0) console.error('[hls] ffmpeg failed, code:', code);
    });

    ff.stderr.on('data', () => {});
    ff.on('error', err => { jobs[id].status = 'error'; console.error('[hls] spawn error:', err); });
  }

  startFfmpeg(false); // try copy first
  res.json({ jobId: id, status: 'starting', duration });
  }); // end exec callback
});

// ── API: delete a transcode job and its temp files ────────────────────────────
app.delete('/api/transcode-job', (req, res) => {
  const { jobId } = req.query;
  const job = jobs[jobId];
  if (!job) return res.json({ ok: true }); // already gone
  if (job.ff) job.ff.kill('SIGKILL');
  if (fs.existsSync(job.dir)) fs.rmSync(job.dir, { recursive: true });
  delete jobs[jobId];
  res.json({ ok: true });
});

// ── API: poll HLS job status ──────────────────────────────────────────────────
app.get('/api/transcode-status', (req, res) => {
  const job = jobs[req.query.jobId];
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json({ status: job.status, segmentCount: job.segmentCount, duration: job.duration || 0 });
});

// ── API: serve HLS playlist with duration injection ───────────────────────────
app.get('/api/hls/:jobId/index.m3u8', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).send('Not found');
  const playlist = path.join(job.dir, 'index.m3u8');
  if (!fs.existsSync(playlist)) return res.status(404).send('Not ready');

  let raw = fs.readFileSync(playlist, 'utf8').replace(/\r\n/g, '\n');

  // Rewrite segment filenames to go through our API
  raw = raw.replace(/^(seg\d+\.ts)$/mg, `/api/hls/${req.params.jobId}/$1`);

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(raw);
});

// ── API: seek — restart ffmpeg from a specific time ──────────────────────────
app.post('/api/hls-seek', (req, res) => {
  const { jobId, seekTime } = req.body;
  const job = jobs[jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const t = Math.max(0, Math.floor(parseFloat(seekTime)));

  // Kill current ffmpeg
  if (job.ff) { try { job.ff.kill('SIGKILL'); } catch (_) {} job.ff = null; }

  // Wipe existing segments and playlist to avoid stale data
  try {
    fs.readdirSync(job.dir).forEach(f => {
      if (f.endsWith('.ts') || f.endsWith('.m3u8')) fs.unlinkSync(path.join(job.dir, f));
    });
  } catch (_) {}

  job.segmentCount = 0;
  job.status = 'starting';
  job.seekBase = t; // track what time offset we started from

  const segPat   = path.join(job.dir, 'seg%04d.ts');
  const playlist = path.join(job.dir, 'index.m3u8');

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(t),
    '-i', job.filePath,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_segment_filename', segPat,
    playlist,
  ];

  const ff = spawn('ffmpeg', args);
  job.ff = ff;
  console.log(`[hls] SEEK to ${t}s: ${path.basename(job.filePath)}`);

  const segPoller = setInterval(() => {
    if (!jobs[jobId]) { clearInterval(segPoller); return; }
    try {
      const count = fs.readdirSync(job.dir).filter(f => f.endsWith('.ts')).length;
      job.segmentCount = count;
      if (count > 0 && job.status === 'starting') job.status = 'streaming';
    } catch (_) {}
  }, 200);

  ff.on('close', code => {
    clearInterval(segPoller);
    try { job.segmentCount = fs.readdirSync(job.dir).filter(f => f.endsWith('.ts')).length; } catch (_) {}
    job.status = code === 0 ? 'done' : 'error';
    job.ff = null;
  });
  ff.stderr.on('data', () => {});
  ff.on('error', err => { job.status = 'error'; console.error('[hls-seek]', err); });

  res.json({ ok: true, seekBase: t });
});

// ── API: serve HLS segments (waits up to 30s for segment to be encoded) ──────
app.get('/api/hls/:jobId/:segment', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).send('Not found');
  const segFile = path.join(job.dir, req.params.segment);

  // If segment already exists, serve immediately
  if (fs.existsSync(segFile)) {
    res.setHeader('Content-Type', 'video/mp2t');
    return fs.createReadStream(segFile).pipe(res);
  }

  // Segment not yet encoded — poll for it up to 15s
  const deadline = Date.now() + 15000;
  const poller = setInterval(() => {
    if (fs.existsSync(segFile)) {
      clearInterval(poller);
      res.setHeader('Content-Type', 'video/mp2t');
      fs.createReadStream(segFile).pipe(res);
    } else if (Date.now() > deadline) {
      clearInterval(poller);
      res.status(404).send('Segment not ready');
    }
  }, 200);

  // Clean up if client disconnects
  req.on('close', () => clearInterval(poller));
});

// ── Job cleanup helpers ───────────────────────────────────────────────────────
function deleteJob(id) {
  const job = jobs[id];
  if (!job) return;
  if (job.ff) { try { job.ff.kill('SIGKILL'); } catch (_) {} }
  if (fs.existsSync(job.dir)) fs.rmSync(job.dir, { recursive: true });
  delete jobs[id];
  console.log(`[hls] deleted job ${id}`);
}

// ── API: schedule job deletion (5s grace — refresh can cancel) ────────────────
app.post('/api/cleanup-job', express.text({ type: '*/*' }), (req, res) => {
  let jobId;
  try { jobId = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body).jobId; } catch (_) {}
  if (!jobId || !jobs[jobId]) return res.json({ ok: false });
  jobs[jobId].deleteTimer = setTimeout(() => deleteJob(jobId), 5000);
  res.json({ ok: true });
});

// ── API: cancel pending deletion (called on refresh/reload) ──────────────────
app.post('/api/cancel-cleanup', (req, res) => {
  const { jobIds } = req.body;
  if (!Array.isArray(jobIds)) return res.json({ ok: false });
  jobIds.forEach(id => {
    if (jobs[id]?.deleteTimer) {
      clearTimeout(jobs[id].deleteTimer);
      delete jobs[id].deleteTimer;
    }
  });
  res.json({ ok: true });
});

// ── API: cleanup specific job immediately (on video switch) ───────────────────
app.post('/api/cleanup-job-now', (req, res) => {
  const { jobId } = req.body;
  if (jobId && jobs[jobId]) deleteJob(jobId);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3737;
app.listen(PORT, () => {
  console.log(`\n  CourseShelf → http://localhost:${PORT}\n`);
});