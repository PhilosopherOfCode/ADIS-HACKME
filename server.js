require('dotenv').config();
const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const E = process.env, PORT = E.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'data', 'event-state.json');
const PUZZLE_FILE = path.join(__dirname, 'data', 'puzzle.json');
const { SESSION_SECRET, ADMIN_PASSWORD, FINAL_CODE } = E;
if (!SESSION_SECRET || !ADMIN_PASSWORD || !FINAL_CODE) { console.error('Set SESSION_SECRET, ADMIN_PASSWORD and FINAL_CODE.'); process.exit(1); }

const PX_MAX = 10; // proximity checks per player
const EXPORT_FILE = path.join(__dirname, 'data', 'statistics.csv');
// ---- state (memory + JSON file) ----
let S = { status: 'waiting', accum: 0, since: null, board: false, solvers: [], startAt: null, users: {}, identities: {}, hints: [], bestByClass: {}, playerGuesses: {}, pxUsedByPlayer: {}, endReason: null };
try { Object.assign(S, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch {}
delete S.claims; // legacy class claims are no longer used
if (!Array.isArray(S.hints)) S.hints = [];
if (!Array.isArray(S.solvers)) S.solvers = [];
if (!Array.isArray(S.guessWaterfall)) S.guessWaterfall = [];
for (const key of ['bestByClass', 'playerGuesses', 'pxUsedByPlayer', 'users', 'identities']) if (!S[key] || typeof S[key] !== 'object' || Array.isArray(S[key])) S[key] = {};
for (const [cls, g] of Object.entries(S.bestByClass)) if (!g || g.cls !== cls || !Number.isFinite(g.score) || !Number.isFinite(g.ms)) delete S.bestByClass[cls];
for (const g of S.guessWaterfall) if (g && typeof g.cls === 'string' && Number.isFinite(g.score) && Number.isFinite(g.ms) && (!S.bestByClass[g.cls] || g.score > S.bestByClass[g.cls].score)) S.bestByClass[g.cls] = g;
const save = () => { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(S)); } catch (e) { console.error('persist failed', e.message); } writeExport(); };
const elapsed = () => S.accum + (S.status === 'running' ? Date.now() - S.since : 0);
const released = (pid, admin) => S.hints
  .map((h, i) => ({ id: h.id || String(i + 1), n: i + 1, text: h.text, target: h.target || 'all' }))
  .filter(h => admin || h.target === 'all' || h.target === classOf(pid));

