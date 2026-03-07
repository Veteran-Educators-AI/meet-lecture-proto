const path = require('path');
const fs = require('fs');
const http = require('http');

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { nanoid } = require('nanoid');

const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

const app = express();

// Allow iframe embedding (Lovable embeds /session/:code in an iframe)
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(__dirname, 'uploads');
const generatedDir = path.join(publicDir, 'generated');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(generatedDir, { recursive: true });

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir));

// Multer for audio question uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = (file.originalname || '').split('.').pop() || 'webm';
    cb(null, `${Date.now()}-${nanoid(6)}.${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

/**
 * In-memory state (prototype)
 * sessions[code] = {
 *   code,
 *   createdAt,
 *   started: boolean,
 *   playing: boolean,
 *   pausedReason: null | {type:'question', questionId}
 *   playlist: [{ id, url }]
 *   currentIndex: number,
 *   questions: [{ id, kind:'text'|'audio', text?, audioUrl?, fromName, fromId, at, segmentIndex }]
 *   students: { [studentId]: { id, name, joinedAt, mutedUntil, lastQuestionAt } }
 *   repauseCooldownUntil: number
 * }
 */
const sessions = Object.create(null);

function now() { return Date.now(); }
function safeCode() {
  // 6-char upper alnum, teacher shares with students
  return nanoid(6).toUpperCase().replace(/[-_]/g, 'A');
}

function makeDefaultPlaylist() {
  // Placeholder segments; teacher can replace later
  return [
    { id: 'seg1', url: '/sample/segment1.mp3' },
    { id: 'seg2', url: '/sample/segment2.mp3' },
    { id: 'seg3', url: '/sample/segment3.mp3' },
  ];
}

function sessionConfigPath(code) {
  return path.join(__dirname, 'sessions', `${code}.json`);
}

function loadSessionConfig(code) {
  try {
    const p = sessionConfigPath(code);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {}
  return null;
}

function saveSessionConfig(code, cfg) {
  const dir = path.join(__dirname, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionConfigPath(code), JSON.stringify(cfg, null, 2));
}

function getSessionOr404(req, res) {
  const code = (req.params.code || req.body.code || '').toUpperCase();
  const s = sessions[code];
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  return { code, s };
}

function sessionPublicState(s) {
  return {
    code: s.code,
    started: s.started,
    playing: s.playing,
    currentIndex: s.currentIndex,
    playlist: s.playlist,
    pausedReason: s.pausedReason,
  };
}

async function elevenlabsFetch(url, opts = {}) {
  if (!ELEVENLABS_API_KEY) {
    const err = new Error('ELEVENLABS_API_KEY not set');
    err.code = 'no_key';
    throw err;
  }
  const res = await fetch(url, {
    ...opts,
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`ElevenLabs error ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

function splitIntoSegments(text, maxChars = 900) {
  const cleaned = (text || '').replace(/\r/g, '').trim();
  if (!cleaned) return [];

  const paragraphs = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const segs = [];
  let buf = '';

  function pushBuf() {
    const t = buf.trim();
    if (t) segs.push(t);
    buf = '';
  }

  for (const p of paragraphs) {
    if ((buf + '\n\n' + p).trim().length <= maxChars) {
      buf = buf ? (buf + '\n\n' + p) : p;
      continue;
    }

    // If paragraph itself is too big, split by sentences.
    if (p.length > maxChars) {
      pushBuf();
      const sentences = p.split(/(?<=[.!?])\s+/);
      let sBuf = '';
      for (const s of sentences) {
        if ((sBuf + ' ' + s).trim().length <= maxChars) {
          sBuf = sBuf ? (sBuf + ' ' + s) : s;
        } else {
          if (sBuf) segs.push(sBuf.trim());
          sBuf = s;
        }
      }
      if (sBuf) segs.push(sBuf.trim());
    } else {
      pushBuf();
      buf = p;
    }
  }
  pushBuf();

  return segs;
}

function broadcast(code, msg) {
  const s = sessions[code];
  if (!s || !s._clients) return;
  const payload = JSON.stringify(msg);
  for (const ws of s._clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// --- REST ---

app.get('/teacher', (req, res) => res.sendFile(path.join(publicDir, 'teacher.html')));
app.get('/student', (req, res) => res.sendFile(path.join(publicDir, 'student.html')));

// --- Session entry point (auto-creates session from saved config) ---
app.get('/session/:code', (req, res) => {
  const code = (req.params.code || '').toUpperCase();
  // Auto-create the in-memory session from disk config if it doesn't exist yet
  if (!sessions[code]) {
    const cfg = loadSessionConfig(code);
    if (!cfg) return res.status(404).send('Session not found. Check the code and try again.');
    const savedPlaylist = (cfg.playlist && cfg.playlist.length) ? cfg.playlist : makeDefaultPlaylist();
    sessions[code] = {
      code,
      createdAt: now(),
      started: false,
      playing: false,
      pausedReason: null,
      playlist: savedPlaylist,
      currentIndex: 0,
      questions: [],
      students: Object.create(null),
      repauseCooldownUntil: 0,
      config: { voiceId: cfg.voiceId || DEFAULT_ELEVENLABS_VOICE_ID, voiceName: cfg.voiceName || DEFAULT_ELEVENLABS_VOICE_NAME },
      _clients: new Set(),
    };
  }
  // Serve the student page — it will pick up the code from the URL
  res.sendFile(path.join(publicDir, 'student.html'));
});

// Default voice used when a new session is created (can be overridden per-session).
// Updated to the improved hi-fi clone.
const DEFAULT_ELEVENLABS_VOICE_ID = process.env.DEFAULT_ELEVENLABS_VOICE_ID || 'fEaWmZoTfDjFdlVUAW65';
const DEFAULT_ELEVENLABS_VOICE_NAME = process.env.DEFAULT_ELEVENLABS_VOICE_NAME || 'Gregory teach voice (mp3 hi-fi)';

// Default TTS settings (tuned for Gregory: polished + slower; chosen preset C1)
const DEFAULT_VOICE_SETTINGS = {
  stability: Number(process.env.ELEVENLABS_STABILITY ?? 0.55),
  similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY ?? 1.0),
  style: Number(process.env.ELEVENLABS_STYLE ?? 0.35),
  use_speaker_boost: String(process.env.ELEVENLABS_SPEAKER_BOOST ?? 'true') !== 'false',
};

app.post('/api/session/create', (req, res) => {
  const code = (req.body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || safeCode();
  const cfg = loadSessionConfig(code) || null;
  const effectiveCfg = (cfg && cfg.voiceId) ? cfg : { voiceId: DEFAULT_ELEVENLABS_VOICE_ID, voiceName: DEFAULT_ELEVENLABS_VOICE_NAME };
  // Load saved playlist from session config if available
  const savedPlaylist = (cfg && cfg.playlist && cfg.playlist.length) ? cfg.playlist : makeDefaultPlaylist();
  sessions[code] = {
    code,
    createdAt: now(),
    started: false,
    playing: false,
    pausedReason: null,
    playlist: savedPlaylist,
    currentIndex: 0,
    questions: [],
    students: Object.create(null),
    repauseCooldownUntil: 0,
    config: effectiveCfg,
    _clients: new Set(),
  };
  res.json({ code, config: effectiveCfg, elevenlabsConfigured: !!ELEVENLABS_API_KEY });
});

app.get('/api/session/:code/state', (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  res.json({ state: sessionPublicState(got.s) });
});

app.get('/api/session/:code/teacher', (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  const s = got.s;
  res.json({
    state: sessionPublicState(s),
    questions: s.questions.slice().reverse(),
    students: Object.values(s.students),
    config: s.config || { voiceId: '', voiceName: '' },
    elevenlabsConfigured: !!ELEVENLABS_API_KEY,
    elevenlabsModel: ELEVENLABS_MODEL,
  });
});

app.post('/api/session/:code/start', (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  const s = got.s;
  s.started = true;
  s.playing = true;
  s.pausedReason = null;
  s.currentIndex = 0;
  broadcast(got.code, { type: 'SESSION_STARTED', state: sessionPublicState(s) });
  res.json({ ok: true, state: sessionPublicState(s) });
});

app.post('/api/session/:code/pause', (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  const s = got.s;
  if (!s.started) return res.status(400).json({ error: 'not_started' });
  s.playing = false;
  s.pausedReason = { type: 'teacher' };
  broadcast(got.code, { type: 'PAUSE', state: sessionPublicState(s) });
  res.json({ ok: true });
});

app.post('/api/session/:code/resume', (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  const s = got.s;
  if (!s.started) return res.status(400).json({ error: 'not_started' });
  s.playing = true;
  s.pausedReason = null;
  broadcast(got.code, { type: 'RESUME', state: sessionPublicState(s) });
  res.json({ ok: true });
});

app.post('/api/session/:code/next', (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  const s = got.s;
  if (!s.started) return res.status(400).json({ error: 'not_started' });
  s.currentIndex = Math.min(s.currentIndex + 1, s.playlist.length - 1);
  s.playing = true;
  s.pausedReason = null;
  broadcast(got.code, { type: 'GOTO', state: sessionPublicState(s) });
  res.json({ ok: true, state: sessionPublicState(s) });
});

app.post('/api/session/:code/mute', (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  const { studentId, seconds = 300 } = req.body || {};
  const s = got.s;
  const st = s.students[studentId];
  if (!st) return res.status(404).json({ error: 'student_not_found' });
  st.mutedUntil = now() + (seconds * 1000);
  broadcast(got.code, { type: 'STUDENT_MUTED', studentId, mutedUntil: st.mutedUntil });
  res.json({ ok: true });
});

app.post('/api/session/:code/join', (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  const s = got.s;
  const name = (req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'name_required' });
  const id = nanoid(10);
  s.students[id] = { id, name, joinedAt: now(), mutedUntil: 0, lastQuestionAt: 0 };
  broadcast(got.code, { type: 'STUDENT_JOINED', student: s.students[id] });
  res.json({ ok: true, studentId: id, state: sessionPublicState(s) });
});

function canStudentAsk(s, studentId) {
  const st = s.students[studentId];
  if (!st) return { ok: false, error: 'student_not_found' };
  if (!s.started) return { ok: false, error: 'lecture_not_started' };
  if (now() < st.mutedUntil) return { ok: false, error: 'muted' };
  const cooldownMs = 60_000;
  if (now() - st.lastQuestionAt < cooldownMs) return { ok: false, error: 'cooldown' };
  return { ok: true };
}

function handleQuestionPause(code, s, questionId) {
  // Pause everyone, but avoid re-pausing multiple times within a short window.
  // If already paused, do nothing.
  if (!s.playing) return;
  s.playing = false;
  s.pausedReason = { type: 'question', questionId };
  broadcast(code, { type: 'PAUSE_FOR_QUESTION', state: sessionPublicState(s), questionId });
}

app.post('/api/session/:code/question/text', (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  const s = got.s;
  const { studentId, text } = req.body || {};
  const t = (text || '').trim().slice(0, 500);
  if (!t) return res.status(400).json({ error: 'text_required' });

  const allowed = canStudentAsk(s, studentId);
  if (!allowed.ok) return res.status(400).json({ error: allowed.error });

  s.students[studentId].lastQuestionAt = now();

  const q = {
    id: nanoid(10),
    kind: 'text',
    text: t,
    fromName: s.students[studentId].name,
    fromId: studentId,
    at: now(),
    segmentIndex: s.currentIndex,
  };
  s.questions.push(q);
  broadcast(got.code, { type: 'QUESTION', question: q });
  handleQuestionPause(got.code, s, q.id);
  res.json({ ok: true, question: q });
});

app.post('/api/session/:code/question/audio', upload.single('audio'), (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  const s = got.s;
  const studentId = req.body?.studentId;

  const allowed = canStudentAsk(s, studentId);
  if (!allowed.ok) return res.status(400).json({ error: allowed.error });
  if (!req.file) return res.status(400).json({ error: 'audio_required' });

  s.students[studentId].lastQuestionAt = now();

  const audioUrl = `/uploads/${req.file.filename}`;
  const q = {
    id: nanoid(10),
    kind: 'audio',
    audioUrl,
    fromName: s.students[studentId].name,
    fromId: studentId,
    at: now(),
    segmentIndex: s.currentIndex,
  };
  s.questions.push(q);
  broadcast(got.code, { type: 'QUESTION', question: q });
  handleQuestionPause(got.code, s, q.id);
  res.json({ ok: true, question: q });
});

// --- ElevenLabs endpoints (teacher-only in this prototype) ---
// NOTE: In production you'd add teacher auth. For local prototype, keep it on localhost.

// Create a new voice from an uploaded sample
app.post('/api/session/:code/elevenlabs/voice/create', upload.single('sample'), async (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  const s = got.s;
  if (!req.file) return res.status(400).json({ error: 'sample_required' });

  const voiceName = (req.body?.voiceName || `GregVoice-${got.code}`).trim().slice(0, 60);

  try {
    const form = new FormData();
    form.append('name', voiceName);
    form.append('description', `Auto-created for session ${got.code}`);
    form.append('files', new Blob([fs.readFileSync(req.file.path)]), req.file.originalname || 'sample.webm');

    const r = await elevenlabsFetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      body: form,
    });
    const data = await r.json();

    s.config = s.config || { voiceId: '', voiceName: '' };
    s.config.voiceId = data.voice_id;
    s.config.voiceName = voiceName;
    saveSessionConfig(got.code, s.config);

    res.json({ ok: true, voiceId: data.voice_id, voiceName });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'elevenlabs_voice_create_failed', detail: String(e.message || e) });
  }
});

