'use strict';
const app = document.getElementById('app');
const CELLS = 16;

/* ---------- Mini-Helfer ---------- */
const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastT;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}
async function api(method, url, body, isForm) {
  const opt = { method, headers: {} };
  if (body && !isForm) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  else if (isForm) opt.body = body;
  const r = await fetch(url, opt);
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok || j.ok === false) throw new Error(j.error || 'Fehler (' + r.status + ')');
  return j;
}
const go = (path) => { history.pushState({}, '', path); route(); };
window.addEventListener('popstate', route);

/* Foto clientseitig verkleinern (schneller Upload, weniger Speicher) */
async function shrink(file, max = 1280, quality = 0.82) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  let { width: w, height: h } = img;
  if (w > max || h > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(img.src);
  return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', quality));
}

/* ---------- Routing ---------- */
function route() {
  const m = location.pathname.match(/^\/s\/([A-Za-z0-9]+)/);
  if (m) return renderSession(m[1].toUpperCase());
  renderHome();
}

/* ---------- Startseite ---------- */
function renderHome() {
  app.innerHTML = '';
  app.append(el(`
    <div>
      <div class="logo">🎉</div>
      <h1 class="center">Party-<span class="grad">Bingo</span></h1>
      <p class="center">Tritt einer Runde bei, lege 16 Vorhersagen fest und sammle Beweisfotos von der Party. Wer zuerst eine Reihe voll hat, ruft <b>Bingo!</b></p>

      <div class="card">
        <h3>Session beitreten</h3>
        <label>Session-Code</label>
        <input id="joinCode" placeholder="z. B. K7M2Q" autocapitalize="characters" autocomplete="off" maxlength="12">
        <button class="btn ghost" id="goJoin" style="margin-top:12px">Beitreten →</button>
      </div>

      <div class="card">
        <h3>Neue Runde erstellen</h3>
        <p class="small">Du wirst Admin und startest bzw. beendest das Spiel.</p>
        <label>Name der Party</label>
        <input id="sessName" placeholder="z. B. Cans Geburtstag" maxlength="80">
        <button class="btn gold" id="goCreate" style="margin-top:12px">🎲 Runde erstellen</button>
      </div>
      <div class="foot">Mehrspieler-Party-Bingo · dein Stand bleibt beim Neuladen erhalten</div>
    </div>
  `));
  const code = document.getElementById('joinCode');
  document.getElementById('goJoin').onclick = () => {
    const c = code.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!c) return toast('Bitte Code eingeben');
    go('/s/' + c);
  };
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('goJoin').click(); });
  document.getElementById('goCreate').onclick = async (e) => {
    const name = document.getElementById('sessName').value.trim();
    e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span> Erstelle…';
    try { const r = await api('POST', '/api/sessions', { name }); go('/s/' + r.code); }
    catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = '🎲 Runde erstellen'; }
  };
}

/* ---------- Session ---------- */
let pollTimer = null;
let lastSig = '';
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function renderSession(code) {
  stopPoll();
  app.innerHTML = '<div class="card center"><span class="spin"></span> Lädt…</div>';
  let state;
  try { state = await api('GET', '/api/sessions/' + code); }
  catch (err) {
    app.innerHTML = '';
    app.append(el(`<div class="card center"><h3>😕 ${esc(err.message)}</h3><button class="btn ghost" id="home">← Zur Startseite</button></div>`));
    document.getElementById('home').onclick = () => go('/');
    return;
  }
  drawSession(code, state);
  // Live-Aktualisierung
  pollTimer = setInterval(async () => {
    try {
      const s = await api('GET', '/api/sessions/' + code);
      const sig = JSON.stringify([s.session.status, s.me.joined, s.players.map((p) => [p.name, p.ready, p.marks, p.bingo]), (s.me.card || []).map((c) => [c.title, c.marked])]);
      if (sig !== lastSig && !document.querySelector('.modal') && !document.querySelector('.editing')) { lastSig = sig; drawSession(code, s); }
    } catch {}
  }, 3000);
}