const pc = new Map(), ac = new Set();
const clsCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
// Winners sorted by class (9A..12G), fastest time since sign-in first within a class.
function winners() {
  const rows = S.solvers.map((x, i) => ({ username: x.username || '', cls: x.cls, ms: x.ms, since: Number.isFinite(x.sinceLoginMs) ? x.sinceLoginMs : x.ms, at: x.at, eventRank: i + 1 }));
  const overall = rows.reduce((a, b) => (!a || b.since < a.since ? b : a), null);
  rows.sort((a, b) => clsCmp(a.cls, b.cls) || a.since - b.since || a.eventRank - b.eventRank);
  const seen = {};
  for (const r of rows) { r.classRank = seen[r.cls] = (seen[r.cls] || 0) + 1; r.fastestInClass = r.classRank === 1; r.fastestOverall = r === overall; }
  return rows;
}
function rankedGuesses() {
  const best = new Map(Object.entries(S.bestByClass || {}));
  for (const solver of S.solvers) if (!(best.get(solver.cls) || {}).solved) best.set(solver.cls, { ...best.get(solver.cls), cls: solver.cls, guess: 'SOLVED', score: 100, tier: 'SOLVED', solved: true, ms: solver.ms, at: solver.at });
  return [...best.values()].sort((a, b) => b.score - a.score || Number(b.solved) - Number(a.solved) || a.ms - b.ms);
}
function snap(admin, pid) {
  const el = elapsed(), hs = released(pid, admin), ranked = rankedGuesses();
  const solvedRows = ranked.filter(x => x.solved), guessRows = ranked.filter(x => !x.solved).slice(0, Math.max(0, 6 - solvedRows.length));
  const s = { status: S.status, elapsedMs: el, hints: hs,
    players: pc.size, startAt: S.status === 'waiting' ? S.startAt : null, untilStartMs: S.status === 'waiting' && S.startAt ? Math.max(0, S.startAt - Date.now()) : null, first: S.solvers.length ? S.solvers[0].ms : null, firstCls: S.solvers.length ? S.solvers[0].cls : null, board: (S.board || S.status === 'ended') ? S.solvers.map((x, i) => ({ rank: i + 1, cls: x.cls, username: x.username || '', ms: x.ms, at: x.at })) : null,
    proximityBoard: [...solvedRows, ...guessRows].map((x, i) => ({ rank: i + 1, cls: x.cls, score: x.score, tier: x.tier, solved: !!x.solved, ms: x.solved ? x.ms : null })),
    revealedPassword: S.status === 'ended' ? FINAL_CODE : null };
  if (admin) {
    const recent = [...(S.guessWaterfall || [])].slice(-10).reverse();
    const overallBest = ranked[0] || null;
    const pings = [...telemetry.values()].filter(x => Date.now() - x.seen < 30000);
    const pingVals = pings.map(x => x.ping).filter(Number.isFinite);
    Object.assign(s, { solvers: winners(), roster: Object.values(S.identities).map(x => ({ username: x.username, cls: x.cls })).sort((a, b) => clsCmp(a.cls, b.cls) || a.username.localeCompare(b.username)), boardEnabled: S.board, hintsReleased: hs.length,
      hints: hs, closestGuess: overallBest, bestGuesses: ranked.slice(0, 10), waterfall: recent,
      network: { online: pings.length, avgPing: pingVals.length ? Math.round(pingVals.reduce((a, b) => a + b, 0) / pingVals.length) : null, maxPing: pingVals.length ? Math.max(...pingVals) : null } });
  }
  return s;
}
const send = (r, d) => r.write(`event: state\ndata: ${JSON.stringify(d)}\n\n`);
const broadcast = () => { pc.forEach((pid, r) => send(r, snap(false, pid))); const a = snap(true); ac.forEach(r => send(r, a)); };
setInterval(() => {
  if (S.status === 'waiting' && S.startAt && Date.now() >= S.startAt) { Object.assign(S, { status: 'running', accum: 0, since: Date.now(), startAt: null, endReason: null }); save(); } // scheduled start
  broadcast();
}, 1000);
function sse(req, res, set) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  if (set === pc) set.set(res, req.pid); else set.add(res);
  req.on('close', () => { set.delete(res); broadcast(); });
  send(res, snap(set === ac, req.pid)); if (set === pc) broadcast();
}

const eq = (a, b) => { const h = x => crypto.createHash('sha256').update(String(x)).digest(); return crypto.timingSafeEqual(h(a), h(b)); };

// ---- app ----
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: {
  'upgrade-insecure-requests': null,
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
  connectSrc: ["'self'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']
} } }));
app.use(express.json({ limit: '2kb' }));
app.use(cookieParser(SESSION_SECRET));
const ck = { httpOnly: true, signed: true, sameSite: 'strict', secure: E.COOKIE_SECURE === 'true' };

app.use('/api', (req, res, next) => {
  let p = req.signedCookies.pid;
  if (!p) { p = crypto.randomBytes(12).toString('hex'); res.cookie('pid', p, { ...ck, maxAge: 3 * 864e5 }); }
  req.pid = p; next();
});

app.get('/api/event', (req, res) => { const me = meOf(req.pid); res.json({ ...snap(false, req.pid), solved: !!me && S.solvers.some(x => x.key === me.key) }); });
app.get('/api/stream', (req, res) => sse(req, res, pc));
app.get('/api/puzzle', (req, res) => {
  if (S.status === 'waiting') return res.status(403).json({ error: 'EVENT NOT STARTED' });
  try { res.json(JSON.parse(fs.readFileSync(PUZZLE_FILE, 'utf8'))); } catch { res.status(500).json({ error: 'PUZZLE UNAVAILABLE' }); }
});

