'use strict';

// itty-sockets (itty.ws) client - tiny WebSocket relay
const ittySockets = (url, options = {}) => {
  let ws, queue = [], handlers = {};
  const open = () => {
    if (ws && ws.readyState < 2) return ws;
    const fullUrl = (/^wss?:/.test(url) ? url : "wss://itty.ws/c/" + url) + (url.includes("?") ? "&" : "?") + new URLSearchParams(options);
    console.log('[Socket] Connecting to:', fullUrl);
    ws = new WebSocket(fullUrl);
    ws.onmessage = e => {
      try {
        const { type, message, ...rest } = JSON.parse(e.data);
        if (type === 'message') {
          (handlers['message'] || []).forEach(h => h({ message, ...rest }));
          (handlers['*'] || []).forEach(h => h({ type, message, ...rest }));
        }
      } catch (err) { console.warn('[Socket] Message parse error:', err); }
    };
    ws.onopen = () => {
      console.log('[Socket] Connected');
      while (queue.length) ws.send(JSON.stringify(queue.shift()));
    };
    ws.onclose = () => { console.log('[Socket] Disconnected'); ws = null; };
    ws.onerror = e => console.warn('[Socket] Error:', e);
    return ws;
  };
  const t = {
    on: (type, h) => { handlers[type] = handlers[type] || []; handlers[type].push(h); return t; },
    send: (msg, to) => {
      const e = to ? { type: "message", message: msg, to } : { type: "message", message: msg };
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(e));
      else { console.log('[Socket] Queueing message (socket not ready)'); queue.push(e); }
      return t;
    },
    close: () => { ws && ws.close(); return t; },
    open,
    get socket() { return open(); }
  };
  return t;
};

// ─────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
const roomCode = () => { const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({ length: 6 }, () => ch[Math.random() * ch.length | 0]).join(''); };
const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; };
const fmt = s => `0:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function initSocket() {
  if (socket || !room || !me) return;
  console.log('[Socket] Initializing for room:', room.code);
  socket = ittySockets('hityear-' + room.code, { as: me.name });
  socket.on('message', ({ message, alias, uid }) => {
    console.log(`[Socket] Message from ${alias || uid}:`, message);
    if (message.type === 'state') updateState(message.state);
    if (message.type === 'buzzer' && gs?.phase === 'playing' && !gs.buzzer) {
      gs = { ...gs, buzzer: message.buzzer };
      updateStatusBar(gs);
    }
  });
  socket.open();
  if (window._socketTimer) clearInterval(window._socketTimer);
  window._socketTimer = setInterval(() => socket.open(), 8000);
}

// ─────────────────────────────────────────
// THEME LOADING
// ─────────────────────────────────────────
let themeData = null, loadedThemeId = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('No se cargó: ' + src));
    document.head.appendChild(s);
  });
}

async function ensureTheme(themeId) {
  if (loadedThemeId === themeId && themeData) return;
  const cfg = HIT_THE_YEAR_THEMES.find(t => t.id === themeId);
  if (!cfg) throw new Error('Tema desconocido: ' + themeId);
  await loadScript(`data/${themeId}.js`);
  themeData = window[cfg.variable];
  loadedThemeId = themeId;
}

// ─────────────────────────────────────────
// DEEZER  (JSONP — sin CORS)
// ─────────────────────────────────────────
const deezerCache = new Map();

function deezerJsonp(deezerId) {
  return new Promise((resolve, reject) => {
    const cb = `_dz${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      cleanup(); reject(new Error('Deezer timeout'));
    }, 8000);
    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[cb] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('Deezer script error')); };
    script.src = `https://api.deezer.com/track/${deezerId}?output=jsonp&callback=${cb}`;
    document.head.appendChild(script);
  });
}

async function getDeezerInfo(deezerId) {
  if (deezerCache.has(deezerId)) return deezerCache.get(deezerId);
  try {
    const d = await deezerJsonp(deezerId);
    if (d.error) return null;
    const info = { preview: d.preview || '', cover: d.album?.cover_medium || d.album?.cover_big || '' };
    deezerCache.set(deezerId, info);
    return info;
  } catch (e) { console.warn('Deezer JSONP:', e); return null; }
}

