#!/usr/bin/env node
// Command-line client for playing on a multicoup server (Coup or Hull Breach).
// Designed for Claude Code sessions (and humans in a terminal). Requires Node 18+.
// Session state is kept in ./.multicoup-session.json (one player per directory).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SESSION_FILE = '.multicoup-session.json';
const POLL_SEC = 25;
const DEFAULT_WAIT_SEC = 300;
const GAMES = ['coup', 'hullbreach'];

const USAGE = `Usage: node multicoup.mjs <command>
  create <server-url> <game> <your-name>   Create a room (you become host). game: ${GAMES.join(' | ')}
  join <server-url> <ROOM> <your-name>     Join an existing room
  status                                   Show the current state and your options
  wait [seconds]                           Block until you must decide (default ${DEFAULT_WAIT_SEC}s)
  act <number>                             Make the numbered move from the last status/wait
  act '<json move>'                        Make a move given as JSON
  propose <name> <name> ...                (Hull Breach captain) Propose a mission crew
  say <message...>                         Send a table-talk chat message
  start                                    (host) Start the next game
  settings key=value ...                   (host) responseTimeoutSec=N autoNextSec=N
  options key=true|false ...               (host, Hull Breach) navigator medic mimic ghost rogue
  kick <player-name>                       (host) Remove a player
  leave                                    Leave the room (forfeits/abandons a game in progress)
  rules                                    Print the rules of this room's game`;

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

async function enter(server, code, name, game) {
  server = server.replace(/\/+$/, '');
  const url = code ? `${server}/api/rooms/${code}/join` : `${server}/api/rooms`;
  const body = code ? { name } : { name, game };
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
// The server supplies the game-specific text (st.text, st.situation); this only frames it.
function print(s, st, { full }) {
  const g = st.game;
  const lines = [];
  lines.push(`=== ${st.title} · Room ${st.code} · Game ${st.gameNumber || '-'} · ${st.members.length} seated ===`);
  if (g) {
    if (!g.players.some((p) => p.id === st.you)) lines.push(`You are ${s.name}, sitting out this game (joined mid-game). You will be dealt in next game.`);
    lines.push(...st.text);
    lines.push(`Now: ${st.situation.text}${st.situation.sub ? ` ${st.situation.sub}` : ''}`);
  } else {
    lines.push(`You are ${s.name}. Seated: ${st.members.map((m) => m.name).join(', ')}. No game has started yet (${st.minPlayers}-${st.maxPlayers} players).`);
  }
  if (st.narrator.paused || st.narrator.held) lines.push('(The narrator is holding the game. Your options will appear when it continues.)');
  if (st.responseDeadline) lines.push(`(Auto-pass in ${Math.max(0, Math.round((st.responseDeadline - Date.now()) / 1000))}s.)`);

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

  if (st.legal.length) {
    lines.push('');
    const propose = st.legal.find((m) => m.type === 'propose');
    if (propose) {
      lines.push(`YOUR DECISION — you are captain. Choose exactly ${propose.size} crew (you may include yourself) and run:`);
      lines.push(`  node multicoup.mjs propose ${Array.from({ length: propose.size }, (_, i) => `<name${i + 1}>`).join(' ')}`);
      lines.push(`  Players: ${propose.choices.map((id) => g.players.find((p) => p.id === id).name).join(', ')}`);
    } else {
      lines.push('YOUR DECISION — run: node multicoup.mjs act <number>');
      st.legal.forEach((m, i) => lines.push(`  ${i}. ${m.label}`));
    }
  } else if (st.canStart) {
    lines.push('');
    lines.push('You are the host and no game is running: run "node multicoup.mjs start" when everyone is seated.');
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

async function propose(names) {
  const s = loadSession();
  const st = await api(s, 'GET', '/state');
  if (!st.legal.some((m) => m.type === 'propose')) {
    console.log('You are not choosing a crew right now. Current state:');
    print(s, st, { full: false });
    saveSession(s);
    process.exit(1);
  }
  const team = names.map((n) => {
    const p = st.game.players.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (!p) die(`no player named ${n} (players: ${st.game.players.map((x) => x.name).join(', ')})`);
    return p.id;
  });
  const after = await api(s, 'POST', '/act', { move: { type: 'propose', team } });
  print(s, after, { full: false });
  saveSession(s);
}

async function options(pairs) {
  const s = loadSession();
  const patch = {};
  for (const p of pairs) {
    const [k, v] = p.split('=');
    if (v !== 'true' && v !== 'false') die(`expected key=true or key=false, got ${p}`);
    patch[k] = v === 'true';
  }
  const st = await api(s, 'POST', '/options', { options: patch });
  console.log(`Options now: ${JSON.stringify(st.options)}`);
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
      if (args.length !== 3 || !GAMES.includes(args[1])) die(USAGE);
      return enter(args[0], null, args[2], args[1]);
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
    case 'propose':
      return propose(args);
    case 'settings':
      return settings(args);
    case 'options':
      return options(args);
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
      const st = await api(s, 'GET', '/state');
      const res = await fetch(`${s.server}/rules/${st.kind}.md`);
      return console.log(await res.text());
    }
    default:
      die(USAGE);
  }
}

await main();
