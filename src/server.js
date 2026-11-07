import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HttpError, Lobby } from './room.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
};
// Files served at fixed paths outside public/ so agents can download them.
const EXTRA_FILES = {
  '/coup.mjs': join(ROOT, 'cli', 'coup.mjs'),
  '/RULES.md': join(ROOT, 'RULES.md'),
  '/PLAYING_AS_CLAUDE.md': join(ROOT, 'PLAYING_AS_CLAUDE.md'),
};

export function createServer() {
  const lobby = new Lobby();
  const sweep = setInterval(() => lobby.sweep(), 10 * 60e3);
  sweep.unref();

  const server = http.createServer(async (req, res) => {
    try {
      await route(lobby, req, res);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e; // bugs crash the server
      send(res, e.status, { error: e.message });
    }
  });
  return server;
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

function auth(req, room) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) throw new HttpError(401, 'missing Authorization: Bearer <token>');
  return room.byToken(h.slice(7));
}

async function route(lobby, req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'api') return serveStatic(url.pathname, res);

  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'rooms') {
    const body = await readJson(req);
    const room = lobby.create();
    const m = room.join(body.name);
    return send(res, 200, { code: room.code, playerId: m.id, token: m.token });
  }
  if (parts[1] !== 'rooms' || parts.length < 4) throw new HttpError(404, 'unknown endpoint');

  const room = lobby.get(parts[2]);
  const op = parts[3];

  if (req.method === 'POST' && op === 'join') {
    const body = await readJson(req);
    const m = room.join(body.name);
    return send(res, 200, { code: room.code, playerId: m.id, token: m.token });
  }

  if (req.method === 'GET' && op === 'state') {
    auth(req, room);
    await longPoll(url, room);
    // The member may have been kicked while we waited.
    return send(res, 200, room.view(auth(req, room).id));
  }

  // Spectator feed: public information only, no token needed.
  if (req.method === 'GET' && op === 'watch') {
    await longPoll(url, room);
    return send(res, 200, room.publicView());
  }

  if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
  const me = auth(req, room);
  const body = await readJson(req);
  switch (op) {
    case 'act':
      room.act(me.id, body.move);
      break;
    case 'start':
      room.start(me.id);
      break;
    case 'chat':
      room.say(me.id, body.text);
      break;
    case 'settings':
      room.updateSettings(me.id, body.settings);
      break;
    case 'leave':
      room.leave(me.id);
      return send(res, 200, { ok: true });
    case 'kick':
      room.kick(me.id, body.playerId);
      break;
    default:
      throw new HttpError(404, 'unknown endpoint');
  }
  return send(res, 200, room.view(me.id));
}

// With ?since=V, wait until the room's version passes V (capped at longPollMaxSec).
async function longPoll(url, room) {
  const since = url.searchParams.get('since');
  if (since === null) return;
  const sinceN = Number(since);
  const wait = Number(url.searchParams.get('wait') ?? config.longPollMaxSec);
  if (!Number.isInteger(sinceN) || !(wait >= 0)) throw new HttpError(400, 'since and wait must be numbers');
  await room.waitForChange(sinceN, Math.min(wait, config.longPollMaxSec) * 1000);
}

async function serveStatic(pathname, res) {
  let file = EXTRA_FILES[pathname];
  if (!file) {
    const rel = normalize(pathname === '/' ? '/index.html' : pathname);
    if (rel.includes('..')) throw new HttpError(400, 'bad path');
    file = join(PUBLIC, rel);
  }
  let data;
  try {
    data = await readFile(file);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') throw new HttpError(404, 'not found');
    throw e;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(data);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(config.port, config.host, () => {
    console.log(`Coup server listening on http://${config.host}:${config.port}`);
  });
}