// ─────────────────────────────────────────
// AUDIO PLAYER
// ─────────────────────────────────────────
const audio = new Audio();

audio.addEventListener('timeupdate', () => {
  const pct = audio.duration ? (audio.currentTime / audio.duration * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('audio-cur').textContent = fmt(audio.currentTime);
  if (audio.duration) document.getElementById('audio-dur').textContent = fmt(audio.duration);
});
audio.addEventListener('play', () => { document.getElementById('btn-playpause').textContent = '⏸'; setViz(true); });
audio.addEventListener('pause', () => { document.getElementById('btn-playpause').textContent = '▶'; setViz(false); });
audio.addEventListener('ended', () => { document.getElementById('btn-playpause').textContent = '↺'; setViz(false); document.getElementById('progress-fill').style.width = '100%'; });
audio.addEventListener('error', () => { document.getElementById('no-preview').classList.remove('hidden'); document.getElementById('btn-playpause').disabled = true; });

function setViz(playing) {
  ['vb1', 'vb2', 'vb3', 'vb4', 'vb5', 'vb6', 'vb7', 'vb8'].forEach(id => document.getElementById(id).classList.toggle('paused', !playing));
}

function togglePlay() {
  if (audio.ended || audio.currentTime >= audio.duration - 0.1) audio.currentTime = 0;
  audio.paused ? audio.play() : audio.pause();
}

function seekAudio(event) {
  if (!audio.duration) return;
  const rect = document.getElementById('progress-track').getBoundingClientRect();
  audio.currentTime = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * audio.duration;
}

async function loadRoundAudio(songObj) {
  audio.pause(); audio.src = '';
  const pp = document.getElementById('btn-playpause');
  pp.textContent = '▶'; pp.disabled = true;
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('audio-cur').textContent = '0:00';
  document.getElementById('audio-dur').textContent = '0:30';
  document.getElementById('no-preview').classList.add('hidden');
  setViz(false);

  const info = await getDeezerInfo(songObj.deezerId);
  if (info?.preview) {
    audio.src = info.preview;
    audio.load();
    pp.disabled = false;
  } else {
    document.getElementById('no-preview').classList.remove('hidden');
  }
}

// ─────────────────────────────────────────
// API REST  (alon.one/juegos/api)
// ─────────────────────────────────────────
const API_BASE = 'https://alon.one/juegos/api';
const GAME_ID = 9;

// BroadcastChannel: notifica otras pestañas del mismo navegador
// para actualizaciones instantáneas sin esperar el polling
const BC = new BroadcastChannel('hityear');

const API = {

  async createUser(username) {
    try {
      const r = await fetch(`${API_BASE}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email: `hy.${uuid()}@hityear.app`, password: uuid() })
      });
      const d = await r.json();
      // Acepta cualquier campo que devuelva el servidor
      return { user_id: d.user_id || d.id || d.uuid || uuid() };
    } catch (e) {
      console.warn('createUser falló, usando UUID local:', e);
      return { user_id: uuid() };
    }
  },

  async createRoom(hostId, hostName) {
    const initialState = {
      phase: 'lobby', themeId: null, audioMode: 'all',
      round: 0, totalRounds: 5, timePerTurn: 30,
      songIndices: [], currentSongIndex: 0,
      timerEnd: null, roundEndTime: null,
      answers: {}, roundScores: {}, totalScores: {},
      players: { [hostId]: { name: hostName, host: true } }
    };
    const r = await fetch(`${API_BASE}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: GAME_ID, host_id: hostId, game_state: initialState })
    });
    const d = await r.json();
    BC.postMessage({ code: d.room_code });
    return d; // { room_id, room_code, message }
  },

  async getRoom(code) {
    const r = await fetch(`${API_BASE}/rooms/${code}`);
    if (!r.ok) return null;
    const d = await r.json();
    if (d.error || d.code === 404) return null;
    // Normaliza la respuesta: el estado del juego vive en game_state
    return {
      id: d.room_id || d.id,
      code: d.room_code || code,
      state: d.game_state || {}
    };
  },

  async joinRoom(code, userId, username) {
    const r = await fetch(`${API_BASE}/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId })
    });
    if (!r.ok) throw new Error('Sala no encontrada');
    // Añadir jugador al game_state.players
    const room = await this.getRoom(code);
    if (room) {
      const st = { ...room.state };
      if (!st.players) st.players = {};
      if (!st.totalScores) st.totalScores = {};
      st.players[userId] = { name: username, host: false };
      st.totalScores[userId] = st.totalScores[userId] ?? 0;
      await this.patchState(code, st);
    }
    return { ok: true };
  },

  async patchState(code, patch) {
    // El servidor reemplaza game_state por completo, no hace merge.
    // Fusionamos el patch sobre el gs actual para no perder campos.
    const fullState = { ...(gs || {}), ...patch };
    const r = await fetch(`${API_BASE}/rooms/${code}/state`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_state: fullState })
    });
    BC.postMessage({ code }); // avisar pestañas locales
    if (socket) socket.send({ type: 'state', state: fullState }); // Broadcast via IttySockets
    return r.json();
  },

  async saveScore(userId, roomId, score, meta) {
    try {
      const r = await fetch(`${API_BASE}/scores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, game_id: GAME_ID, room_id: roomId, score_value: score, metadata: meta })
      });
      return r.json();
    } catch (e) { return { ok: false }; }
  }
};

