import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, all, run, initDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const CELLS = 16;            // 4x4 Bingo
const GRID = 4;

app.set('trust proxy', true); // echte Client-IP hinter Render/Cloudflare
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/* ---------- Helfer ---------- */
const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne verwechselbare Zeichen
function newCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const clientIp = (req) => (req.headers['cf-connecting-ip'] || req.ip || '').toString();

function getToken(req, res) {
  let t = req.cookies.pb_token;
  if (!t) {
    t = rid();
    res.cookie('pb_token', t, { maxAge: 1000 * 60 * 60 * 24 * 60, httpOnly: true, sameSite: 'lax', secure: true });
  }
  return t;
}

const WIN_LINES = (() => {
  const lines = [];
  for (let r = 0; r < GRID; r++) lines.push(Array.from({ length: GRID }, (_, c) => r * GRID + c));
  for (let c = 0; c < GRID; c++) lines.push(Array.from({ length: GRID }, (_, r) => r * GRID + c));
  lines.push(Array.from({ length: GRID }, (_, i) => i * GRID + i));
  lines.push(Array.from({ length: GRID }, (_, i) => i * GRID + (GRID - 1 - i)));
  return lines;
})();
const hasBingo = (marked) => WIN_LINES.some((line) => line.every((i) => marked.has(i)));

const loadSession = (code) => get('SELECT * FROM sessions WHERE code = ?', [code]) || null;
const loadPlayer = (code, token) => get('SELECT * FROM players WHERE code = ? AND token = ?', [code, token]) || null;

// Fortschritt + Bingo je Spieler
function playersOverview(code) {
  const players = all('SELECT id, name, created_at FROM players WHERE code = ? ORDER BY created_at, id', [code]);
  return players.map((p) => {
    const n = num(get("SELECT COUNT(*) AS n FROM cells WHERE player_id = ? AND title <> ''", [p.id]).n);
    const marks = all('SELECT idx FROM marks WHERE player_id = ?', [p.id]).map((m) => m.idx);
    const set = new Set(marks);
    return { id: num(p.id), name: p.name, ready: n >= CELLS, marks: set.size, bingo: hasBingo(set) };
  });
}

function myCard(playerId) {
  const cr = all('SELECT idx, title FROM cells WHERE player_id = ? ORDER BY idx', [playerId]);
  const mr = all('SELECT idx, note FROM marks WHERE player_id = ?', [playerId]);
  const notes = new Map(mr.map((m) => [m.idx, m.note]));
  const marked = new Set(mr.map((m) => m.idx));
  const titles = new Map(cr.map((c) => [c.idx, c.title]));
  return Array.from({ length: CELLS }, (_, i) => ({
    idx: i, title: titles.get(i) || '', marked: marked.has(i), note: marked.has(i) ? (notes.get(i) || null) : null,
  }));
}

/* ---------- API ---------- */

// Session anlegen (Ersteller = Admin)
app.post('/api/sessions', (req, res) => {
  const token = getToken(req, res);
  const name = clip(req.body.name, 80) || 'Party-Bingo';
  let code;
  for (let i = 0; i < 8; i++) { code = newCode(); if (!loadSession(code)) break; }
  run('INSERT INTO sessions (code, name, admin_token) VALUES (?, ?, ?)', [code, name, token]);
  res.json({ ok: true, code, admin: true });
});

// Zustand abrufen (für Polling)
app.get('/api/sessions/:code', (req, res) => {
  const code = clip(req.params.code, 12).toUpperCase();
  const s = loadSession(code);
  if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
  const token = getToken(req, res);
  const me = loadPlayer(code, token);
  res.json({
    ok: true,
    session: { code: s.code, name: s.name, status: s.status },
    isAdmin: s.admin_token === token,
    players: playersOverview(code),
    me: me ? { id: num(me.id), name: me.name, joined: true, card: myCard(me.id) } : { joined: false },
    cells: CELLS, grid: GRID,
  });
});

// Beitreten + 16 Felder definieren (oder später aktualisieren)
app.post('/api/sessions/:code/join', (req, res) => {
  const code = clip(req.params.code, 12).toUpperCase();
  const s = loadSession(code);
  if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
  if (s.status === 'ended') return res.status(409).json({ ok: false, error: 'Dieses Spiel ist bereits beendet.' });
  const token = getToken(req, res);
  const name = clip(req.body.name, 40);
  if (!name) return res.status(422).json({ ok: false, error: 'Bitte einen Namen angeben.' });
  const titles = Array.isArray(req.body.titles) ? req.body.titles : [];
  const clean = Array.from({ length: CELLS }, (_, i) => clip(titles[i], 120));

  let player = loadPlayer(code, token);
  if (!player) {
    const r = run('INSERT INTO players (code, token, name, ip) VALUES (?,?,?,?)', [code, token, name, clientIp(req)]);
    player = { id: num(r.lastInsertRowid) };
  } else {
    run('UPDATE players SET name = ? WHERE id = ?', [name, player.id]);
  }
  for (let i = 0; i < CELLS; i++) {
    run(
      `INSERT INTO cells (player_id, idx, title) VALUES (?,?,?)
       ON CONFLICT(player_id, idx) DO UPDATE SET title = excluded.title`,
      [player.id, i, clean[i]]
    );
  }
  res.json({ ok: true, id: num(player.id) });
});

