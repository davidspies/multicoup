import { $, esc, md } from './util.js';
import * as coup from './games/coup.js';
import * as hullbreach from './games/hullbreach.js';

const RENDERERS = { coup, hullbreach };

let session = null; // {code, token, playerId}
let state = null;
let pollAbort = null;
let activeTab = 'log';
let seenChat = 0;
let busy = false;
const openDetails = new Set(); // lobby <details> that stay open across re-renders
const rulesHtml = {}; // game kind -> rendered rules

const storeKey = (code) => `multicoup:${code}`;

// ---------- API ----------
async function api(method, path, body, { token } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: method === 'GET' ? pollAbort?.signal : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error);
    err.status = res.status;
    throw err;
  }
  return data;
}
const roomApi = (method, op, body) => api(method, `/api/rooms/${session.code}/${op}`, body, { token: session.token });

async function send(op, body) {
  if (busy) return;
  busy = true;
  try {
    render(await roomApi('POST', op, body));
  } catch (e) {
    alert(e.message);
  } finally {
    busy = false;
  }
}

// Narrator endpoints answer with the public view; the long-poll picks up the change.
async function narrate(path, body) {
  try {
    await roomApi('POST', `narrator${path}`, body);
  } catch (e) {
    alert(e.message);
  }
}

// ---------- home ----------
function showHome(msg) {
  $('room').hidden = true;
  $('home').hidden = false;
  $('home-error').textContent = msg ?? '';
  const params = new URLSearchParams(location.search);
  if (params.get('room')) $('code').value = params.get('room').toUpperCase();
  $('name').value = localStorage.getItem('multicoup:name') ?? '';
  listMyRooms();
}

// Seats this browser holds, checked against the server so dead rooms drop out.
async function listMyRooms() {
  const saved = Object.keys(localStorage)
    .filter((k) => /^multicoup:[A-Z]{4}$/.test(k))
    .map((k) => JSON.parse(localStorage.getItem(k)));
  const live = [];
  for (const s of saved) {
    const res = await fetch(`/api/rooms/${s.code}/state`, { headers: { authorization: `Bearer ${s.token}` } });
    if (res.status === 403 || res.status === 404) {
      localStorage.removeItem(storeKey(s.code));
      continue;
    }
    if (!res.ok) throw new Error(`checking room ${s.code}: HTTP ${res.status}`);
    const st = await res.json();
    live.push({ s, name: st.members.find((m) => m.id === st.you).name, st });
  }
  $('my-rooms').hidden = live.length === 0;
  $('my-rooms-list').innerHTML = live
    .map(
      ({ s, name, st }) => `<li><span>${esc(st.title)} room <b>${esc(s.code)}</b> as ${esc(name)} <span class="muted">· ${st.members.length} seated${st.inProgress ? ' · game in progress' : ''}</span></span>
        <button class="primary small" data-rejoin="${esc(s.code)}">Rejoin</button></li>`,
    )
    .join('');
  $('my-rooms-list').querySelectorAll('[data-rejoin]').forEach((b) => {
    b.onclick = () => {
      session = live.find((x) => x.s.code === b.dataset.rejoin).s;
      history.replaceState(null, '', `?room=${session.code}`);
      startRoom();
    };
  });
}

async function enter(code, game) {
  const name = $('name').value.trim();
  if (!name) return ($('home-error').textContent = 'Enter your name first.');
  localStorage.setItem('multicoup:name', name);
  try {
    const r = code ? await api('POST', `/api/rooms/${code}/join`, { name }) : await api('POST', '/api/rooms', { name, game });
    session = { code: r.code, token: r.token, playerId: r.playerId };
    localStorage.setItem(storeKey(r.code), JSON.stringify(session));
    history.replaceState(null, '', `?room=${r.code}`);
    startRoom();
  } catch (e) {
    $('home-error').textContent = e.message;
  }
}