// ─────────────────────────────────────────
// APP STATE
// ─────────────────────────────────────────
let me = null, room = null, host = false, gs = null, socket = null;
let myAnswer = null, pollId = null, timerId = null;
let lastPhase = null, lastRound = -1, roundEndQueued = false;
let activeTab = 'create', cfgAudioMode = 'all', cfgRebote = true;

// ─────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────
const show = name => { document.querySelectorAll('.screen').forEach(el => el.classList.remove('active')); document.getElementById('screen-' + name).classList.add('active'); };

function setTab(tab) {
  activeTab = tab;
  const isC = tab === 'create';
  document.getElementById('tab-create').className = `flex-1 py-2.5 text-sm font-semibold ${isC ? 'tab-active' : 'tab-inactive transition-colors'}`;
  document.getElementById('tab-join').className = `flex-1 py-2.5 text-sm font-semibold ${!isC ? 'tab-active' : 'tab-inactive transition-colors'}`;
  document.getElementById('sec-create').classList.toggle('hidden', !isC);
  document.getElementById('sec-join').classList.toggle('hidden', isC);
}

function setAudioMode(mode) {
  cfgAudioMode = mode;
  document.getElementById('am-all').className = `flex-1 py-2.5 text-xs font-semibold ${mode === 'all' ? 'tab-active' : 'tab-inactive transition-colors'} flex items-center justify-center gap-1.5`;
  document.getElementById('am-host').className = `flex-1 py-2.5 text-xs font-semibold ${mode === 'host_only' ? 'tab-active' : 'tab-inactive transition-colors'} flex items-center justify-center gap-1.5`;
  document.getElementById('audio-mode-hint').textContent = mode === 'all' ? 'Cada jugador escucha en su dispositivo' : 'Solo el dispositivo del anfitrión reproduce música';
}

function setRebote(v) {
  cfgRebote = v;
  document.getElementById('rebote-on').className = `flex-1 py-2.5 text-xs font-semibold ${v ? 'tab-active' : 'tab-inactive transition-colors'} flex items-center justify-center gap-1.5`;
  document.getElementById('rebote-off').className = `flex-1 py-2.5 text-xs font-semibold ${!v ? 'tab-active' : 'tab-inactive transition-colors'} flex items-center justify-center gap-1.5`;
  document.getElementById('rebote-hint').textContent = v ? 'Si fallas, el resto puede intentarlo (500 pts)' : 'Si fallas, la ronda termina sin puntos';
}

function showErr(msg) { const el = document.getElementById('welcome-err'); el.textContent = msg; el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 3500); }