function drawSession(code, s) {
  lastSig = JSON.stringify([s.session.status, s.me.joined, s.players.map((p) => [p.name, p.ready, p.marks, p.bingo]), (s.me.card || []).map((c) => [c.title, c.marked])]);
  app.innerHTML = '';
  if (s.session.status === 'ended') return renderSummary(code, s);
  if (!s.me.joined) return drawJoin(code, s);
  drawBoard(code, s);
}

/* Header mit Code + Status */
function headerCard(code, s) {
  const st = s.session.status;
  const label = st === 'running' ? 'Läuft' : st === 'ended' ? 'Beendet' : 'Lobby';
  return `
    <div class="status-bar">
      <div class="pill" id="shareBtn" style="cursor:pointer">Code <span class="code">${esc(code)}</span> 🔗</div>
      <span class="badge ${st}">${label}</span>
    </div>
    <h2 style="margin-top:8px">${esc(s.session.name)}</h2>`;
}
function wireShare(code, s) {
  const b = document.getElementById('shareBtn');
  if (!b) return;
  b.onclick = async () => {
    const url = location.origin + '/s/' + code;
    const data = { title: 'Party-Bingo', text: `Mach mit beim Party-Bingo "${s.session.name}"! Code: ${code}`, url };
    try { if (navigator.share) await navigator.share(data); else { await navigator.clipboard.writeText(url); toast('Link kopiert'); } }
    catch {}
  };
}

/* Beitreten: Name + 16 Felder */
function drawJoin(code, s) {
  const box = el(`<div class="editing">
    ${headerCard(code, s)}
    <div class="hint">Trag deine <b>16 Vorhersagen</b> ein — Sachen, die auf der Party passieren könnten. Z. B. „Nick fällt um" oder „Can übergibt sich". ${s.session.status === 'running' ? 'Das Spiel läuft schon — du steigst direkt mit ein.' : ''}</div>
    <div class="card">
      <label>Dein Name</label>
      <input id="pname" placeholder="Wie heißt du?" maxlength="40">
      <label style="margin-top:14px">Deine 16 Bingo-Felder</label>
      <div class="grid" id="fields"></div>
      <button class="btn" id="submitJoin">✅ Mitspielen</button>
      <button class="btn ghost sm" id="leave" style="width:100%;margin-top:10px">← Zurück</button>
    </div>
  `);
  app.append(box);
  const fields = box.querySelector('#fields');
  fields.style.display = 'block';
  for (let i = 0; i < CELLS; i++) {
    const inp = el(`<input data-i="${i}" placeholder="Feld ${i + 1}" maxlength="120" style="margin:0 0 8px">`);
    fields.append(inp);
  }
  wireShare(code, s);
  box.querySelector('#leave').onclick = () => go('/');
  box.querySelector('#submitJoin').onclick = async (e) => {
    const name = box.querySelector('#pname').value.trim();
    if (!name) return toast('Bitte Namen eingeben');
    const titles = [...fields.querySelectorAll('input')].map((x) => x.value.trim());
    const filled = titles.filter(Boolean).length;
    if (filled < CELLS) return toast(`Noch ${CELLS - filled} Feld(er) ausfüllen`);
    e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span> Trete bei…';
    try { await api('POST', `/api/sessions/${code}/join`, { name, titles }); renderSession(code); }
    catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = '✅ Mitspielen'; }
  };
}