document.querySelectorAll('[data-create]').forEach((b) => (b.onclick = () => enter(null, b.dataset.create)));
$('join').onclick = () => {
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 4) return ($('home-error').textContent = 'Room codes are 4 letters.');
  const saved = localStorage.getItem(storeKey(code));
  if (saved) {
    // Already seated in this room from this browser: go back to that seat.
    session = JSON.parse(saved);
    history.replaceState(null, '', `?room=${code}`);
    return startRoom();
  }
  enter(code, null);
};

// ---------- room ----------
function startRoom() {
  $('home').hidden = true;
  $('room').hidden = false;
  $('room-code').textContent = session.code;
  state = null;
  seenChat = 0;
  poll();
}

async function poll() {
  pollAbort?.abort();
  const ctrl = new AbortController();
  pollAbort = ctrl;
  let since = null;
  let reconnecting = false;
  while (pollAbort === ctrl) {
    try {
      const q = since === null ? '' : `?since=${since}&wait=25`;
      const st = await roomApi('GET', `state${q}`);
      if (pollAbort !== ctrl) return;
      since = st.version;
      if (!state || st.version !== state.version || reconnecting) render(st);
      reconnecting = false;
    } catch (e) {
      if (pollAbort !== ctrl || e.name === 'AbortError') return;
      if (e.status === 403 || e.status === 404) {
        localStorage.removeItem(storeKey(session.code));
        pollAbort = null;
        return showHome(e.status === 403 ? 'You are no longer in that room.' : `Room ${session.code} no longer exists.`);
      }
      reconnecting = true;
      $('banner').textContent = 'Connection lost, reconnecting…';
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

$('leave').onclick = async () => {
  if (!confirm(state?.inProgress ? 'Leave the room? You will forfeit the current game.' : 'Leave the room?')) return;
  pollAbort?.abort();
  pollAbort = null;
  await roomApi('POST', 'leave', {});
  localStorage.removeItem(storeKey(session.code));
  history.replaceState(null, '', '/');
  showHome();
};
$('copy-link').onclick = async () => {
  await navigator.clipboard.writeText(`${location.origin}/?room=${session.code}`);
  $('copy-link').textContent = 'Copied!';
  setTimeout(() => ($('copy-link').textContent = 'Copy invite link'), 1500);
};
document.querySelectorAll('.tab').forEach((b) => {
  b.onclick = () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    ['log', 'chat', 'rules'].forEach((t) => ($(`tab-${t}`).hidden = t !== activeTab));
    if (activeTab === 'chat') markChatSeen();
  };
});
$('chat-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  $('chat-input').value = '';
  await send('chat', { text });
};
$('modal-close').onclick = () => ($('modal').hidden = true);
$('modal').onclick = (e) => {
  if (e.target === $('modal')) $('modal').hidden = true;
};

// ---------- rendering ----------
const nameOf = (id) => state.game?.players.find((p) => p.id === id)?.name ?? state.members.find((m) => m.id === id)?.name ?? id;

const ui = {
  get state() {
    return state;
  },
  nameOf,
  sendMove: (move) => send('act', { move }),
  send,
  rerenderDecision: () => renderDecision(),
  showModal: (html) => {
    $('modal-body').innerHTML = html;
    $('modal').hidden = false;
  },
};

function render(st) {
  state = st;
  const R = RENDERERS[st.kind];
  const g = st.game;
  $('game-title').textContent = st.title;
  document.title = `${st.title} · ${st.code}`;
  $('tab-rules').innerHTML = rulesHtml[st.kind];

  // Banner
  let s = st.situation ?? { text: `Waiting for the host to start the first game (${st.minPlayers}–${st.maxPlayers} players).` };
  if (g?.phase === 'over') {
    s = { text: `${s.text} (game ${st.gameNumber})`, sub: st.nextGameAt ? 'Next game starts shortly…' : st.canStart ? 'Start the next game when ready.' : 'Waiting for the host to start the next game.' };
  }
  const deadline = st.responseDeadline ? ` · auto-pass in <span id="countdown" data-at="${st.responseDeadline}"></span>` : '';
  $('banner').className = `banner${st.legal.length ? ' urgent' : ''}`;
  const hold = st.narrator.paused ? '⏸ Paused by the narrator. ' : st.narrator.held ? '⏸ Waiting for the narrator… ' : '';
  $('banner').innerHTML = `${esc(s.text)}${s.sub || deadline || hold ? `<div class="sub"><b>${esc(hold)}</b>${esc(s.sub ?? '')}${deadline}</div>` : ''}`;
  tick();

  if (g) R.renderTable(ui, $('table'));
  else $('table').innerHTML = '';

  const seated = g?.players.some((p) => p.id === st.you);
  $('me').hidden = !g;
  if (seated) R.renderMe(ui, $('me'));
  else if (g) $('me').innerHTML = `<div class="info muted">You joined mid-game and will be dealt in next game.</div>`;

  renderDecision();
  renderLobby();
  renderLog();
  renderChat();
}

function renderDecision() {
  const el = $('decision');
  el.hidden = state.legal.length === 0;
  if (!el.hidden) RENDERERS[state.kind].renderDecision(ui, el);
}

function renderLobby() {
  const st = state;
  const R = RENDERERS[st.kind];
  const isHost = st.hostId === st.you;
  let html = `<h3>Players (${st.members.length}/${st.maxPlayers}) · wins / games</h3><ul class="members">`;
  for (const m of st.members) {
    html += `<li><span>${esc(m.name)}${m.id === st.hostId ? ' <span class="muted">(host)</span>' : ''}${m.id === st.you ? ' <span class="muted">(you)</span>' : ''}${st.inProgress && !m.inGame ? ' <span class="muted">— next game</span>' : ''}</span>
      <span>${m.wins} / ${m.played}${isHost && m.id !== st.you ? ` <button class="small danger" data-kick="${m.id}">Kick</button>` : ''}</span></li>`;
  }
  html += `</ul>`;
  if (st.canStart) html += `<button id="start" class="primary">${st.gameNumber ? 'Start next game' : 'Start game'}</button> `;
  else if (!st.inProgress && isHost) html += `<p class="muted">Need at least ${st.minPlayers} players to start.</p>`;
  html += `<div class="settings">${R.settingsHtml(st, isHost)}`;
  html += isHost
    ? `<label>Auto-start next game (s, 0 = off)<input id="set-next" type="number" min="0" max="3600" value="${st.settings.autoNextSec}"></label>
      <button id="save-settings" class="small">Save</button></div>`
    : `<span class="muted"> · Auto-start next game: ${st.settings.autoNextSec ? `${st.settings.autoNextSec}s` : 'off'}</span></div>`;
  if (isHost) {
    const n = st.narrator;
    html += `<div class="settings"><span class="muted">Narrator:</span>
      <button class="small" id="nar-pause">${n.paused ? 'Resume' : 'Pause'}</button>
      <button class="small" id="nar-step">Step mode: ${n.stepMode ? 'on' : 'off'}</button>
      ${n.held ? '<button class="small primary" id="nar-advance">Continue</button>' : ''}</div>`;
  }
  const origin = location.origin;
  const spectator = isHost
    ? `<p class="muted">A spectator sees only public information and commentates in its own session. This prompt includes the room's narrator key, so it can also pause the game, make it wait at each decision, and see a full private recap after each game. Only share it with your narrator. Paste it into a Claude Code session that can reach <b>${esc(origin)}</b>:</p>
    <pre class="cmd">Watch my ${esc(st.title)} game and narrate until I say stop. Server: ${esc(origin)}  Room: ${esc(st.code)}  Narrator key: ${esc(st.narratorKey)}
Read ${esc(origin)}/WATCHING_AS_CLAUDE.md and follow it.</pre>`
    : `<p class="muted">A spectator sees only public information and commentates in its own session. (The host's version of this prompt also lets it pause the game.) Paste this into a Claude Code session that can reach <b>${esc(origin)}</b>:</p>
    <pre class="cmd">Watch my ${esc(st.title)} game and commentate until I say stop. Server: ${esc(origin)}  Room: ${esc(st.code)}
Read ${esc(origin)}/WATCHING_AS_CLAUDE.md and follow it.</pre>`;
  html += `<details${openDetails.has('player') ? ' open' : ''} data-key="player"><summary>Add a Claude Code player</summary>
    <p class="muted">Paste this into a Claude Code session that can reach <b>${esc(origin)}</b>:</p>
    <pre class="cmd">Join my ${esc(st.title)} game and play until I say stop. Server: ${esc(origin)}  Room: ${esc(st.code)}
Read ${esc(origin)}/PLAYING_AS_CLAUDE.md and follow it.</pre></details>
    <details${openDetails.has('spectator') ? ' open' : ''} data-key="spectator"><summary>Add a Claude Code spectator</summary>${spectator}</details>`;
  $('lobby').innerHTML = html;
  $('lobby').querySelectorAll('details[data-key]').forEach((d) => {
    d.ontoggle = () => (d.open ? openDetails.add(d.dataset.key) : openDetails.delete(d.dataset.key));
  });
  R.bindSettings(ui, $('lobby'));
  $('nar-pause')?.addEventListener('click', () => narrate('', { paused: !st.narrator.paused }));
  $('nar-step')?.addEventListener('click', () => narrate('', { stepMode: !st.narrator.stepMode }));
  $('nar-advance')?.addEventListener('click', () => narrate('/advance', {}));
  $('start')?.addEventListener('click', () => send('start', {}));
  $('save-settings')?.addEventListener('click', () => {
    const settings = { autoNextSec: Number($('set-next').value) };
    if ($('set-timeout')) settings.responseTimeoutSec = Number($('set-timeout').value);
    send('settings', { settings });
  });
  $('lobby').querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = () => confirm(`Kick ${nameOf(b.dataset.kick)}?`) && send('kick', { playerId: b.dataset.kick });
  });
}