// Set existing voice id (if you already have one)
app.post('/api/session/:code/elevenlabs/voice/set', (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  const s = got.s;
  const voiceId = (req.body?.voiceId || '').trim();
  const voiceName = (req.body?.voiceName || '').trim().slice(0, 60);
  if (!voiceId) return res.status(400).json({ error: 'voiceId_required' });
  s.config = s.config || { voiceId: '', voiceName: '' };
  s.config.voiceId = voiceId;
  s.config.voiceName = voiceName || s.config.voiceName || '';
  saveSessionConfig(got.code, s.config);
  res.json({ ok: true, config: s.config });
});

// Generate TTS audio segments from provided script
app.post('/api/session/:code/elevenlabs/tts/generate', async (req, res) => {
  const got = getSessionOr404(req, res);
  if (!got) return;
  const s = got.s;

  const script = (req.body?.script || '').trim();
  if (!script) return res.status(400).json({ error: 'script_required' });
  const voiceId = (s.config?.voiceId || '').trim();
  if (!voiceId) return res.status(400).json({ error: 'voice_not_set' });

  const segments = splitIntoSegments(script, 900);
  if (!segments.length) return res.status(400).json({ error: 'no_segments' });

  const outDir = path.join(generatedDir, got.code);
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const playlist = [];

    for (let i = 0; i < segments.length; i++) {
      const text = segments[i];
      const body = {
        text,
        model_id: ELEVENLABS_MODEL,
        voice_settings: DEFAULT_VOICE_SETTINGS,
      };

      const r = await elevenlabsFetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify(body),
      });

      const buf = Buffer.from(await r.arrayBuffer());
      const fname = `seg${String(i + 1).padStart(3, '0')}.mp3`;
      fs.writeFileSync(path.join(outDir, fname), buf);

      playlist.push({ id: `seg${i + 1}`, url: `/generated/${got.code}/${fname}` });
    }

    s.playlist = playlist;
    s.currentIndex = 0;
    s.started = false;
    s.playing = false;
    s.pausedReason = null;

    broadcast(got.code, { type: 'PLAYLIST_UPDATED', state: sessionPublicState(s) });

    res.json({ ok: true, count: playlist.length, playlist });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'elevenlabs_tts_failed', detail: String(e.message || e) });
  }
});

// --- WS ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = (url.searchParams.get('code') || '').toUpperCase();
  const role = url.searchParams.get('role') || 'student';

  const s = sessions[code];
  if (!s) {
    ws.send(JSON.stringify({ type: 'ERROR', error: 'session_not_found' }));
    ws.close();
    return;
  }

  s._clients.add(ws);
  ws.send(JSON.stringify({ type: 'HELLO', role, state: sessionPublicState(s) }));

  ws.on('close', () => {
    s._clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Meet Lecture Prototype running: http://localhost:${PORT}`);
  console.log(`Teacher: http://localhost:${PORT}/teacher`);
  console.log(`Student: http://localhost:${PORT}/student`);
});