const CLASS_RE = /^(?:9[A-G]|10[A-H]|1[12][A-G])$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,19}$/;
const meOf = p => S.identities[S.users[p]] || null;
const classOf = p => (meOf(p) || {}).cls || null;
const guesses = new Map(Object.entries(S.playerGuesses).map(([pid, gs]) => [pid, Array.isArray(gs) ? gs : []]));
const pxUsed = new Map(Object.entries(S.pxUsedByPlayer).map(([pid, n]) => [pid, Number.isInteger(n) && n >= 0 ? n : 0]));
const telemetry = new Map(); // per player: network stats

// Closeness of a guess to FINAL_CODE, 0-100. Works for ANY password: it only compares characters.
// 60% "coverage" = share of the password found in the guess as shared chunks (2+ chars, each char used once)
// 40% edit-distance similarity (Levenshtein). Password matching is case-sensitive.
function lev(a, b) {
  let p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return p[b.length];
}
function cover(a, b) {
  const g = [...a], p = [...b]; let tot = 0;
  for (;;) {
    let best = 0, bi = 0, bj = 0;
    for (let i = 0; i < g.length; i++) for (let j = 0; j < p.length; j++) {
      let k = 0;
      while (i + k < g.length && j + k < p.length && g[i + k] !== null && g[i + k] === p[j + k]) k++;
      if (k > best) { best = k; bi = i; bj = j; }
    }
    if (best < 2) return tot;
    for (let k = 0; k < best; k++) { g[bi + k] = null; p[bj + k] = null; }
    tot += best;
  }
}
const score = guess => {
  const a = guess, b = FINAL_CODE;
  return Math.round(100 * (0.6 * Math.min(1, cover(a, b) / b.length) + 0.4 * Math.max(0, 1 - lev(a, b) / Math.max(a.length, b.length))));
};
const tier = s => s >= 70 ? 'HOT' : s >= 35 ? 'WARM' : 'COLD';
const subLimit = rateLimit({ windowMs: 60e3, limit: 30, keyGenerator: req => req.pid, standardHeaders: true, legacyHeaders: false, message: { error: 'TOO MANY REQUESTS' } });
app.post('/api/submit', subLimit, (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !code.trim() || code.length > 100) return res.status(400).json({ error: 'INVALID INPUT' });
  const me = meOf(req.pid);
  if (!me) return res.status(400).json({ error: 'SIGN IN FIRST' });
  const cls = me.cls;
  if (S.status !== 'running') return res.status(403).json({ error: 'EVENT NOT ACTIVE' });
  if (S.solvers.some(x => x.key === me.key)) return res.status(409).json({ error: 'ALREADY SOLVED' });
  if (eq(code.trim(), FINAL_CODE)) {
    const ms = elapsed(), sinceLoginMs = Math.max(0, ms - (me.joinMs || 0));
    S.solvers.push({ key: me.key, username: me.username, cls, ms, sinceLoginMs, at: new Date().toISOString() });
    save(); broadcast();
    return res.json({ ok: true, ms, sinceLoginMs, rank: S.solvers.length });
  }
  me.guesses = (me.guesses || 0) + 1;
  const gs = guesses.get(req.pid) || []; gs.push({ g: code.trim(), s: score(code.trim()) }); guesses.set(req.pid, gs.slice(-200));
  const sc = score(code.trim());
  me.best = Math.max(me.best || 0, sc);
  const ms = elapsed(), at = new Date().toISOString(), previous = S.bestByClass[cls];
  if (!previous || sc > previous.score) S.bestByClass[cls] = { cls, guess: code.trim(), score: sc, tier: tier(sc), ms, at };
  if (!Array.isArray(S.guessWaterfall)) S.guessWaterfall = [];
  S.playerGuesses[req.pid] = guesses.get(req.pid);
  S.guessWaterfall.push({ cls, username: me.username, guess: code.trim(), score: sc, tier: tier(sc), ms, at });
  if (S.guessWaterfall.length > 500) S.guessWaterfall.splice(0, S.guessWaterfall.length - 500);
  save();
  broadcast();
  res.status(401).json({ error: 'ACCESS DENIED' });
});

