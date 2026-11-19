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
