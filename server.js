const express = require('express');
const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB ────────────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'progress.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    root TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS progress (
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(folder_id, file_path)
  );
  CREATE TABLE IF NOT EXISTS positions (
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    position  REAL NOT NULL DEFAULT 0,
    PRIMARY KEY(folder_id, file_path)
  );
  CREATE TABLE IF NOT EXISTS last_active (
    folder_id INTEGER PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const folderId = root => {
  db.prepare('INSERT INTO folders(root) VALUES(?) ON CONFLICT(root) DO NOTHING').run(root);
  return db.prepare('SELECT id FROM folders WHERE root=?').get(root).id;
};

// ── File scan ─────────────────────────────────────────────────────────────────
const VIDEO = new Set(['.mp4','.mkv','.webm','.avi','.mov','.m4v','.wmv','.flv','.ts']);
const NATIVE = new Set(['.mp4','.webm','.m4v']);

function scan(dir, prefix = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const nat = (a,b) => a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'});
  const dirs  = entries.filter(e=>e.isDirectory()).sort(nat);
  const files = entries.filter(e=>e.isFile()).sort(nat);
  const out = [];
  dirs.forEach((d,i) => {
    const num = prefix ? `${prefix}.${i+1}` : `${i+1}`;
    const p = path.join(dir, d.name);
    out.push({ type:'folder', name:d.name, path:p, number:num, children:scan(p, num) });
  });
  files.forEach(f => {
    const ext = path.extname(f.name).toLowerCase();
    let type = VIDEO.has(ext) ? 'video' : ext==='.pdf' ? 'pdf' : ['.txt','.md','.markdown'].includes(ext) ? 'text' : null;
    if (!type) return;
    out.push({ type:'file', fileType:type, name:f.name, path:path.join(dir,f.name), ext });
  });
  return out;
}

// ── Basic APIs ────────────────────────────────────────────────────────────────
app.get('/api/tree', (req,res) => {
  const {root} = req.query;
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory())
    return res.status(400).json({error:'Invalid path'});
  res.json({root, tree: scan(root)});
});

app.get('/api/progress', (req,res) => {
  const id = folderId(req.query.root);
  const rows = db.prepare('SELECT file_path,completed FROM progress WHERE folder_id=?').all(id);
  const map = {};
  rows.forEach(r => map[r.file_path.replace(/\\/g,'/')] = !!r.completed);
  res.json(map);
});

app.post('/api/progress', (req,res) => {
  const {root,filePath,completed} = req.body;
  const fp = filePath.replace(/\\/g,'/');
  const id = folderId(root);
  db.prepare(`INSERT INTO progress(folder_id,file_path,completed) VALUES(?,?,?)
    ON CONFLICT(folder_id,file_path) DO UPDATE SET completed=excluded.completed`)
    .run(id, fp, completed?1:0);
  res.json({ok:true});
});

app.get('/api/position', (req,res) => {
  const fp = req.query.file.replace(/\\/g,'/');
  const id = folderId(req.query.root);
  const row = db.prepare('SELECT position FROM positions WHERE folder_id=? AND file_path=?').get(id,fp);
  res.json({position: row?.position ?? 0});
});

app.post('/api/position', (req,res) => {
  const {root,filePath,position} = req.body;
  const fp = filePath.replace(/\\/g,'/');
  const id = folderId(root);
  db.prepare(`INSERT INTO positions(folder_id,file_path,position) VALUES(?,?,?)
    ON CONFLICT(folder_id,file_path) DO UPDATE SET position=excluded.position`)
    .run(id, fp, position);
  res.json({ok:true});
});

app.get('/api/last-active', (req,res) => {
  const id = folderId(req.query.root);
  const row = db.prepare('SELECT file_path FROM last_active WHERE folder_id=?').get(id);
  res.json({filePath: row?.file_path ?? null});
});

app.post('/api/last-active', (req,res) => {
  const fp = req.body.filePath.replace(/\\/g,'/');
  const id = folderId(req.body.root);
  db.prepare(`INSERT INTO last_active(folder_id,file_path) VALUES(?,?)
    ON CONFLICT(folder_id) DO UPDATE SET file_path=excluded.file_path`)
    .run(id, fp);
  res.json({ok:true});
});

app.get('/api/settings', (req,res) => {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  res.json(Object.fromEntries(rows.map(r=>[r.key,r.value])));
});

app.post('/api/settings', (req,res) => {
  const {key,value} = req.body;
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));
  res.json({ok:true});
});

app.get('/api/file', (req,res) => {
  const f = req.query.file;
  if (!f || !fs.existsSync(f)) return res.status(404).send('Not found');
  const ext = path.extname(f).toLowerCase();
  const mime = {'.pdf':'application/pdf','.txt':'text/plain','.md':'text/plain','.markdown':'text/plain'}[ext];
  if (!mime) return res.status(400).send('Unsupported');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition','inline');
  fs.createReadStream(f).pipe(res);
});

