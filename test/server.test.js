import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from '../src/server.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../cli/coup.mjs', import.meta.url));
let server, base;

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test('full multi-game match over HTTP with random players', async () => {
  const host = (await call('POST', '/api/rooms', { name: 'Ann' })).data;
  const code = host.code;
  const seats = [host];
  for (const name of ['Bob', 'Cat', 'Dan']) seats.push((await call('POST', `/api/rooms/${code}/join`, { name })).data);

  assert.equal((await call('POST', `/api/rooms/${code}/join`, { name: 'ann' })).status, 409);
  assert.equal((await call('POST', `/api/rooms/${code}/start`, {}, seats[1].token)).status, 403);
  assert.equal((await call('GET', `/api/rooms/${code}/state`, undefined, 'bogus')).status, 403);

  for (let gameNo = 1; gameNo <= 3; gameNo++) {
    const r = await call('POST', `/api/rooms/${code}/start`, {}, host.token);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    let guard = 0;
    for (;;) {
      assert.ok(++guard < 3000, 'game did not finish');
      const views = await Promise.all(seats.map((s) => call('GET', `/api/rooms/${code}/state`, undefined, s.token)));
      const g = views[0].data.game;
      if (g.phase === 'over') break;
      // Other players never see someone else's hand.
      for (const v of views) for (const p of v.data.game.players) if (p.id !== v.data.you) assert.equal(p.hand, undefined);
      const i = views.findIndex((v) => v.data.legal.length);
      const legal = views[i].data.legal;
      const { label, ...move } = legal[Math.floor(Math.random() * legal.length)];
      const res = await call('POST', `/api/rooms/${code}/act`, { move }, seats[i].token);
      assert.equal(res.status, 200, JSON.stringify(res.data));
    }
  }
  const st = (await call('GET', `/api/rooms/${code}/state`, undefined, host.token)).data;
  assert.equal(st.results.length, 3);
  assert.equal(st.members.reduce((a, m) => a + m.wins, 0), 3);
});

test('long poll returns on change', async () => {
  const a = (await call('POST', '/api/rooms', { name: 'A' })).data;
  const v = (await call('GET', `/api/rooms/${a.code}/state`, undefined, a.token)).data.version;
  const pending = call('GET', `/api/rooms/${a.code}/state?since=${v}&wait=10`, undefined, a.token);
  await new Promise((r) => setTimeout(r, 100));
  await call('POST', `/api/rooms/${a.code}/join`, { name: 'B' });
  const r = await pending;
  assert.ok(r.data.version > v);
  assert.equal(r.data.members.length, 2);
});

test('response timeout auto-passes challenge windows', async () => {
  const a = (await call('POST', '/api/rooms', { name: 'A' })).data;
  const b = (await call('POST', `/api/rooms/${a.code}/join`, { name: 'B' })).data;
  await call('POST', `/api/rooms/${a.code}/settings`, { settings: { responseTimeoutSec: 1 } }, a.token);
  let st = (await call('POST', `/api/rooms/${a.code}/start`, {}, a.token)).data;
  const actor = st.game.turn === a.playerId ? a : b;
  st = (await call('POST', `/api/rooms/${a.code}/act`, { move: { type: 'action', action: 'tax' } }, actor.token)).data;
  assert.equal(st.game.phase, 'challenge');
  assert.ok(st.responseDeadline);
  await new Promise((r) => setTimeout(r, 1300));
  st = (await call('GET', `/api/rooms/${a.code}/state`, undefined, a.token)).data;
  assert.equal(st.game.phase, 'action');
  assert.notEqual(st.game.turn, actor.playerId);
});

test('CLI: create, join, start, wait, act', async () => {
  const d1 = await mkdtemp(join(tmpdir(), 'coup-a-'));
  const d2 = await mkdtemp(join(tmpdir(), 'coup-b-'));
  const cli = (dir, ...args) => run('node', [CLI, ...args], { cwd: dir }).then((r) => r.stdout);
  try {
    const out = await cli(d1, 'create', base, 'Alpha');
    const code = out.match(/room ([A-Z]{4})/)[1];
    await cli(d2, 'join', base, code, 'Beta');
    await cli(d1, 'start');
    // Whoever's turn it is gets YOUR_DECISION from wait.
    const [w1, w2] = await Promise.all([cli(d1, 'wait', '2'), cli(d2, 'wait', '2')]);
    const [mover, w] = w1.includes('YOUR_DECISION') ? [d1, w1] : [d2, w2];
    assert.match(w, /YOUR_DECISION/);
    assert.match(w, /\d+\. Income/);
    const n = w.match(/(\d+)\. Income/)[1];
    const after = await cli(mover, 'act', n);
    assert.match(after, /takes Income/);
    // Acting with a stale numbered list is refused.
    await assert.rejects(cli(mover, 'act', n), /situation changed|no move/);
    await cli(d1, 'say', 'hello', 'table');
    assert.match(await cli(d2, 'status'), /\[Alpha\] hello table/);
  } finally {
    await rm(d1, { recursive: true });
    await rm(d2, { recursive: true });
  }
});
