import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, initDb } from './db.js';

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

async function loadSession(code) {
  const r = await q('SELECT * FROM sessions WHERE code = $1', [code]);
  return r.rows[0] || null;
}
async function loadPlayer(code, token) {
  const r = await q('SELECT * FROM players WHERE code = $1 AND token = $2', [code, token]);
  return r.rows[0] || null;
}

// Fortschritt + Bingo je Spieler
async function playersOverview(code) {
  const pr = await q('SELECT id, name, created_at FROM players WHERE code = $1 ORDER BY created_at', [code]);
  const players = pr.rows;
  if (!players.length) return [];
  const ids = players.map((p) => p.id);
  const cc = await q('SELECT player_id, COUNT(*)::int AS n FROM cells WHERE player_id = ANY($1) AND title <> \'\' GROUP BY player_id', [ids]);
  const mm = await q('SELECT player_id, idx FROM marks WHERE player_id = ANY($1)', [ids]);
  const cellCount = new Map(cc.rows.map((x) => [x.player_id, x.n]));
  const marksByPlayer = new Map();
  for (const m of mm.rows) { if (!marksByPlayer.has(m.player_id)) marksByPlayer.set(m.player_id, new Set()); marksByPlayer.get(m.player_id).add(m.idx); }
  return players.map((p) => {
    const set = marksByPlayer.get(p.id) || new Set();
    return {
      id: p.id, name: p.name,
      ready: (cellCount.get(p.id) || 0) >= CELLS,
      marks: set.size,
      bingo: hasBingo(set),
    };
  });
}

async function myCard(playerId) {
  const cr = await q('SELECT idx, title FROM cells WHERE player_id = $1 ORDER BY idx', [playerId]);
  const mr = await q('SELECT idx, note FROM marks WHERE player_id = $1', [playerId]);
  const notes = new Map(mr.rows.map((m) => [m.idx, m.note]));
  const cells = Array.from({ length: CELLS }, (_, i) => ({ idx: i, title: '', marked: false, note: null }));
  for (const c of cr.rows) if (c.idx >= 0 && c.idx < CELLS) cells[c.idx].title = c.title;
  for (const m of mr.rows) if (m.idx >= 0 && m.idx < CELLS) { cells[m.idx].marked = true; cells[m.idx].note = notes.get(m.idx) || null; }
  return cells;
}

/* ---------- API ---------- */

// Session anlegen (Ersteller = Admin)
app.post('/api/sessions', async (req, res, next) => {
  try {
    const token = getToken(req, res);
    const name = clip(req.body.name, 80) || 'Party-Bingo';
    let code;
    for (let i = 0; i < 6; i++) { code = newCode(); const ex = await loadSession(code); if (!ex) break; }
    await q('INSERT INTO sessions (code, name, admin_token) VALUES ($1, $2, $3)', [code, name, token]);
    res.json({ ok: true, code, admin: true });
  } catch (e) { next(e); }
});

// Zustand abrufen (für Polling)
app.get('/api/sessions/:code', async (req, res, next) => {
  try {
    const code = clip(req.params.code, 12).toUpperCase();
    const s = await loadSession(code);
    if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
    const token = getToken(req, res);
    const me = await loadPlayer(code, token);
    const isAdmin = s.admin_token === token;
    const players = await playersOverview(code);
    const out = {
      ok: true,
      session: { code: s.code, name: s.name, status: s.status },
      isAdmin,
      players,
      me: me ? { id: me.id, name: me.name, joined: true, card: await myCard(me.id) } : { joined: false },
      cells: CELLS, grid: GRID,
    };
    res.json(out);
  } catch (e) { next(e); }
});

// Beitreten + 16 Felder definieren (oder später aktualisieren)
app.post('/api/sessions/:code/join', async (req, res, next) => {
  try {
    const code = clip(req.params.code, 12).toUpperCase();
    const s = await loadSession(code);
    if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
    if (s.status === 'ended') return res.status(409).json({ ok: false, error: 'Dieses Spiel ist bereits beendet.' });
    const token = getToken(req, res);
    const name = clip(req.body.name, 40);
    if (!name) return res.status(422).json({ ok: false, error: 'Bitte einen Namen angeben.' });
    const titles = Array.isArray(req.body.titles) ? req.body.titles : [];
    const clean = Array.from({ length: CELLS }, (_, i) => clip(titles[i], 120));

    let player = await loadPlayer(code, token);
    if (!player) {
      const ins = await q('INSERT INTO players (code, token, name, ip) VALUES ($1,$2,$3,$4) RETURNING *', [code, token, name, clientIp(req)]);
      player = ins.rows[0];
    } else {
      await q('UPDATE players SET name = $1 WHERE id = $2', [name, player.id]);
    }
    // Felder speichern (upsert je idx)
    for (let i = 0; i < CELLS; i++) {
      await q(
        `INSERT INTO cells (player_id, idx, title) VALUES ($1,$2,$3)
         ON CONFLICT (player_id, idx) DO UPDATE SET title = EXCLUDED.title`,
        [player.id, i, clean[i]]
      );
    }
    res.json({ ok: true, id: player.id });
  } catch (e) { next(e); }
});