app.get('/api/video', (req,res) => {
  const f = req.query.file;
  if (!f || !fs.existsSync(f)) return res.status(404).send('Not found');
  const stat = fs.statSync(f);
  if (stat.size === 0) return res.status(204).send('');
  const ext  = path.extname(f).toLowerCase();
  const mime = {'.mp4':'video/mp4','.webm':'video/webm','.m4v':'video/mp4'}[ext] || 'video/mp4';
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/,'').split('-');
    const start = Math.max(0, parseInt(parts[0], 10) || 0);
    const end   = parts[1] ? Math.min(parseInt(parts[1], 10), stat.size - 1) : stat.size - 1;
    if (start > end) return res.status(416).send('Range Not Satisfiable');
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
    });
    fs.createReadStream(f, {start, end}).pipe(res);
  } else {
    res.writeHead(200, {'Content-Length':stat.size,'Content-Type':mime,'Accept-Ranges':'bytes'});
    fs.createReadStream(f).pipe(res);
  }
});

<<<<<<< HEAD
// ── Convert to mp4 ────────────────────────────────────────────────────────────
const NON_NATIVE = new Set(['.ts','.mkv','.mov','.flv','.avi','.wmv','.m4v','.flv']);
let convertJob = null;
let convertFF  = null; // current ffmpeg process, so we can kill it

function findConvertible(dir, out=[]) {
  for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
    const full = path.join(dir,e.name);
    if (e.isDirectory()) findConvertible(full,out);
    else if (e.isFile() && NON_NATIVE.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

app.post('/api/convert', (req,res) => {
  const {root} = req.body;
  if (!root || !fs.existsSync(root)) return res.status(400).json({error:'Invalid root'});
  if (convertJob && convertJob.done < convertJob.total) return res.status(409).json({error:'Already running'});
  const files = findConvertible(root);
  if (!files.length) return res.json({total:0});
  convertJob = {total:files.length, done:0, errors:0, current:''};
  res.json({total:files.length});

  (async () => {
    for (const src of files) {
      const ext  = path.extname(src).toLowerCase();
      const dest = src.slice(0, src.lastIndexOf('.')) + '.mp4';
      convertJob.current = path.basename(src);
      console.log(`[convert] ${path.basename(src)} → ${path.basename(dest)}`);

      const needsEncode = ['.avi','.wmv'].includes(ext);
      const inputArgs   = ext === '.ts' ? ['-f','mpegts','-analyzeduration','1000000','-probesize','1000000'] : [];
      const codecArgs   = needsEncode
        ? ['-c:v','libx264','-preset','ultrafast','-crf','26','-threads','2','-c:a','aac','-b:a','128k']
        : ['-c','copy'];

      const ffmpegErr = await new Promise(resolve => {
        const ff = spawn('ffmpeg', [
          '-hide_banner', '-loglevel', 'error',
          ...inputArgs, '-i', src,
          ...codecArgs,
          '-movflags', '+faststart',
          '-y', dest,
        ]);
        convertFF = ff;
        let errOut = '';
        ff.stderr.on('data', d => { errOut += String(d); });
        ff.on('close', code => {
          convertFF = null;
          if (errOut.trim()) console.error(`[convert] ffmpeg: ${errOut.trim()}`);
          resolve(code === 0 ? null : `exit ${code}: ${errOut.trim().split('\n').pop()}`);
        });
        ff.on('error', err => { convertFF = null; resolve(`spawn error: ${err.message}`); });
      });

      if (ffmpegErr) {
        console.error(`[convert] FAILED ${path.basename(src)}: ${ffmpegErr}`);
        try { fs.unlinkSync(dest); } catch {} // remove partial output
        convertJob.errors++;
      } else {
        try { fs.unlinkSync(src); console.log(`[convert] OK → ${path.basename(dest)}`); }
        catch(e) { console.error(`[convert] delete src failed: ${e.message}`); }
      }
      convertJob.done++;
    }
    convertJob.current = '';
    console.log(`[convert] done: ${convertJob.done} total, ${convertJob.errors} errors`);
  })();
});

app.post('/api/convert-cancel', (req,res) => {
  if (convertFF) { try { convertFF.kill('SIGKILL'); } catch {} convertFF = null; }
  if (convertJob) { convertJob.done = convertJob.total; } // stop loop
  res.json({ok:true});
});

app.get('/api/convert-status', (req,res) => {
  if (!convertJob) return res.json({total:0,done:0,errors:0,current:''});
  res.json(convertJob);
});

app.listen(3737,()=>console.log('\n  CourseShelf → http://localhost:3737\n'));
=======
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
>>>>>>> cd5e0d8efa8ea96f086244020ad0c3b916a86cdf