function renderLog() {
  const el = $('tab-log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  const log = state.game?.log ?? [];
  el.innerHTML = log.map((l) => `<div>${esc(l)}</div>`).join('') || '<div class="muted">No game yet.</div>';
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function renderChat() {
  const el = $('chat-list');
  el.innerHTML = state.chat.map((c) => (c.from ? `<div><b>${esc(c.from)}:</b> ${esc(c.text)}</div>` : `<div class="sys">${esc(c.text)}</div>`)).join('');
  el.scrollTop = el.scrollHeight;
  if (activeTab === 'chat') markChatSeen();
  const unread = state.chat.filter((c) => c.seq > seenChat && c.from).length;
  $('chat-badge').hidden = unread === 0;
  $('chat-badge').textContent = unread;
}
function markChatSeen() {
  seenChat = state?.chat.at(-1)?.seq ?? 0;
  $('chat-badge').hidden = true;
}

function tick() {
  const el = document.getElementById('countdown');
  if (el) el.textContent = `${Math.max(0, Math.ceil((Number(el.dataset.at) - Date.now()) / 1000))}s`;
}
setInterval(tick, 500);

// ---------- boot ----------
for (const kind of Object.keys(RENDERERS)) {
  rulesHtml[kind] = md(await (await fetch(`/rules/${kind}.md`)).text());
  $(`rules-home-${kind}`).innerHTML = rulesHtml[kind];
}

const roomParam = new URLSearchParams(location.search).get('room')?.toUpperCase();
const saved = roomParam && localStorage.getItem(storeKey(roomParam));
if (saved) {
  session = JSON.parse(saved);
  startRoom();
} else showHome();