// ─────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────
const Router = {
  push(path) { history.pushState({ path }, '', '#' + path); this._title(path); },
  replace(path) { history.replaceState({ path }, '', '#' + path); this._title(path); },
  current() { return window.location.hash.replace(/^#/, '') || '/'; },
  roomCode() { const m = this.current().match(/^\/room\/([A-Z0-9]+)$/i); return m ? m[1].toUpperCase() : null; },
  _title(path) { const m = path.match(/^\/room\/([A-Z0-9]+)$/i); document.title = m ? `HitYear — Sala ${m[1]}` : 'HitYear — Adivina el Año'; }
};

window.addEventListener('popstate', () => {
  const code = Router.roomCode();
  if (!code && room) leaveRoom();
  else if (code && !room) { setTab('join'); document.getElementById('inp-code').value = code; show('welcome'); }
});

function leaveRoom() {
  stopPoll();
  if (timerId) { clearInterval(timerId); timerId = null; }
  audio.pause(); audio.src = '';
  if (socket) { socket.close(); socket = null; }
  room = null; host = false; gs = null; lastPhase = null; lastRound = -1; roundEndQueued = false; myAnswer = null;
  Router.replace('/');
  show('welcome');
}

// ─────────────────────────────────────────
// SHARE / LINK
// ─────────────────────────────────────────
function getShareUrl() {
  const u = new URL(window.location.href);
  u.hash = `/room/${room.code}`;
  u.search = '';
  return u.toString();
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(getShareUrl());
    const btn = document.getElementById('btn-copy-link');
    btn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> Copiado';
    setTimeout(() => { btn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg> Copiar enlace'; }, 2000);
  } catch (e) { console.warn(e); }
}

async function shareRoom() {
  if (!navigator.share) return;
  try {
    await navigator.share({
      title: 'HitYear — Adivina el Año',
      text: `¡Juega conmigo en HitYear! Usa el código ${room.code} o abre el enlace.`,
      url: getShareUrl()
    });
  } catch (e) { }
}

function populateThemeSelect() {
  document.getElementById('cfg-theme').innerHTML =
    HIT_THE_YEAR_THEMES.map(t => `<option value="${t.id}" data-var="${t.variable}">${t.label}</option>`).join('');
}

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
(function init() {
  // Reutilizar usuario guardado si el nombre no cambia, para no crear uno nuevo cada sesión.
  const saved = localStorage.getItem('hy_user');
  if (saved) {
    try {
      me = JSON.parse(saved);
      document.getElementById('inp-username').value = me.name || '';
    } catch (e) { localStorage.removeItem('hy_user'); }
  }
  populateThemeSelect();

  // Show web share button if API is available
  if (navigator.share) document.getElementById('btn-webshare').classList.remove('hidden');

  // Handle invite link (#/room/CODE or legacy ?room=CODE)
  const inviteCode = Router.roomCode() || (new URLSearchParams(window.location.search).get('room'));
  if (inviteCode) {
    setTab('join');
    document.getElementById('inp-code').value = inviteCode.toUpperCase();
    Router.replace('/room/' + inviteCode.toUpperCase());
  } else {
    Router.replace('/');
  }
})();

// ─────────────────────────────────────────
// WELCOME
// ─────────────────────────────────────────
async function handleEnter() {
  const name = document.getElementById('inp-username').value.trim();
  if (!name) return showErr('Introduce tu nombre');

  const btn = document.querySelector('#screen-welcome .btn-grad');
  if (btn) { btn.disabled = true; btn.textContent = 'Conectando…'; }

  // Solo crear usuario en la API si el nombre cambió o no hay usuario guardado.
  if (!me || me.name !== name) {
    try {
      const res = await API.createUser(name);
      if (!res.user_id) throw new Error('Sin user_id');
      me = { id: res.user_id, name };
      localStorage.setItem('hy_user', JSON.stringify(me));
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
      return showErr('No se pudo crear el usuario: ' + e.message);
    }
  }

  try {
    if (activeTab === 'create') {
      const res = await API.createRoom(me.id, me.name);
      if (!res.room_code) throw new Error('Sin room_code');
      room = { id: res.room_id, code: res.room_code };
      host = true;
    } else {
      const code = document.getElementById('inp-code').value.trim().toUpperCase();
      if (!code) { if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; } return showErr('Introduce el código'); }
      const r = await API.getRoom(code);
      if (!r) { if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; } return showErr('Sala no encontrada'); }
      room = { id: r.id, code }; host = false;
      await API.joinRoom(code, me.id, me.name);
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
    return showErr(e.message || 'Error al acceder a la sala');
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
  Router.push('/room/' + room.code);
  enterLobby();
}

// ─────────────────────────────────────────
// LOBBY
// ─────────────────────────────────────────
function enterLobby() {
  show('lobby');
  // No resetear lastPhase aquí para no crear bucle cuando tick() nos llama.
  // tick() ya gestiona lastPhase antes de llamar a enterLobby.
  roundEndQueued = false; myAnswer = null;
  audio.pause(); audio.src = '';
  document.getElementById('lobby-code').textContent = room.code;
  document.getElementById('host-cfg').classList.toggle('hidden', !host);
  document.getElementById('host-actions').classList.toggle('hidden', !host);
  document.getElementById('guest-wait').classList.toggle('hidden', host);

  // IttySockets: Real-time sync
  if (!socket) {
    socket = ittySockets('hityear-' + room.code, { as: me.name });
    socket.on('message', ({ message }) => {
      if (message.type === 'state') updateState(message.state);
      if (message.type === 'buzzer' && gs?.phase === 'playing' && !gs.buzzer) {
        gs = { ...gs, buzzer: message.buzzer };
        updateStatusBar(gs);
      }
    });
    setInterval(socket.open, 5000); // Reconnection loop
  }

  if (!pollId) startPoll(); // no reiniciar si el polling ya está activo
}

function renderLobby(state) {
  const players = state.players || {};
  document.getElementById('lobby-players').innerHTML =
    Object.entries(players).map(([id, p]) => `
  <div class="flex items-center gap-3 py-2 px-3 rounded-xl glass">
    <div class="w-8 h-8 rounded-full gradient-bg flex items-center justify-center text-xs font-bold flex-shrink-0">${p.name[0].toUpperCase()}</div>
    <span class="font-medium text-sm flex-1">${p.name}</span>
    ${p.host ? '<span class="text-xs gradient-text font-semibold">HOST</span>' : ''}
    ${id === me.id ? '<span class="text-xs text-gray-500">(tú)</span>' : ''}
  </div>`).join('') || '<p class="text-gray-600 text-sm">Conectando…</p>';
}

async function startGame() {
  const sel = document.getElementById('cfg-theme');
  const themeId = sel.value;
  const totalRounds = +document.getElementById('cfg-rounds').value;
  await ensureTheme(themeId);
  const indices = shuffle(themeData.map((_, i) => i)).slice(0, totalRounds);
  const totalScores = {};
  Object.keys(gs?.players || {}).forEach(id => { totalScores[id] = 0; });
  await API.patchState(room.code, {
    phase: 'playing', themeId, audioMode: cfgAudioMode,
    round: 1, totalRounds,
    songIndices: indices, currentSongIndex: 0,
    roundEndTime: null, buzzer: null, reboteUsed: false, failedBuzzers: [],
    answers: {}, roundScores: {}, totalScores, allowRebote: cfgRebote
  });
}

// ─────────────────────────────────────────
// POLLING
// ─────────────────────────────────────────
function startPoll() {
  stopPoll();
  BC.onmessage = e => { if (e.data.code === room?.code) tick(); };
  pollId = setInterval(tick, 2500);
  tick();
}
function stopPoll() { if (pollId) { clearInterval(pollId); pollId = null; } BC.onmessage = null; }

async function tick() {
  if (!room) return;
  const r = await API.getRoom(room.code);
  if (!r) return;
  updateState(r.state);
}

async function updateState(newState) {
  if (!newState) return;
  gs = newState;
  const { phase, round } = gs;
  if (gs.themeId && gs.themeId !== loadedThemeId) {
    try { await ensureTheme(gs.themeId); } catch (e) { console.error(e); return; }
  }
  const changed = phase !== lastPhase || round !== lastRound;
  if (changed) {
    lastPhase = phase; lastRound = round; roundEndQueued = false;
    // Keep hash in sync with game phase
    if (room && Router.roomCode() !== room.code) Router.replace('/room/' + room.code);
    if (phase === 'lobby') enterLobby();   // también desde game_end: todos vuelven al lobby
    if (phase === 'playing') enterPlaying(gs);
    if (phase === 'round_end') enterRoundResult(gs);
    if (phase === 'game_end') enterGameOver(gs);
  } else {
    if (phase === 'lobby') renderLobby(gs);
    if (phase === 'playing') updateStatusBar(gs);
  }
}

// ─────────────────────────────────────────
// PLAYING
// ─────────────────────────────────────────
function enterPlaying(state) {
  myAnswer = null;
  show('playing');
  document.getElementById('p-round').textContent = state.round;
  document.getElementById('p-total').textContent = state.totalRounds;
  document.getElementById('p-room').textContent = room.code;

  // Reset buzzer UI for new round (host never has the buzzer button, but does see the decision UI)
  document.getElementById('buzzer-btn-wrap').classList.toggle('hidden', host);
  document.getElementById('host-pass-btn').classList.toggle('hidden', !host);
  document.getElementById('btn-buzzer').disabled = false;
  document.getElementById('buzzer-status').classList.add('hidden');
  document.getElementById('host-decision').classList.add('hidden');
  document.getElementById('guest-wait-decision').classList.add('hidden');
  document.getElementById('rebote-notice').classList.add('hidden');

  // Host sees song info; players don't
  const hostInfoEl = document.getElementById('host-song-info');
  if (host && themeData && state.songIndices) {
    const songObj = themeData[state.songIndices[state.currentSongIndex]];
    if (songObj) {
      document.getElementById('hs-title').textContent = songObj.title;
      document.getElementById('hs-artist').textContent = songObj.artist;
      document.getElementById('hs-year').textContent = songObj.year;
      hostInfoEl.classList.remove('hidden');
    }
  } else {
    hostInfoEl.classList.add('hidden');
  }

  const canHear = state.audioMode !== 'host_only' || host;
  document.getElementById('player-block').classList.toggle('hidden', !canHear);
  document.getElementById('host-audio-notice').classList.toggle('hidden', canHear);

  updateStatusBar(state);

  if (canHear && themeData && state.songIndices) {
    const songObj = themeData[state.songIndices[state.currentSongIndex]];
    if (songObj) loadRoundAudio(songObj);
  }
}

function updateStatusBar(state) {
  const players = state.players || {};
  const buz = state.buzzer;
  document.getElementById('status-bar').innerHTML =
    Object.entries(players).map(([id, p]) => {
      const buzzed = buz && buz.userId === id;
      return `<div class="flex flex-col items-center gap-1">
    <div class="w-8 h-8 rounded-full ${buzzed ? 'bg-yellow-400' : 'bg-white/10'} flex items-center justify-center text-xs font-bold transition-colors">${buzzed ? '🔔' : p.name[0].toUpperCase()}</div>
    <span class="text-xs ${buzzed ? 'text-yellow-300' : 'text-gray-500'}">${p.name}</span>
  </div>`;
    }).join('');

  const inRebote = state.reboteUsed && !buz;

  if (buz) {
    // Someone has buzzed — show who, host gets decision buttons
    document.getElementById('btn-buzzer').disabled = true;
    document.getElementById('buzzer-btn-wrap').classList.add('hidden');
    document.getElementById('host-pass-btn').classList.add('hidden');
    document.getElementById('rebote-notice').classList.add('hidden');
    document.getElementById('buzzer-status').classList.remove('hidden');
    document.getElementById('buzzer-name').textContent = buz.name;
    if (host) {
      document.getElementById('host-decision').classList.remove('hidden');
      document.getElementById('guest-wait-decision').classList.add('hidden');
    } else {
      document.getElementById('host-decision').classList.add('hidden');
      document.getElementById('guest-wait-decision').classList.remove('hidden');
    }
  } else if (inRebote) {
    // Rebote active: buzzer cleared, others can buzz (except who failed)
    const failed = state.failedBuzzers || [];
    document.getElementById('buzzer-status').classList.add('hidden');
    document.getElementById('host-decision').classList.add('hidden');
    document.getElementById('guest-wait-decision').classList.add('hidden');
    document.getElementById('rebote-notice').classList.remove('hidden');
    if (host) {
      document.getElementById('host-pass-btn').classList.remove('hidden');
      document.getElementById('buzzer-btn-wrap').classList.add('hidden');
    } else {
      document.getElementById('host-pass-btn').classList.add('hidden');
      const iFailed = failed.includes(me.id);
      document.getElementById('buzzer-btn-wrap').classList.toggle('hidden', iFailed);
      if (!iFailed) document.getElementById('btn-buzzer').disabled = false;
    }
  }
}

async function pressBuzzer() {
  if (host || myAnswer || gs?.buzzer || gs?.failedBuzzers?.includes(me.id)) return;
  myAnswer = true; // prevent double press
  document.getElementById('btn-buzzer').disabled = true;
  const buz = { userId: me.id, name: me.name, at: Date.now() };
  if (socket) socket.send({ type: 'buzzer', buzzer: buz });
  await API.patchState(room.code, { buzzer: buz });
}

async function hostDecide(correct) {
  const state = gs;
  const buz = state.buzzer;
  const roundScores = {}, totalScores = { ...(state.totalScores || {}) };
  Object.keys(state.players || {}).forEach(id => { roundScores[id] = 0; });

  if (correct && buz) {
    const pts = state.reboteUsed ? 500 : 1000;
    roundScores[buz.userId] = pts;
    totalScores[buz.userId] = (totalScores[buz.userId] || 0) + pts;
    API.saveScore(buz.userId, room.id, pts, { round: state.round });
    audio.pause();
    await API.patchState(room.code, { phase: 'round_end', roundScores, totalScores });
  } else if (!correct && state.allowRebote && !state.reboteUsed) {
    // Rebote: clear buzzer so others can buzz (500 pts if they get it right)
    const failedBuzzers = [...(state.failedBuzzers || []), buz.userId];
    await API.patchState(room.code, { buzzer: null, reboteUsed: true, failedBuzzers });
  } else {
    // No rebote or rebote already used — round ends with 0 pts
    audio.pause();
    await API.patchState(room.code, { phase: 'round_end', roundScores, totalScores });
  }
}

async function hostPass() {
  // Host skips the song — no points for anyone
  audio.pause();
  const roundScores = {}, totalScores = { ...(gs.totalScores || {}) };
  Object.keys(gs.players || {}).forEach(id => { roundScores[id] = 0; });
  await API.patchState(room.code, { phase: 'round_end', roundScores, totalScores });
}

// ─────────────────────────────────────────
// ROUND RESULT
// ─────────────────────────────────────────
function enterRoundResult(state) {
  audio.pause();
  show('round-result');

  const songObj = themeData[state.songIndices[state.currentSongIndex]];
  const players = state.players || {};
  const buz = state.buzzer;
  const rs = state.roundScores || {};

  document.getElementById('rr-title').textContent = songObj.title;
  document.getElementById('rr-artist').textContent = songObj.artist;
  document.getElementById('rr-year').textContent = songObj.year;

  // Cover: use Deezer cache or fallback to data file
  const cached = deezerCache.get(songObj.deezerId);
  document.getElementById('rr-cover').src = cached?.cover || songObj.cover || '';

  // Buzzer results
  const sorted = Object.entries(players).sort((a, b) => (rs[b[0]] || 0) - (rs[a[0]] || 0));
  document.getElementById('rr-answers').innerHTML = sorted.map(([id, p]) => {
    const pts = rs[id] || 0;
    const buzzed = buz && buz.userId === id;
    const correct = buzzed && pts > 0;
    return `
  <div class="flex items-center gap-3 py-2 px-3 rounded-xl glass ${id === me.id ? 'border border-purple-500/30' : ''}">
    <div class="w-7 h-7 rounded-full gradient-bg flex items-center justify-center text-xs font-bold flex-shrink-0">${p.name[0].toUpperCase()}</div>
    <span class="text-sm flex-1 font-medium">${p.name}</span>
    ${buzzed
      ? `<span class="font-bold ${correct ? 'text-green-400' : 'text-red-400'}">${correct ? (state.reboteUsed ? '🔄 Correcto' : '✓ Correcto') : '✗ Incorrecto'}</span>`
      : `<span class="text-gray-600">—</span>`}
    <span class="text-purple-400 font-bold text-sm">+${pts}</span>
  </div>`;
  }).join('') || '<p class="text-gray-500 text-sm text-center">Nadie pulsó</p>';

  // Song reveal: only host sees it (players learn verbally)
  document.getElementById('rr-song-reveal').classList.toggle('hidden', !host);

  renderBoard('rr-board', state.totalScores || {}, players);

  // Host action button
  const isLastRound = state.round >= state.totalRounds;
  document.getElementById('rr-host-action').classList.toggle('hidden', !host);
  document.getElementById('rr-guest-wait').classList.toggle('hidden', host);
  if (host) {
    const btn = document.getElementById('btn-next-round');
    btn.textContent = isLastRound ? '🏆 Ver resultados finales' : '▶ Siguiente ronda';
  }
}

async function hostAdvance() {
  const isLast = gs.round >= gs.totalRounds;
  if (isLast) {
    await API.patchState(room.code, { phase: 'game_end' });
  } else {
    await API.patchState(room.code, {
      phase: 'playing',
      round: gs.round + 1,
      currentSongIndex: gs.currentSongIndex + 1,
      roundEndTime: null,
      buzzer: null, reboteUsed: false, failedBuzzers: [], answers: {}, roundScores: {}
    });
  }
}

// ─────────────────────────────────────────
// GAME OVER
// ─────────────────────────────────────────
function enterGameOver(state) {
  audio.pause();
  // No paramos el polling: cuando el anfitrión inicie nueva partida,
  // todos los jugadores volverán automáticamente al lobby vía tick().
  show('game-over');
  const players = state.players || {};
  const scores = state.totalScores || {};
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]).map(([id, sc]) => ({ id, sc, name: players[id]?.name || '?' }));
  const medals = ['🥇', '🥈', '🥉'];
  const order = [1, 0, 2], heights = ['h-24', 'h-32', 'h-20'], opac = ['opacity-70', 'opacity-100', 'opacity-50'];
  document.getElementById('podium').innerHTML = order.map((pos, di) => {
    const p = ranked[pos]; if (!p) return '';
    return `<div class="flex flex-col items-center gap-1 flex-1 max-w-[90px]">
  ${pos === 0 ? '<div class="text-xl animate-bounce">👑</div>' : '<div class="h-7"></div>'}
  <div class="w-9 h-9 rounded-full gradient-bg flex items-center justify-center font-bold text-sm">${p.name[0].toUpperCase()}</div>
  <span class="text-xs font-semibold truncate w-full text-center">${p.name}</span>
  <span class="text-xs gradient-text font-bold">${p.sc}pts</span>
  <div class="${heights[di]} w-full gradient-bg ${opac[di]} rounded-t-xl flex items-center justify-center text-xl">${medals[pos] || ''}</div>
</div>`;
  }).join('');
  renderBoard('go-board', scores, players);
  // Mostrar botón o espera según rol
  document.getElementById('go-host-action').classList.toggle('hidden', !host);
  document.getElementById('go-guest-wait').classList.toggle('hidden', host);
}

function renderBoard(elId, scores, players) {
  const medals = ['🥇', '🥈', '🥉'];
  document.getElementById(elId).innerHTML =
    Object.entries(scores).sort((a, b) => b[1] - a[1]).map(([id, sc], i) => {
      const p = players[id];
      return `<div class="flex items-center gap-3 py-2 px-3 rounded-xl glass ${id === me.id ? 'border border-purple-500/30' : ''}">
    <span class="w-7 text-base">${medals[i] || (i + 1) + '.'}</span>
    <span class="text-sm flex-1 font-medium">${p?.name || '?'} ${id === me.id ? '<span class="text-gray-500 text-xs">(tú)</span>' : ''}</span>
    <span class="gradient-text font-bold">${sc}</span>
    <span class="text-gray-600 text-xs">pts</span>
  </div>`;
    }).join('');
}

async function playAgain() {
  if (!host) return; // los invitados esperan: el polling detectará el cambio a lobby
  // Reinicia el estado de la sala manteniendo los mismos jugadores (gs.players se
  // preserva automáticamente en patchState mediante la fusión con gs).
  await API.patchState(room.code, {
    phase: 'lobby', themeId: null, round: 0,
    buzzer: null, reboteUsed: false, failedBuzzers: [],
    answers: {}, roundScores: {}, totalScores: {},
    songIndices: [], timerEnd: null, roundEndTime: null
  });
  // tick() detectará phase='lobby' y llamará enterLobby() para todos
}

// ─────────────────────────────────────────
// KEYBOARD
// ─────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('screen-welcome').classList.contains('active')) handleEnter();
  if (e.key === ' ' && document.getElementById('screen-playing').classList.contains('active')) { e.preventDefault(); if (!gs?.buzzer) pressBuzzer(); else togglePlay(); }
});