app.post('/api/ping', subLimit, (req, res) => {
  const cls = classOf(req.pid), ping = Number(req.body && req.body.ping);
  if (!cls || !Number.isFinite(ping) || ping < 0 || ping > 60000) return res.status(400).json({ error: 'INVALID PING' });
  const old = telemetry.get(req.pid), samples = [...(old ? old.samples : []), Math.round(ping)].slice(-10);
  telemetry.set(req.pid, { cls, ping: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length), samples, seen: Date.now() });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => { const me = meOf(req.pid); res.json({ mine: me ? me.cls : null, username: me ? me.username : null }); });
// Sign in with a username and class. Classes are not exclusive; the same username + class resumes the same player.
app.post('/api/login', subLimit, (req, res) => {
  const { cls: c } = req.body || {}, username = typeof (req.body && req.body.username) === 'string' ? req.body.username.trim().replace(/\s+/g, ' ') : '';
  if (!NAME_RE.test(username)) return res.status(400).json({ error: 'INVALID USERNAME' });
  if (typeof c !== 'string' || !CLASS_RE.test(c)) return res.status(400).json({ error: 'INVALID CLASS' });
  const key = `${c}:${username.toLowerCase()}`;
  S.identities[key] ||= { key, username, cls: c, joinMs: elapsed(), joinedAt: new Date().toISOString(), guesses: 0, best: 0 };
  S.users[req.pid] = key; save(); broadcast();
  res.json({ ok: true, cls: c, username: S.identities[key].username });
});
app.post('/api/logout', (req, res) => { delete S.users[req.pid]; telemetry.delete(req.pid); save(); broadcast(); res.json({ ok: true }); });
// On request, a player sees the proximity of their latest wrong guess (PX_MAX requests each).
app.post('/api/proximity', subLimit, (req, res) => {
  if (S.status !== 'running') return res.status(403).json({ error: 'EVENT NOT ACTIVE' });
  const gs = guesses.get(req.pid) || [], n = pxUsed.get(req.pid) || 0;
  if (!gs.length) return res.status(400).json({ error: 'SUBMIT A GUESS FIRST' });
  if (n >= PX_MAX) return res.status(403).json({ error: 'NO PROXIMITY CHECKS LEFT', checksLeft: 0 });
  pxUsed.set(req.pid, n + 1);
  S.pxUsedByPlayer[req.pid] = n + 1; save();
  const hot = gs.reduce((a, b) => b.s > a.s ? b : a), cold = gs.reduce((a, b) => b.s < a.s ? b : a), latest = gs[gs.length - 1], o = x => ({ guess: x.g, tier: tier(x.s), score: x.s });
  res.json({ latest: o(latest), hot: o(hot), cold: o(cold), checksLeft: PX_MAX - 1 - n });
});

// ---- admin ----
const sessions = new Map();
const isAdmin = req => { const t = req.signedCookies.adm, x = t && sessions.get(t); return !!x && x > Date.now(); };
const need = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'UNAUTHORIZED' });
const loginLimit = rateLimit({ windowMs: 15 * 60e3, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'TOO MANY ATTEMPTS' } });
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));
app.post('/api/admin/login', loginLimit, (req, res) => {
  const pw = req.body && req.body.password;
  if (typeof pw !== 'string' || pw.length > 200 || !eq(pw, ADMIN_PASSWORD)) return res.status(401).json({ error: 'DENIED' });
  const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, Date.now() + 8 * 3600e3);
  res.cookie('adm', t, { ...ck, maxAge: 8 * 3600e3 }).json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { sessions.delete(req.signedCookies.adm); res.clearCookie('adm').json({ ok: true }); });
