const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const GLYPH = { duke: '♛', assassin: '🗡', captain: '⚓', ambassador: '✉', contessa: '♕' };
const ACTION_TEXT = {
  income: 'Income',
  foreign_aid: 'Foreign Aid',
  coup: 'Coup',
  tax: 'Tax',
  assassinate: 'Assassinate',
  steal: 'Steal',
  exchange: 'Exchange',
};
const ACTION_HELP = {
  income: '+1 coin',
  foreign_aid: '+2 coins · Duke can block',
  coup: 'Pay 7 · unstoppable',
  tax: 'Duke · +3 coins',
  assassinate: 'Assassin · pay 3',
  steal: 'Captain · take 2',
  exchange: 'Ambassador · swap cards',
};

let session = null; // {code, token, playerId}
let state = null;
let pollAbort = null;
let pendingAction = null; // action awaiting a target choice
let activeTab = 'log';
let seenChat = 0;
let busy = false;
const openDetails = new Set(); // lobby <details> that stay open across re-renders

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

async function act(op, body) {
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
      ({ s, name, st }) => `<li><span>Room <b>${esc(s.code)}</b> as ${esc(name)} <span class="muted">· ${st.members.length} seated${st.inProgress ? ' · game in progress' : ''}</span></span>
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

async function enter(code) {
  const name = $('name').value.trim();
  if (!name) return ($('home-error').textContent = 'Enter your name first.');
  localStorage.setItem('multicoup:name', name);
  try {
    const r = code
      ? await api('POST', `/api/rooms/${code}/join`, { name })
      : await api('POST', '/api/rooms', { name });
    session = { code: r.code, token: r.token, playerId: r.playerId };
    localStorage.setItem(storeKey(r.code), JSON.stringify(session));
    history.replaceState(null, '', `?room=${r.code}`);
    startRoom();
  } catch (e) {
    $('home-error').textContent = e.message;
  }
}

$('create').onclick = () => enter(null);
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
  enter(code);
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
  await act('chat', { text });
};

// ---------- rendering ----------
const nameOf = (id) => state.game?.players.find((p) => p.id === id)?.name ?? state.members.find((m) => m.id === id)?.name ?? id;

function cardHtml(role, { lost = false, big = false } = {}) {
  if (!role) return `<div class="card back${big ? ' big' : ''}"></div>`;
  return `<div class="card r-${role}${lost ? ' lost' : ''}${big ? ' big' : ''}" title="${cap(role)}"><span class="glyph">${GLYPH[role]}</span>${cap(role)}</div>`;
}

function situation() {
  const g = state.game;
  if (!g) return { text: 'Waiting for the host to start the first game.' };
  const p = g.pending;
  const n = nameOf;
  const target = p?.target ? ` on ${n(p.target)}` : '';
  const who = g.awaiting.map(n).join(', ');
  switch (g.phase) {
    case 'over':
      return { text: `🏆 ${n(g.winner)} wins game ${state.gameNumber}!`, sub: state.nextGameAt ? 'Next game starts shortly…' : state.canStart ? 'Start the next game when ready.' : 'Waiting for the host to start the next game.' };
    case 'action':
      return { text: g.turn === state.you ? 'Your turn: choose an action.' : `${n(g.turn)} is choosing an action…` };
    case 'challenge':
      if (p.challengeOf === 'action')
        return {
          text: `${n(p.actor)} claims ${cap(p.claim)}: ${ACTION_TEXT[p.action]}${target}.`,
          sub: `Waiting on ${who} to ${p.canBlockNow.length ? `respond (${p.canBlockNow.map(n).join(', ')} can block)` : 'challenge or pass'}.`,
        };
      return { text: `${n(p.blocker)} blocks ${n(p.actor)}'s ${ACTION_TEXT[p.action]} with ${cap(p.blockRole)}.`, sub: `Waiting on ${who} to challenge or pass.` };
    case 'block':
      return { text: `${n(p.actor)}: ${ACTION_TEXT[p.action]}${target}.`, sub: `Waiting on ${who} to block or pass.` };
    case 'lose':
      return { text: `${n(g.losing.id)} must lose an influence (${g.losing.reason}).` };
    case 'exchange':
      return { text: `${n(p.actor)} is exchanging cards…` };
  }
}

