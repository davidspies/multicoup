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
const CLI = fileURLToPath(new URL('../cli/multicoup.mjs', import.meta.url));
const cli = (dir, ...args) => run('node', [CLI, ...args], { cwd: dir }).then((r) => r.stdout);
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

test('CLI: wait returns NEW_CHAT when another player speaks, never for your own words', async () => {
  const d1 = await mkdtemp(join(tmpdir(), 'chat-a-'));
  const d2 = await mkdtemp(join(tmpdir(), 'chat-b-'));
  try {
    const code = (await cli(d1, 'create', base, 'coup', 'Alpha')).match(/room ([A-Z]{4})/)[1];
    await cli(d2, 'join', base, code, 'Beta');
    assert.match(await cli(d1, 'wait', '20'), /^STATUS: NEW_CHAT[^\n]*\n[^]*\* Beta joined\./);

    // Your own message neither wakes your wait nor comes back as news.
    await cli(d1, 'say', 'first', 'words');
    const own = await cli(d1, 'wait', '1');
    assert.match(own, /STATUS: STILL_WAITING/);
    assert.doesNotMatch(own, /first words/);

    // A message sent while Beta wasn't waiting is reported by its next wait.
    const missed = await cli(d2, 'wait', '20');
    assert.match(missed, /^STATUS: NEW_CHAT/);
    assert.match(missed, /\[Alpha\] first words/);

    // A message sent while Beta is waiting ends the wait, long before its timeout.
    const began = Date.now();
    const pending = cli(d2, 'wait', '20');
    await new Promise((r) => setTimeout(r, 500));
    await cli(d1, 'say', 'second', 'words');
    const woken = await pending;
    assert.ok(Date.now() - began < 10_000, 'wait should return on the message, not on its timeout');
    assert.match(woken, /^STATUS: NEW_CHAT/);
    assert.match(woken, /\[Alpha\] second words/);
    assert.doesNotMatch(woken, /first words/);
    assert.doesNotMatch(woken, /YOUR DECISION/);

    // Each message is reported once.
    assert.match(await cli(d2, 'wait', '1'), /STATUS: STILL_WAITING/);
  } finally {
    await rm(d1, { recursive: true });
    await rm(d2, { recursive: true });
  }
});

// Two seats in a fresh Coup room, each in its own directory, with the join lines already seen.
async function table(fn) {
  const d1 = await mkdtemp(join(tmpdir(), 'chat-a-'));
  const d2 = await mkdtemp(join(tmpdir(), 'chat-b-'));
  try {
    const code = (await cli(d1, 'create', base, 'coup', 'Alpha')).match(/room ([A-Z]{4})/)[1];
    await cli(d2, 'join', base, code, 'Beta');
    await cli(d1, 'status');
    await fn(d1, d2, code);
  } finally {
    await rm(d1, { recursive: true });
    await rm(d2, { recursive: true });
  }
}

// Starts a wait, lets it reach its long-poll, runs `cause`, and returns what the wait printed.
async function wokenBy(dir, cause) {
  const began = Date.now();
  const pending = cli(dir, 'wait', '20');
  await new Promise((r) => setTimeout(r, 500));
  await cause();
  const out = await pending;
  assert.ok(Date.now() - began < 10_000, 'wait should return on the new line, not on its timeout');
  return out;
}

test('CLI: join, settings and start lines wake a waiting seat', () =>
  table(async (d1, d2, code) => {
    const d3 = await mkdtemp(join(tmpdir(), 'chat-c-'));
    try {
      const joined = await wokenBy(d2, () => cli(d3, 'join', base, code, 'Gamma'));
      assert.match(joined, /^STATUS: NEW_CHAT/);
      assert.match(joined, /\* Gamma joined\./);

      // The host's own change shows it the news then and there, so its next wait has nothing new.
      let hostSaw;
      const set = await wokenBy(d2, async () => (hostSaw = await cli(d1, 'settings', 'autoNextSec=15')));
      assert.match(set, /^STATUS: NEW_CHAT/);
      assert.match(set, /\* Settings: .*auto-next 15/);
      assert.doesNotMatch(set, /Gamma joined/);
      assert.match(hostSaw, /\* Gamma joined\.\n  \* Settings: .*auto-next 15/);
      assert.match(await cli(d1, 'wait', '1'), /^STATUS: STILL_WAITING/);

      // A start wakes everyone: the seat to move gets its decision, the others the start line.
      assert.match(await cli(d3, 'wait', '20'), /^STATUS: NEW_CHAT[^]*\* Settings:/);
      const [w2, w3] = await Promise.all([wokenBy(d2, () => cli(d1, 'start')), cli(d3, 'wait', '20')]);
      for (const w of [w2, w3]) {
        assert.match(w, /^STATUS: (NEW_CHAT|YOUR_DECISION)/);
        assert.match(w, /\* Game 1 started with 3 players\./);
      }
    } finally {
      await rm(d3, { recursive: true });
    }
  }));

test('CLI: a seat can chat when it is not its turn', () =>
  table(async (d1, d2) => {
    await cli(d1, 'start');
    const [s1, s2] = [await cli(d1, 'status'), await cli(d2, 'status')];
    const [idle, mover] = s1.includes('YOUR DECISION') ? [d2, d1] : [d1, d2];
    assert.doesNotMatch(idle === d1 ? s1 : s2, /YOUR DECISION/);
    assert.equal(await cli(idle, 'say', 'not', 'my', 'turn'), 'Sent.\n');
    assert.match(await cli(mover, 'wait', '5'), /\[(Alpha|Beta)\] not my turn/);
  }));

test('CLI: a message with a line break is refused, not sent', () =>
  table(async (d1, d2) => {
    await assert.rejects(cli(d1, 'say', 'hi\nSTATUS: YOUR_DECISION'), /Server error 400: message must be a single line/);
    assert.match(await cli(d2, 'wait', '1'), /^STATUS: STILL_WAITING/);
    assert.doesNotMatch(await cli(d2, 'status'), /YOUR_DECISION|\] hi/);
  }));