app.get('/api/admin/me', need, (req, res) => res.json({ ok: true }));
app.get('/api/admin/state', need, (req, res) => res.json(snap(true)));
app.get('/api/admin/stream', need, (req, res) => sse(req, res, ac));
app.post('/api/admin/action', need, (req, res) => {
  const a = req.body && req.body.action, now = Date.now();
  if (a === 'start' && S.status === 'waiting') Object.assign(S, { status: 'running', accum: 0, since: now, startAt: null, endReason: null });
  else if (a === 'pause' && S.status === 'running') Object.assign(S, { accum: elapsed(), since: null, status: 'paused' });
  else if (a === 'resume' && S.status === 'paused') Object.assign(S, { status: 'running', since: now });
  else if (a === 'end' && (S.status === 'running' || S.status === 'paused')) Object.assign(S, { accum: elapsed(), since: null, status: 'ended', endReason: 'admin' });
  else if (a === 'reset') { Object.assign(S, { status: 'waiting', accum: 0, since: null, solvers: [], startAt: null, users: {}, identities: {}, hints: [], guessWaterfall: [], bestByClass: {}, playerGuesses: {}, pxUsedByPlayer: {}, endReason: null }); guesses.clear(); pxUsed.clear(); telemetry.clear(); }
  else return res.status(400).json({ error: 'INVALID ACTION' });
  save(); broadcast(); res.json({ ok: true });
});
app.post('/api/admin/config', need, (req, res) => {
  const { board, startAt } = req.body || {};
  if (startAt !== undefined) {
    if (S.status !== 'waiting') return res.status(400).json({ error: 'EVENT ALREADY STARTED' });
    if (startAt === null) S.startAt = null;
    else if (Number.isFinite(startAt) && startAt > Date.now()) S.startAt = Math.floor(startAt);
    else return res.status(400).json({ error: 'PICK A FUTURE TIME' });
  }
  if (board !== undefined) S.board = board === true;
  save(); broadcast(); res.json({ ok: true });
});