function render(st) {
  state = st;
  pendingAction = pendingAction && st.legal.some((m) => m.action === pendingAction) ? pendingAction : null;
  const g = st.game;

  // Banner
  const s = situation();
  const myMove = st.legal.length > 0;
  let deadline = '';
  if (st.responseDeadline && g && (g.phase === 'challenge' || g.phase === 'block')) {
    deadline = ` · auto-pass in <span id="countdown" data-at="${st.responseDeadline}"></span>`;
  }
  $('banner').className = `banner${myMove ? ' urgent' : ''}`;
  const hold = st.narrator.paused ? '⏸ Paused by the narrator. ' : st.narrator.held ? '⏸ Waiting for the narrator… ' : '';
  $('banner').innerHTML = `${esc(s.text)}${s.sub || deadline || hold ? `<div class="sub"><b>${esc(hold)}</b>${esc(s.sub ?? '')}${deadline}</div>` : ''}`;
  tick();

  // Table (opponents)
  const table = $('table');
  if (g) {
    table.innerHTML = g.players
      .filter((p) => p.id !== st.you)
      .map((p) => {
        const hiddenCards = Array.from({ length: p.influence }, () => cardHtml(null)).join('');
        const lost = p.revealed.map((r) => cardHtml(r, { lost: true })).join('');
        const isTurn = g.phase !== 'over' && g.turn === p.id;
        const waiting = g.awaiting.includes(p.id) && g.phase !== 'over' ? 'deciding…' : '';
        const winner = g.winner === p.id ? ' 🏆' : '';
        return `<div class="seat${isTurn ? ' turn' : ''}${p.alive ? '' : ' out'}">
          <div class="nm">${esc(p.name)}${winner}</div>
          <div class="meta"><span class="coins">🪙 ${p.coins}</span><span>${p.alive ? `${p.influence} influence` : 'out'}</span></div>
          <div class="cards">${hiddenCards}${lost}</div>
          <div class="thinking">${waiting}</div>
        </div>`;
      })
      .join('');
  } else table.innerHTML = '';

  // Me
  const me = g?.players.find((p) => p.id === st.you);
  if (me) {
    $('me').hidden = false;
    $('me').innerHTML = `<div class="cards">${me.hand.map((r) => cardHtml(r, { big: true })).join('')}${me.revealed.map((r) => cardHtml(r, { lost: true, big: true })).join('')}</div>
      <div class="info"><div class="nm">${esc(me.name)} (you)${g.winner === me.id ? ' 🏆' : ''}</div>
      <div class="coins">🪙 ${me.coins} coins</div>
      <div class="muted">${me.alive ? (g.turn === me.id && g.phase !== 'over' ? 'Your turn' : '') : 'You are out of this game.'}</div>
      <div class="muted">Court deck: ${g.deckCount}</div></div>`;
  } else if (g) {
    $('me').hidden = false;
    $('me').innerHTML = `<div class="info muted">You joined mid-game and will be dealt in next game.</div>`;
  } else $('me').hidden = true;

  renderDecision();
  renderLobby();
  renderLog();
  renderChat();
}