/* Spielbrett */
function drawBoard(code, s) {
  const st = s.session.status;
  const myBingo = checkBingo(s.me.card);
  const box = el(`<div>
    ${headerCard(code, s)}
    ${myBingo ? '<div class="hint" style="background:rgba(255,210,63,.15);border-color:#7a5a00;color:#ffd23f;font-weight:800;text-align:center">🏆 BINGO! Du hast eine volle Reihe!</div>' : ''}
    ${st === 'lobby' ? '<div class="hint">⏳ Warten auf den Start. Du kannst deine Felder unten noch anpassen.</div>' : ''}
    ${st === 'running' ? '<div class="hint">📸 Tippe auf ein Feld, sobald es passiert — mach ein Beweisfoto!</div>' : ''}
    <div class="grid" id="board"></div>
    <div id="adminArea"></div>
    <div class="card">
      <h3>Mitspieler (${s.players.length})</h3>
      <div class="players" id="players"></div>
    </div>
    <div class="row">
      <button class="btn ghost sm" id="editCard">✏️ Felder ändern</button>
      <button class="btn ghost sm" id="home">← Start</button>
    </div>
  </div>`);
  app.append(box);
  wireShare(code, s);

  const board = box.querySelector('#board');
  s.me.card.forEach((c) => {
    const empty = !c.title;
    const cell = el(`<div class="cell ${c.marked ? 'marked' : ''} ${empty ? 'empty' : ''}" data-i="${c.idx}">
      ${c.marked ? `<div class="bg" data-bg="${c.idx}"></div><div class="check">✓</div>` : ''}
      <div class="txt">${empty ? '—' : esc(c.title)}</div>
    </div>`);
    board.append(cell);
    cell.onclick = () => {
      if (st !== 'running') { toast(st === 'lobby' ? 'Spiel läuft noch nicht' : 'Spiel beendet'); return; }
      if (empty) { toast('Dieses Feld ist leer'); return; }
      openMark(code, c);
    };
  });

  // Admin-Steuerung
  if (s.isAdmin) {
    const a = box.querySelector('#adminArea');
    if (st === 'lobby') {
      const allReady = s.players.every((p) => p.ready) && s.players.length > 0;
      a.append(el(`<div class="card"><h3>👑 Admin</h3>
        <p class="small">${s.players.filter((p) => p.ready).length}/${s.players.length} Spieler bereit. Späteinsteiger können auch nach dem Start noch beitreten.</p>
        <button class="btn gold" id="startBtn">🚀 Spiel starten</button></div>`));
      a.querySelector('#startBtn').onclick = async (e) => {
        e.target.disabled = true;
        try { await api('POST', `/api/sessions/${code}/start`); renderSession(code); }
        catch (err) { toast(err.message); e.target.disabled = false; }
      };
    } else if (st === 'running') {
      a.append(el(`<div class="card"><h3>👑 Admin</h3>
        <button class="btn danger" id="endBtn">🏁 Spiel beenden & Zusammenfassung</button></div>`));
      a.querySelector('#endBtn').onclick = async (e) => {
        if (!confirm('Spiel wirklich beenden? Danach kann niemand mehr markieren.')) return;
        e.target.disabled = true;
        try { await api('POST', `/api/sessions/${code}/end`); renderSession(code); }
        catch (err) { toast(err.message); e.target.disabled = false; }
      };
    }
  }

  // Spielerliste
  const pl = box.querySelector('#players');
  s.players.forEach((p) => {
    pl.append(el(`<div class="prow">
      <span class="dot ${p.ready ? 'ready' : ''}"></span>
      <span class="nm">${esc(p.name)}</span>
      ${p.bingo ? '<span class="tag bingo">BINGO</span>' : ''}
      <span class="meta">${p.marks} ✓</span>
    </div>`));
  });

  box.querySelector('#home').onclick = () => go('/');
  box.querySelector('#editCard').onclick = () => drawJoin(code, s);

  // Beweisfotos als Hintergrund laden (nachträglich, um Markierungen zu zeigen)
  // (Fotos werden erst in der Zusammenfassung voll angezeigt; im Brett genügt der Haken.)
}

function checkBingo(card) {
  const g = 4; const mk = new Set(card.filter((c) => c.marked).map((c) => c.idx));
  const lines = [];
  for (let r = 0; r < g; r++) lines.push([...Array(g)].map((_, c) => r * g + c));
  for (let c = 0; c < g; c++) lines.push([...Array(g)].map((_, r) => r * g + c));
  lines.push([...Array(g)].map((_, i) => i * g + i));
  lines.push([...Array(g)].map((_, i) => i * g + (g - 1 - i)));
  return lines.some((l) => l.every((i) => mk.has(i)));
}

