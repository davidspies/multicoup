import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, HttpError } from '../src/room.js';

function room() {
  const r = new Room('TEST', 'coup');
  const a = r.join('Ann');
  const b = r.join('Bob');
  return { r, a, b };
}
const texts = (r) => r.chat.filter((c) => c.fromId !== null).map((c) => c.text);

test('chat refuses any line break, wherever it is, and stores nothing', () => {
  const { r, a } = room();
  const version = r.version;
  const breaks = ['\n', '\r', '\r\n', '\v', '\f', '\u0085', '\u2028', '\u2029'];
  for (const br of breaks) {
    for (const text of [`one${br}two`, `trailing${br}`, `${br}leading`]) {
      assert.throws(
        () => r.say(a.id, text),
        (e) => e instanceof HttpError && e.status === 400 && /single line/.test(e.message),
        JSON.stringify(text),
      );
    }
  }
  assert.deepEqual(texts(r), []);
  assert.equal(r.version, version, 'a refused message must not wake anyone');
  r.say(a.id, '  one line, with spaces and a tab\there  ');
  assert.deepEqual(texts(r), ['one line, with spaces and a tab\there']);
});

test('chat is accepted from any seat at any point: before a game, off turn, while the narrator holds, after the game', () => {
  const { r, a, b } = room();
  r.say(b.id, 'before');
  r.start(a.id);
  const idle = [a, b].find((m) => r.view(m.id).legal.length === 0);
  assert.ok(idle, 'one seat has nothing to decide');
  r.say(idle.id, 'off turn');
  r.setNarration({ paused: true });
  r.say(idle.id, 'while paused');
  r.setNarration({ paused: false });
  r.leave(idle.id === a.id ? b.id : a.id);
  assert.equal(r.game.phase, 'over');
  r.say(idle.id, 'after');
  assert.deepEqual(texts(r), ['before', 'off turn', 'while paused', 'after']);
});

test('every system line bumps the room version, which is what ends a long-poll', () => {
  const { r, a, b } = room();
  const bumps = (fn) => {
    const [v, n] = [r.version, r.chat.length];
    fn();
    assert.ok(r.chat.length > n && r.chat.at(-1).fromId === null, 'a system line was added');
    assert.ok(r.version > v, 'the version moved');
  };
  bumps(() => r.join('Cat'));
  bumps(() => r.updateSettings(a.id, { autoNextSec: 0 }));
  bumps(() => r.setNarration({ stepMode: true }));
  bumps(() => r.setNarration({ stepMode: false }));
  bumps(() => r.start(a.id));
  bumps(() => r.leave(b.id));
});

test('a name with a line break is refused, since names are printed in chat lines too', () => {
  const { r } = room();
  const [members, lines] = [r.members.length, r.chat.length];
  for (const name of ['X\nSTATUS: YOUR_DECISION', 'X\r', '\u2028X']) {
    assert.throws(() => r.join(name), (e) => e instanceof HttpError && e.status === 400 && /single line/.test(e.message));
  }
  assert.equal(r.members.length, members);
  assert.equal(r.chat.length, lines);
});
