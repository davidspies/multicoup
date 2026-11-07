#!/usr/bin/env node
// Command-line client for playing Coup on a multicoup server.
// Designed for Claude Code sessions (and humans in a terminal). Requires Node 18+.
// Session state is kept in ./.coup-session.json (one player per directory).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SESSION_FILE = '.coup-session.json';
const POLL_SEC = 25;
const DEFAULT_WAIT_SEC = 300;

const USAGE = `Usage: node coup.mjs <command>
  create <server-url> <your-name>        Create a room (you become host)
  join <server-url> <ROOM> <your-name>   Join an existing room
  status                                 Show the current state and your options
  wait [seconds]                         Block until you must decide (default ${DEFAULT_WAIT_SEC}s)
  act <number>                           Make the numbered move from the last status/wait
  act '<json move>'                      Make a move given as JSON
  say <message...>                       Send a table-talk chat message
  start                                  (host) Start the next game
  settings key=value ...                 (host) responseTimeoutSec=N autoNextSec=N
  kick <player-name>                     (host) Remove a player
  leave                                  Leave the room (forfeits a game in progress)
  rules                                  Print the rules`;

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const ACTION_TEXT = {
  income: 'Income',
  foreign_aid: 'Foreign Aid',
  coup: 'Coup',
  tax: 'Tax (Duke)',
  assassinate: 'Assassinate (Assassin)',
  steal: 'Steal (Captain)',
  exchange: 'Exchange (Ambassador)',
};

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function loadSession() {
  if (!existsSync(SESSION_FILE)) die(`No ${SESSION_FILE} here. Run "create" or "join" first.`);
  return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
}
function saveSession(s) {
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

async function api(s, method, path, body) {
  const res = await fetch(`${s.server}/api/rooms/${s.code}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(s.token ? { authorization: `Bearer ${s.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) die(`Server error ${res.status}: ${data.error}`);
  return data;
}

async function enter(server, code, name) {
  server = server.replace(/\/+$/, '');
  const url = code ? `${server}/api/rooms/${code}/join` : `${server}/api/rooms`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  const data = await res.json();
  if (!res.ok) die(`Server error ${res.status}: ${data.error}`);
  const s = { server, code: data.code, playerId: data.playerId, token: data.token, name, seen: {} };
  saveSession(s);
  console.log(`Joined room ${data.code} as ${name} (${data.playerId}). Session saved to ${SESSION_FILE}.`);
  const st = await api(s, 'GET', '/state');
  print(s, st, { full: true });
  saveSession(s);
}

// ---------- rendering ----------
function nameOf(st, id) {
  return st.game?.players.find((p) => p.id === id)?.name ?? st.members.find((m) => m.id === id)?.name ?? id;
}

function situation(st) {
  const g = st.game;
  const n = (id) => nameOf(st, id);
  if (!g) return 'No game has started yet.';
  const pend = g.pending;
  const who = g.awaiting.map(n).join(', ');
  const target = pend?.target ? ` targeting ${n(pend.target)}` : '';
  switch (g.phase) {
    case 'over':
      return `Game over — ${n(g.winner)} won.`;
    case 'action':
      return `${n(g.turn)}'s turn to choose an action.`;
    case 'challenge':
      if (pend.challengeOf === 'action') {
        const blk = pend.canBlockNow.length ? ` ${pend.canBlockNow.map(n).join(', ')} may block instead; once anyone blocks, the action can no longer be challenged.` : '';
        return `${n(pend.actor)} claims ${cap(pend.claim)} for ${ACTION_TEXT[pend.action]}${target}. Waiting for ${who} to respond.${blk}`;
      }
      return `${n(pend.blocker)} claims ${cap(pend.blockRole)} to block ${n(pend.actor)}'s ${ACTION_TEXT[pend.action]}. Waiting for ${who} to decide whether to challenge the block.`;
    case 'block':
      return `${n(pend.actor)}'s ${ACTION_TEXT[pend.action]}${target} may be blocked. Waiting for ${who} to decide whether to block.`;
    case 'lose':
      return `${n(g.losing.id)} must choose a card to lose (${g.losing.reason}).`;
    case 'exchange':
      return `${n(pend.actor)} is choosing cards to keep from the Exchange.`;
    default:
      return g.phase;
  }
}

function print(s, st, { full }) {
  const g = st.game;
  const lines = [];
  lines.push(`=== Room ${st.code} · Game ${st.gameNumber || '-'}${g ? ` · Turn ${g.turnNumber}` : ''} · ${st.members.length} seated ===`);
  if (g) {
    const me = g.players.find((p) => p.id === st.you);
    if (me) {
      lines.push(`You are ${me.name} (${me.id}). Hand: ${me.hand.length ? me.hand.map(cap).join(', ') : '(none — you are out)'}. Coins: ${me.coins}.`);
    } else {
      lines.push(`You are ${s.name} (${st.you}), sitting out this game (joined mid-game). You will be dealt in next game.`);
    }
    lines.push('Players (turn order):');
    for (const p of g.players) {
      const turn = g.phase !== 'over' && p.id === g.turn ? '>' : ' ';
      const status = p.alive ? `influence ${p.influence}` : 'OUT';
      const lost = p.revealed.length ? p.revealed.map(cap).join(', ') : '-';
      lines.push(` ${turn} ${p.name.padEnd(14)} coins ${String(p.coins).padStart(2)}   ${status.padEnd(11)}  revealed: ${lost}${p.id === st.you ? '  [you]' : ''}`);
    }
    lines.push(`Court deck: ${g.deckCount} cards.`);
  } else {
    lines.push(`You are ${s.name} (${st.you}). Seated: ${st.members.map((m) => m.name).join(', ')}.`);
  }
  lines.push(`Now: ${situation(st)}`);
  if (st.responseDeadline && g && (g.phase === 'challenge' || g.phase === 'block'))
    lines.push(`(Auto-pass in ${Math.max(0, Math.round((st.responseDeadline - Date.now()) / 1000))}s.)`);

  // New log entries since last seen.
  if (g) {
    const key = String(st.gameNumber);
    const seen = full ? Math.max(0, g.log.length - 15) : (s.seen.log?.[key] ?? 0);
    const fresh = g.log.slice(seen);
    if (fresh.length) {
      lines.push(full ? 'Recent events:' : 'New events:');
      fresh.forEach((e) => lines.push(`  - ${e}`));
    }
    s.seen.log = { [key]: g.log.length };
  }
  const chatSeen = full ? (st.chat.at(-10)?.seq ?? 1) - 1 : (s.seen.chat ?? 0);
  const chat = st.chat.filter((c) => c.seq > chatSeen);
  if (chat.length) {
    lines.push('Chat:');
    chat.forEach((c) => lines.push(c.from ? `  [${c.from}] ${c.text}` : `  * ${c.text}`));
  }
  s.seen.chat = st.chat.at(-1)?.seq ?? 0;

  lines.push(`Scoreboard: ${st.members.map((m) => `${m.name} ${m.wins}/${m.played}`).join(', ')} (wins/games)`);
  if (g?.drawn) lines.push(`Exchange: you drew ${g.drawn.map(cap).join(', ')}.`);

  if (st.legal.length) {
    lines.push('');
    lines.push('YOUR DECISION — run: node coup.mjs act <number>');
    st.legal.forEach((m, i) => lines.push(`  ${i}. ${m.label}`));
  } else if (st.canStart) {
    lines.push('');
    lines.push('You are the host and no game is running: run "node coup.mjs start" when everyone is seated.');
  }
  s.lastLegal = st.legal.map(stripLabel);
  console.log(lines.join('\n'));
}

const stripLabel = ({ label, ...m }) => m;

// ---------- commands ----------
async function status() {
  const s = loadSession();
  const st = await api(s, 'GET', '/state');
  print(s, st, { full: true });
  saveSession(s);
}

async function wait(secArg) {
  const s = loadSession();
  const secs = secArg === undefined ? DEFAULT_WAIT_SEC : Number(secArg);
  if (!(secs > 0)) die('wait takes a positive number of seconds');
  const deadline = Date.now() + secs * 1000;
  let st = await api(s, 'GET', '/state');
  for (;;) {
    if (st.legal.length) {
      console.log('STATUS: YOUR_DECISION');
      break;
    }
    const over = st.game?.phase === 'over';
    if (over && s.seen.over !== st.gameNumber) {
      s.seen.over = st.gameNumber;
      console.log('STATUS: GAME_OVER');
      break;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      console.log('STATUS: STILL_WAITING (nothing for you to do yet; run wait again)');
      break;
    }
    st = await api(s, 'GET', `/state?since=${st.version}&wait=${Math.min(POLL_SEC, Math.ceil(left / 1000))}`);
  }
  print(s, st, { full: false });
  saveSession(s);
}

async function act(arg) {
  const s = loadSession();
  if (arg === undefined) die('act needs a move number or JSON');
  let move;
  if (/^\d+$/.test(arg)) {
    const st = await api(s, 'GET', '/state');
    const fresh = st.legal.map(stripLabel);
    if (JSON.stringify(fresh) !== JSON.stringify(s.lastLegal ?? [])) {
      console.log('The situation changed since you last looked. Current state:');
      print(s, st, { full: false });
      saveSession(s);
      process.exit(1);
    }
    move = fresh[Number(arg)];
    if (!move) die(`no move numbered ${arg}`);
  } else {
    move = JSON.parse(arg);
  }
  const st = await api(s, 'POST', '/act', { move });
  print(s, st, { full: false });
  saveSession(s);
}

async function settings(pairs) {
  const s = loadSession();
  const patch = {};
  for (const p of pairs) {
    const [k, v] = p.split('=');
    if (v === undefined) die(`expected key=value, got ${p}`);
    patch[k] = Number(v);
  }
  const st = await api(s, 'POST', '/settings', { settings: patch });
  console.log(`Settings now: ${JSON.stringify(st.settings)}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'create':
      if (args.length !== 2) die(USAGE);
      return enter(args[0], null, args[1]);
    case 'join':
      if (args.length !== 3) die(USAGE);
      return enter(args[0], args[1].toUpperCase(), args[2]);
    case 'status':
      return status();
    case 'wait':
      return wait(args[0]);
    case 'act':
      return act(args[0]);
    case 'say': {
      const s = loadSession();
      await api(s, 'POST', '/chat', { text: args.join(' ') });
      return console.log('Sent.');
    }
    case 'start': {
      const s = loadSession();
      const st = await api(s, 'POST', '/start', {});
      print(s, st, { full: false });
      return saveSession(s);
    }
    case 'settings':
      return settings(args);
    case 'kick': {
      const s = loadSession();
      const st = await api(s, 'GET', '/state');
      const m = st.members.find((x) => x.name.toLowerCase() === args.join(' ').toLowerCase());
      if (!m) die(`no player named ${args.join(' ')}`);
      await api(s, 'POST', '/kick', { playerId: m.id });
      return console.log(`Kicked ${m.name}.`);
    }
    case 'leave': {
      const s = loadSession();
      await api(s, 'POST', '/leave', {});
      return console.log('Left the room.');
    }
    case 'rules': {
      const s = existsSync(SESSION_FILE) ? loadSession() : die('Join a room first (rules are fetched from the server).');
      const res = await fetch(`${s.server}/RULES.md`);
      return console.log(await res.text());
    }
    default:
      die(USAGE);
  }
}

await main();