function renderDecision() {
  const st = state;
  const el = $('decision');
  if (!st.legal.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const g = st.game;
  const idx = (m) => st.legal.indexOf(m);
  let html = '';
  if (g.phase === 'action') {
    html += `<h3>Choose an action</h3><div class="moves">`;
    const seen = new Set();
    for (const m of st.legal) {
      if (seen.has(m.action)) continue;
      seen.add(m.action);
      const claim = ['tax', 'assassinate', 'steal', 'exchange'].includes(m.action);
      const targeted = !!m.target;
      html += `<button class="${claim ? 'claim' : ''}${pendingAction === m.action ? ' primary' : ''}" ${targeted ? `data-pick="${m.action}"` : `data-move="${idx(m)}"`}>
        <b>${ACTION_TEXT[m.action]}</b><br><small>${ACTION_HELP[m.action]}</small></button>`;
    }
    html += `</div>`;
    if (pendingAction) {
      html += `<div class="targets"><span>${ACTION_TEXT[pendingAction]} whom?</span>`;
      for (const m of st.legal.filter((x) => x.action === pendingAction))
        html += `<button class="primary" data-move="${idx(m)}">${esc(nameOf(m.target))}</button>`;
      html += `<button data-cancel>Cancel</button></div>`;
    }
  } else {
    const titles = { challenge: 'Challenge?', block: 'Block?', lose: 'Choose a card to lose', exchange: 'Choose which cards to keep' };
    const title = st.legal.some((m) => m.type === 'block') && g.phase === 'challenge' ? 'Challenge, block, or allow?' : titles[g.phase];
    html += `<h3>${title}</h3>`;
    if (g.phase === 'exchange') html += `<p class="muted">You drew: ${g.drawn.map(cap).join(', ')}</p>`;
    html += `<div class="moves">${st.legal
      .map((m) => `<button class="${m.type === 'pass' ? '' : 'primary'}" data-move="${idx(m)}">${esc(m.label)}</button>`)
      .join('')}</div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('[data-move]').forEach((b) => {
    b.onclick = () => {
      const { label, ...move } = st.legal[Number(b.dataset.move)];
      pendingAction = null;
      act('act', { move });
    };
  });
  el.querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = () => {
      pendingAction = b.dataset.pick;
      renderDecision();
    };
  });
  el.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = () => {
      pendingAction = null;
      renderDecision();
    };
  });
}

function renderLobby() {
  const st = state;
  const isHost = st.hostId === st.you;
  let html = `<h3>Players (${st.members.length}/6) · wins / games</h3><ul class="members">`;
  for (const m of st.members) {
    html += `<li><span>${esc(m.name)}${m.id === st.hostId ? ' <span class="muted">(host)</span>' : ''}${m.id === st.you ? ' <span class="muted">(you)</span>' : ''}${st.inProgress && !m.inGame ? ' <span class="muted">— next game</span>' : ''}</span>
      <span>${m.wins} / ${m.played}${isHost && m.id !== st.you ? ` <button class="small danger" data-kick="${m.id}">Kick</button>` : ''}</span></li>`;
  }
  html += `</ul>`;
  if (st.canStart) html += `<button id="start" class="primary">${st.gameNumber ? 'Start next game' : 'Start game'}</button> `;
  else if (!st.inProgress && isHost) html += `<p class="muted">Need at least 2 players to start.</p>`;
  if (isHost) {
    html += `<div class="settings">
      <label>Challenge/block auto-pass (s, 0 = off)<input id="set-timeout" type="number" min="0" max="3600" value="${st.settings.responseTimeoutSec}"></label>
      <label>Auto-start next game (s, 0 = off)<input id="set-next" type="number" min="0" max="3600" value="${st.settings.autoNextSec}"></label>
      <button id="save-settings" class="small">Save</button></div>`;
  } else {
    html += `<p class="muted">Auto-pass: ${st.settings.responseTimeoutSec ? `${st.settings.responseTimeoutSec}s` : 'off'} · Auto-start next game: ${st.settings.autoNextSec ? `${st.settings.autoNextSec}s` : 'off'}</p>`;
  }
  if (isHost) {
    const n = st.narrator;
    html += `<div class="settings"><span class="muted">Narrator:</span>
      <button class="small" id="nar-pause">${n.paused ? 'Resume' : 'Pause'}</button>
      <button class="small" id="nar-step">Step mode: ${n.stepMode ? 'on' : 'off'}</button>
      ${n.held ? '<button class="small primary" id="nar-advance">Continue</button>' : ''}</div>`;
  }
  const origin = location.origin;
  const spectator = isHost
    ? `<p class="muted">A spectator sees only public information and commentates in its own session. This prompt includes the room's narrator key, so it can also pause the game or make it wait at each decision. Only share it with your narrator. Paste it into a Claude Code session that can reach <b>${esc(origin)}</b>:</p>
    <pre class="cmd">Watch my Coup game and narrate until I say stop. Server: ${esc(origin)}  Room: ${esc(st.code)}  Narrator key: ${esc(st.narratorKey)}
Read ${esc(origin)}/WATCHING_AS_CLAUDE.md and follow it.</pre>`
    : `<p class="muted">A spectator sees only public information and commentates in its own session. (The host's version of this prompt also lets it pause the game.) Paste this into a Claude Code session that can reach <b>${esc(origin)}</b>:</p>
    <pre class="cmd">Watch my Coup game and commentate until I say stop. Server: ${esc(origin)}  Room: ${esc(st.code)}
Read ${esc(origin)}/WATCHING_AS_CLAUDE.md and follow it.</pre>`;
  html += `<details${openDetails.has('player') ? ' open' : ''} data-key="player"><summary>Add a Claude Code player</summary>
    <p class="muted">Paste this into a Claude Code session that can reach <b>${esc(origin)}</b>:</p>
    <pre class="cmd">Join my Coup game and play until I say stop. Server: ${esc(origin)}  Room: ${esc(st.code)}
Read ${esc(origin)}/PLAYING_AS_CLAUDE.md and follow it.</pre></details>
    <details${openDetails.has('spectator') ? ' open' : ''} data-key="spectator"><summary>Add a Claude Code spectator</summary>${spectator}</details>`;
  $('lobby').innerHTML = html;
  $('lobby').querySelectorAll('details[data-key]').forEach((d) => {
    d.ontoggle = () => (d.open ? openDetails.add(d.dataset.key) : openDetails.delete(d.dataset.key));
  });
  $('nar-pause')?.addEventListener('click', () => narrate('', { paused: !st.narrator.paused }));
  $('nar-step')?.addEventListener('click', () => narrate('', { stepMode: !st.narrator.stepMode }));
  $('nar-advance')?.addEventListener('click', () => narrate('/advance', {}));
  $('start')?.addEventListener('click', () => act('start', {}));
  $('save-settings')?.addEventListener('click', () =>
    act('settings', { settings: { responseTimeoutSec: Number($('set-timeout').value), autoNextSec: Number($('set-next').value) } }),
  );
  $('lobby').querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = () => confirm(`Kick ${nameOf(b.dataset.kick)}?`) && act('kick', { playerId: b.dataset.kick });
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

// Minimal markdown for RULES.md: headings, lists, tables, bold, paragraphs.
function md(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
      out.push(`<table><tr>${cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${rows
        .slice(2)
        .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('')}</table>`);
    } else if (l.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2));
      i--;
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
    } else if (/^\d+\. /.test(l)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) items.push(lines[i++].replace(/^\d+\. /, ''));
      i--;
      out.push(`<ol>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ol>`);
    } else if (l.startsWith('#')) {
      const level = l.match(/^#+/)[0].length;
      out.push(`<h${level + 2}>${inline(l.replace(/^#+\s*/, ''))}</h${level + 2}>`);
    } else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join('');
}

// ---------- boot ----------
const rulesHtml = md(await (await fetch('/RULES.md')).text());
$('rules-home').innerHTML = rulesHtml;
$('tab-rules').innerHTML = rulesHtml;

const roomParam = new URLSearchParams(location.search).get('room')?.toUpperCase();
const saved = roomParam && localStorage.getItem(storeKey(roomParam));
if (saved) {
  session = JSON.parse(saved);
  startRoom();
} else showHome();