// ---- statistics export: kept up to date on disk, only downloadable by an admin ----
const csvCell = v => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const fmtMs = ms => { if (!Number.isFinite(ms)) return ''; const t = Math.floor(ms / 10), cs = t % 100, s = Math.floor(t / 100); return [s / 3600 | 0, (s / 60) % 60 | 0, s % 60].map(n => String(n).padStart(2, '0')).join(':') + '.' + String(cs).padStart(2, '0'); };
const gstStamp = t => new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' GST';
function buildCsv() {
  const a = snap(true), rows = [], sec = (title, head, data) => { rows.push([title], head, ...(data.length ? data : [['(none)']]), []); };
  const net = a.network;
  sec('EVENT', ['FIELD', 'VALUE'], [['Exported at', gstStamp(Date.now())], ['Status', a.status.toUpperCase()], ['Elapsed', fmtMs(a.elapsedMs)], ['Players online', a.players], ['Messages released', a.hintsReleased], ['Public leaderboard', a.boardEnabled ? 'on' : 'off'], ['Scheduled start', S.startAt ? gstStamp(S.startAt) : 'Not scheduled'], ['Winners', S.solvers.length]]);
  sec('NETWORK STATISTICS', ['PLAYERS REPORTING', 'AVERAGE PING (ms)', 'HIGHEST PING (ms)'], [[net.online, net.avgPing ?? '', net.maxPing ?? '']]);
  const fo = a.solvers.find(x => x.fastestOverall);
  sec('FASTEST OVERALL (time since sign-in)', ['USERNAME', 'CLASS', 'TIME SINCE SIGN-IN', 'EVENT TIME'], fo ? [[fo.username, fo.cls, fmtMs(fo.since), fmtMs(fo.ms)]] : []);
  sec('FASTEST PER CLASS (time since sign-in)', ['CLASS', 'USERNAME', 'TIME SINCE SIGN-IN', 'EVENT TIME'], a.solvers.filter(x => x.fastestInClass).map(x => [x.cls, x.username, fmtMs(x.since), fmtMs(x.ms)]));
  sec('WINNERS (by class, fastest since sign-in first)', ['CLASS', 'CLASS RANK', 'USERNAME', 'TIME SINCE SIGN-IN', 'EVENT TIME', 'SOLVED AT', 'EVENT FINISH ORDER', 'FLAGS'], a.solvers.map(x => [x.cls, x.classRank, x.username, fmtMs(x.since), fmtMs(x.ms), gstStamp(x.at), x.eventRank, [x.fastestOverall && 'FASTEST OVERALL', x.fastestInClass && 'FASTEST IN CLASS'].filter(Boolean).join(' / ')]));
  const solvedKeys = new Set(S.solvers.map(x => x.key));
  sec('SIGNED-IN PLAYERS', ['CLASS', 'USERNAME', 'SIGNED IN AT', 'GUESSES', 'BEST SCORE (%)', 'SOLVED'], Object.values(S.identities).sort((x, y) => clsCmp(x.cls, y.cls) || x.username.localeCompare(y.username)).map(x => [x.cls, x.username, gstStamp(x.joinedAt), x.guesses || 0, x.best || 0, solvedKeys.has(x.key) ? 'yes' : 'no']));
  const cg = a.closestGuess;
  sec('CLOSEST GUESS SO FAR', ['CLASS', 'GUESS', 'TIER', 'SCORE (%)', 'ELAPSED'], cg ? [[cg.cls, cg.guess, cg.tier, cg.score, fmtMs(cg.ms)]] : []);
  sec('TOP 10 BY CLASS', ['CLASS', 'GUESS', 'TIER', 'SCORE (%)', 'ELAPSED'], a.bestGuesses.map(x => [x.cls, x.guess, x.tier, x.score, fmtMs(x.ms)]));
  sec('MESSAGES / HINTS', ['AT', 'TARGET', 'TEXT'], S.hints.map(h => [h.at ? gstStamp(h.at) : '', h.target || 'all', h.text]));
  sec('GUESS HISTORY (latest 500, newest first)', ['AT', 'CLASS', 'USERNAME', 'GUESS', 'TIER', 'SCORE (%)', 'ELAPSED'], [...S.guessWaterfall].reverse().map(x => [gstStamp(x.at), x.cls, x.username || '', x.guess, x.tier, x.score, fmtMs(x.ms)]));
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function writeExport() { try { fs.mkdirSync(path.dirname(EXPORT_FILE), { recursive: true }); fs.writeFileSync(EXPORT_FILE, buildCsv()); } catch (e) { console.error('export failed', e.message); } }
setInterval(writeExport, 5000); writeExport();
app.get('/api/admin/export', need, (req, res) => {
  writeExport();
  res.set('Cache-Control', 'no-store');
  res.download(EXPORT_FILE, 'passtrace-statistics.csv', err => { if (err && !res.headersSent) res.status(500).json({ error: 'EXPORT UNAVAILABLE' }); });
});

app.post('/api/admin/message', need, (req, res) => {
  const text = typeof (req.body && req.body.text) === 'string' ? req.body.text.trim() : '';
  const targetRaw = typeof (req.body && req.body.target) === 'string' ? req.body.target.trim().toUpperCase() : 'ALL';
  const target = !targetRaw || targetRaw === 'ALL' ? 'all' : targetRaw;
  if (!text || text.length > 500) return res.status(400).json({ error: 'MESSAGE MUST BE 1–500 CHARACTERS' });
  if (target !== 'all' && !CLASS_RE.test(target)) return res.status(400).json({ error: 'ENTER ALL OR A VALID CLASS' });
  if (S.hints.length >= 100) return res.status(400).json({ error: 'MESSAGE LIMIT REACHED; RESET THE EVENT TO CLEAR MESSAGES' });
  S.hints.push({ id: crypto.randomBytes(8).toString('hex'), text, target, at: new Date().toISOString() });
  save(); broadcast(); res.json({ ok: true, n: S.hints.length });
});

// ---- static files: each public directory has its own root ----
const staticOptions = { dotfiles: 'ignore', setHeaders: (res, f) => { if (/[\\/]assets[\\/]/.test(f)) res.set('Cache-Control', 'public, max-age=3600'); } };
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/css', express.static(path.join(__dirname, 'css'), staticOptions));
app.use('/js', express.static(path.join(__dirname, 'js'), staticOptions));
app.use('/assets', (req, res, next) => {
  if (S.status === 'waiting') return res.status(403).end();
  next();
}, express.static(path.join(__dirname, 'assets'), staticOptions));
app.use((req, res) => res.status(404).end());

app.listen(PORT, () => console.log(`PassTrace listening on :${PORT}`));
