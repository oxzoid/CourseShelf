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