/* Markieren mit Foto */
function openMark(code, cell) {
  const m = el(`<div class="modal"><div class="sheet">
    <h3>${cell.marked ? 'Beweis ersetzen' : 'Beweis hochladen'}</h3>
    <p class="small">„${esc(cell.title)}" — mach ein Foto als Beweis.</p>
    <img class="preview" id="prev">
    <input type="file" id="file" accept="image/*" capture="environment" style="display:none">
    <button class="btn" id="pick">📷 Foto aufnehmen / wählen</button>
    <input id="note" placeholder="Kurze Notiz (optional)" maxlength="200" style="margin-top:10px">
    <button class="btn gold" id="save" style="margin-top:10px" disabled>✅ Als erledigt markieren</button>
    ${cell.marked ? '<button class="btn danger sm" id="rm" style="width:100%;margin-top:10px">Markierung entfernen</button>' : ''}
    <button class="btn ghost sm" id="cancel" style="width:100%;margin-top:10px">Abbrechen</button>
  </div></div>`);
  document.body.append(m);
  const file = m.querySelector('#file'), prev = m.querySelector('#prev'), save = m.querySelector('#save');
  let blob = null;
  const close = () => m.remove();
  m.querySelector('#cancel').onclick = close;
  m.addEventListener('click', (e) => { if (e.target === m) close(); });
  m.querySelector('#pick').onclick = () => file.click();
  file.onchange = async () => {
    if (!file.files[0]) return;
    try {
      blob = await shrink(file.files[0]);
      prev.src = URL.createObjectURL(blob); prev.style.display = 'block';
      save.disabled = false;
    } catch { toast('Foto konnte nicht geladen werden'); }
  };
  m.querySelector('#save').onclick = async (e) => {
    if (!blob) return;
    e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span> Lädt hoch…';
    const fd = new FormData();
    fd.append('idx', cell.idx);
    fd.append('note', m.querySelector('#note').value.trim());
    fd.append('photo', blob, 'beweis.jpg');
    try { await api('POST', `/api/sessions/${code}/mark`, fd, true); close(); toast('✓ Markiert!'); renderSession(code); }
    catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = '✅ Als erledigt markieren'; }
  };
  const rm = m.querySelector('#rm');
  if (rm) rm.onclick = async () => {
    try { await api('POST', `/api/sessions/${code}/unmark`, { idx: cell.idx }); close(); renderSession(code); }
    catch (err) { toast(err.message); }
  };
}

/* Zusammenfassung */
async function renderSummary(code, stateIgnored) {
  stopPoll();
  app.innerHTML = '<div class="card center"><span class="spin"></span> Zusammenfassung lädt…</div>';
  let data;
  try { data = await api('GET', `/api/sessions/${code}/summary`); }
  catch (err) { app.innerHTML = `<div class="card center"><h3>${esc(err.message)}</h3></div>`; return; }
  app.innerHTML = '';
  const winners = data.players.filter((p) => p.bingo).map((p) => p.name);
  app.append(el(`<div>
    <div class="logo">🏁</div>
    <h1 class="center">${esc(data.session.name)}</h1>
    <p class="center">Das Spiel ist beendet — hier die Beweis-Galerie.</p>
    ${winners.length ? `<div class="hint center" style="background:rgba(255,210,63,.15);border-color:#7a5a00;color:#ffd23f;font-weight:800">🏆 Bingo: ${winners.map(esc).join(', ')}</div>` : ''}
    <div id="sum"></div>
    <div class="row" style="margin-top:14px">
      <button class="btn ghost sm" id="home">← Startseite</button>
    </div>
    <div class="foot">Party-Bingo</div>
  </div>`));
  const sum = document.getElementById('sum');
  data.players.forEach((p) => {
    const card = el(`<div class="card sumcard">
      <div class="status-bar"><h3 style="margin:0">${esc(p.name)}</h3>
        <span class="badge ${p.bingo ? 'running' : 'ended'}">${p.bingo ? '🏆 BINGO' : p.marks + ' ✓'}</span></div>
      <div class="sumgrid"></div>
    </div>`);
    const g = card.querySelector('.sumgrid');
    p.cells.forEach((c) => {
      if (c.marked && c.photo) {
        g.append(el(`<div class="sumcell"><img loading="lazy" src="${c.photo}" alt="">
          <div class="cap">${esc(c.title)}${c.note ? ' — ' + esc(c.note) : ''}</div></div>`));
      } else {
        g.append(el(`<div class="sumcell no">${esc(c.title || '—')}</div>`));
      }
    });
    sum.append(card);
  });
  document.getElementById('home').onclick = () => go('/');
}

route();