// Admin: Spiel starten
app.post('/api/sessions/:code/start', (req, res) => {
  const code = clip(req.params.code, 12).toUpperCase();
  const s = loadSession(code);
  if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
  if (s.admin_token !== getToken(req, res)) return res.status(403).json({ ok: false, error: 'Nur der Admin kann starten.' });
  run("UPDATE sessions SET status = 'running' WHERE code = ?", [code]);
  res.json({ ok: true });
});

// Admin: Spiel beenden
app.post('/api/sessions/:code/end', (req, res) => {
  const code = clip(req.params.code, 12).toUpperCase();
  const s = loadSession(code);
  if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
  if (s.admin_token !== getToken(req, res)) return res.status(403).json({ ok: false, error: 'Nur der Admin kann beenden.' });
  run("UPDATE sessions SET status = 'ended', ended_at = datetime('now') WHERE code = ?", [code]);
  res.json({ ok: true });
});

// Feld mit Beweisfoto markieren
app.post('/api/sessions/:code/mark', upload.single('photo'), (req, res) => {
  const code = clip(req.params.code, 12).toUpperCase();
  const s = loadSession(code);
  if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
  if (s.status !== 'running') return res.status(409).json({ ok: false, error: 'Das Spiel läuft gerade nicht.' });
  const player = loadPlayer(code, getToken(req, res));
  if (!player) return res.status(403).json({ ok: false, error: 'Bitte zuerst beitreten.' });
  const idx = parseInt(req.body.idx, 10);
  if (!(idx >= 0 && idx < CELLS)) return res.status(422).json({ ok: false, error: 'Ungültiges Feld.' });
  if (!req.file) return res.status(422).json({ ok: false, error: 'Bitte ein Beweisfoto hochladen.' });
  const note = clip(req.body.note, 200);
  run(
    `INSERT INTO marks (player_id, idx, image, mime, note) VALUES (?,?,?,?,?)
     ON CONFLICT(player_id, idx) DO UPDATE SET image = excluded.image, mime = excluded.mime, note = excluded.note, created_at = datetime('now')`,
    [player.id, idx, req.file.buffer, req.file.mimetype || 'image/jpeg', note]
  );
  res.json({ ok: true });
});

// Markierung entfernen
app.post('/api/sessions/:code/unmark', (req, res) => {
  const code = clip(req.params.code, 12).toUpperCase();
  const s = loadSession(code);
  if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
  const player = loadPlayer(code, getToken(req, res));
  if (!player) return res.status(403).json({ ok: false, error: 'Nicht beigetreten.' });
  run('DELETE FROM marks WHERE player_id = ? AND idx = ?', [player.id, parseInt(req.body.idx, 10)]);
  res.json({ ok: true });
});

// Beweisfoto ausliefern
app.get('/api/sessions/:code/photo/:markId', (req, res) => {
  const code = clip(req.params.code, 12).toUpperCase();
  const markId = parseInt(req.params.markId, 10);
  const row = get(
    `SELECT m.image AS image, m.mime AS mime FROM marks m JOIN players p ON p.id = m.player_id
     WHERE m.id = ? AND p.code = ?`, [markId, code]);
  if (!row || !row.image) return res.status(404).end();
  res.set('Content-Type', row.mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from(row.image));
});

// Zusammenfassung am Ende
app.get('/api/sessions/:code/summary', (req, res) => {
  const code = clip(req.params.code, 12).toUpperCase();
  const s = loadSession(code);
  if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
  const players = all('SELECT id, name FROM players WHERE code = ? ORDER BY created_at, id', [code]);
  const result = players.map((p) => {
    const titles = new Map(all('SELECT idx, title FROM cells WHERE player_id = ?', [p.id]).map((c) => [c.idx, c.title]));
    const mr = all('SELECT id, idx, note FROM marks WHERE player_id = ?', [p.id]);
    const marks = new Map(mr.map((m) => [m.idx, m]));
    const cells = Array.from({ length: CELLS }, (_, i) => {
      const m = marks.get(i);
      return {
        idx: i, title: titles.get(i) || '', marked: !!m, note: m ? m.note : null,
        photo: m ? `/api/sessions/${code}/photo/${num(m.id)}` : null,
      };
    });
    const markedSet = new Set(mr.map((m) => m.idx));
    return { name: p.name, marks: markedSet.size, bingo: hasBingo(markedSet), cells };
  });
  res.json({ ok: true, session: { code: s.code, name: s.name, status: s.status }, players: result, grid: GRID });
});

// SPA-Fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error('[err]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, error: 'Foto zu groß (max. 10 MB).' });
  res.status(500).json({ ok: false, error: 'Serverfehler.' });
});

initDb();
app.listen(PORT, () => console.log(`[party-bingo] läuft auf :${PORT}`));