// Admin: Spiel starten
app.post('/api/sessions/:code/start', async (req, res, next) => {
  try {
    const code = clip(req.params.code, 12).toUpperCase();
    const s = await loadSession(code);
    if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
    if (s.admin_token !== getToken(req, res)) return res.status(403).json({ ok: false, error: 'Nur der Admin kann starten.' });
    await q("UPDATE sessions SET status = 'running' WHERE code = $1", [code]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Admin: Spiel beenden
app.post('/api/sessions/:code/end', async (req, res, next) => {
  try {
    const code = clip(req.params.code, 12).toUpperCase();
    const s = await loadSession(code);
    if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
    if (s.admin_token !== getToken(req, res)) return res.status(403).json({ ok: false, error: 'Nur der Admin kann beenden.' });
    await q("UPDATE sessions SET status = 'ended', ended_at = now() WHERE code = $1", [code]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Feld mit Beweisfoto markieren
app.post('/api/sessions/:code/mark', upload.single('photo'), async (req, res, next) => {
  try {
    const code = clip(req.params.code, 12).toUpperCase();
    const s = await loadSession(code);
    if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
    if (s.status !== 'running') return res.status(409).json({ ok: false, error: 'Das Spiel läuft gerade nicht.' });
    const token = getToken(req, res);
    const player = await loadPlayer(code, token);
    if (!player) return res.status(403).json({ ok: false, error: 'Bitte zuerst beitreten.' });
    const idx = parseInt(req.body.idx, 10);
    if (!(idx >= 0 && idx < CELLS)) return res.status(422).json({ ok: false, error: 'Ungültiges Feld.' });
    if (!req.file) return res.status(422).json({ ok: false, error: 'Bitte ein Beweisfoto hochladen.' });
    const note = clip(req.body.note, 200);
    await q(
      `INSERT INTO marks (player_id, idx, image, mime, note) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (player_id, idx) DO UPDATE SET image = EXCLUDED.image, mime = EXCLUDED.mime, note = EXCLUDED.note, created_at = now()`,
      [player.id, idx, req.file.buffer, req.file.mimetype || 'image/jpeg', note]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Markierung entfernen
app.post('/api/sessions/:code/unmark', async (req, res, next) => {
  try {
    const code = clip(req.params.code, 12).toUpperCase();
    const s = await loadSession(code);
    if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
    const player = await loadPlayer(code, getToken(req, res));
    if (!player) return res.status(403).json({ ok: false, error: 'Nicht beigetreten.' });
    const idx = parseInt(req.body.idx, 10);
    await q('DELETE FROM marks WHERE player_id = $1 AND idx = $2', [player.id, idx]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Beweisfoto ausliefern
app.get('/api/sessions/:code/photo/:markId', async (req, res, next) => {
  try {
    const code = clip(req.params.code, 12).toUpperCase();
    const markId = parseInt(req.params.markId, 10);
    const r = await q(
      `SELECT m.image, m.mime FROM marks m JOIN players p ON p.id = m.player_id
       WHERE m.id = $1 AND p.code = $2`, [markId, code]);
    const row = r.rows[0];
    if (!row || !row.image) return res.status(404).end();
    res.set('Content-Type', row.mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(row.image);
  } catch (e) { next(e); }
});

// Zusammenfassung am Ende
app.get('/api/sessions/:code/summary', async (req, res, next) => {
  try {
    const code = clip(req.params.code, 12).toUpperCase();
    const s = await loadSession(code);
    if (!s) return res.status(404).json({ ok: false, error: 'Session nicht gefunden.' });
    const pr = await q('SELECT id, name FROM players WHERE code = $1 ORDER BY created_at', [code]);
    const result = [];
    for (const p of pr.rows) {
      const cr = await q('SELECT idx, title FROM cells WHERE player_id = $1 ORDER BY idx', [p.id]);
      const mr = await q('SELECT id, idx, note FROM marks WHERE player_id = $1', [p.id]);
      const marks = new Map(mr.rows.map((m) => [m.idx, m]));
      const titles = new Map(cr.rows.map((c) => [c.idx, c.title]));
      const cells = Array.from({ length: CELLS }, (_, i) => {
        const m = marks.get(i);
        return {
          idx: i,
          title: titles.get(i) || '',
          marked: !!m,
          note: m ? m.note : null,
          photo: m ? `/api/sessions/${code}/photo/${m.id}` : null,
        };
      });
      const markedSet = new Set(mr.rows.map((m) => m.idx));
      result.push({ name: p.name, marks: markedSet.size, bingo: hasBingo(markedSet), cells });
    }
    res.json({ ok: true, session: { code: s.code, name: s.name, status: s.status }, players: result, grid: GRID });
  } catch (e) { next(e); }
});

// SPA-Fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error('[err]', err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, error: 'Foto zu groß (max. 10 MB).' });
  res.status(500).json({ ok: false, error: 'Serverfehler.' });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`[party-bingo] läuft auf :${PORT}`)))
  .catch((e) => { console.error('[db] Init fehlgeschlagen:', e.message); process.exit(1); });
