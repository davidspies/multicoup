import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, IllegalMove } from '../src/games/hullbreach.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const players = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const newGame = (n, options = {}, seed = 1) => new Game(players(n), { rng: seeded(seed), startIndex: 0, options });

// Rewrite roles (keeps the side counts valid as long as callers do).
function setRoles(g, roles) {
  g.players.forEach((p, i) => (p.role = roles[i]));
  g.checkInvariants();
}
const voteAll = (g, approve) => g.players.forEach((p) => g.apply(p.id, { type: 'vote', approve }));
const sideOf = (g, id) => (['crew', 'navigator', 'medic'].includes(g.player(id).role) ? 'crew' : 'saboteurs');

function runMission(g, team, sabotagers = []) {
  g.apply(g.leaderId(), { type: 'propose', team });
  voteAll(g, true);
  for (const id of team) g.apply(id, { type: 'mission', card: sabotagers.includes(id) ? 'sabotage' : 'success' });
}

test('setup: team split and mission sizes', () => {
  for (const [n, bad, sizes] of [
    [5, 2, [2, 3, 2, 3, 3]],
    [7, 3, [2, 3, 3, 4, 4]],
    [10, 4, [3, 4, 4, 5, 5]],
  ]) {
    const g = newGame(n);
    assert.equal(g.players.filter((p) => sideOf(g, p.id) === 'saboteurs').length, bad);
    assert.deepEqual(g.missions.map((m) => m.size), sizes);
    assert.equal(g.missions[3].twoFails, n >= 7);
  }
  assert.throws(() => newGame(4), IllegalMove);
  assert.throws(() => newGame(11), IllegalMove);
  // 5 players have only 2 saboteurs: Hunter + Mimic + Ghost is too many.
  assert.throws(() => newGame(5, { mimic: true, ghost: true }), /special saboteur roles/);
  assert.throws(() => newGame(5, { wizard: true }), /unknown option/);
});

test('knowledge: each role sees exactly what it should', () => {
  const g = newGame(10, { medic: true, mimic: true, ghost: true, rogue: true });
  setRoles(g, ['navigator', 'medic', 'crew', 'crew', 'crew', 'crew', 'hunter', 'mimic', 'ghost', 'rogue']);
  const k = (id) => g.knowledge(id).map((x) => `${x.id}:${x.tag}`).sort();
  assert.deepEqual(k('p1'), ['p10:saboteur', 'p7:saboteur', 'p8:saboteur']); // not the Ghost
  assert.deepEqual(k('p2'), ['p1:navigator?', 'p8:navigator?']); // Navigator + Mimic
  assert.deepEqual(k('p3'), []);
  assert.deepEqual(k('p7'), ['p8:saboteur', 'p9:saboteur']); // not the Rogue
  assert.deepEqual(k('p10'), []); // Rogue knows nobody
  // Views never leak another player's role before the game ends.
  for (const p of g.players) {
    const v = g.view(p.id);
    assert.ok(v.players.every((q) => q.role === null));
    assert.equal(v.you.role, p.role);
  }
  assert.equal(g.view(null).you, undefined);
});

test('propose validation and rejection rotates the captain', () => {
  const g = newGame(5);
  assert.throws(() => g.apply('p2', { type: 'propose', team: ['p1', 'p2'] }), /not waiting/);
  assert.throws(() => g.apply('p1', { type: 'propose', team: ['p1'] }), /exactly 2/);
  assert.throws(() => g.apply('p1', { type: 'propose', team: ['p1', 'p1'] }), /duplicates/);
  assert.throws(() => g.apply('p1', { type: 'propose', team: ['p1', 'zz'] }), /no player/);
  g.apply('p1', { type: 'propose', team: ['p1', 'p2'] });
  assert.equal(g.phase, 'vote');
  // 2 approve, 3 reject: rejected (ties also fail).
  ['p1', 'p2'].forEach((id) => g.apply(id, { type: 'vote', approve: true }));
  ['p3', 'p4', 'p5'].forEach((id) => g.apply(id, { type: 'vote', approve: false }));
  assert.equal(g.phase, 'propose');
  assert.equal(g.leaderId(), 'p2');
  assert.equal(g.attempt, 2);
  assert.equal(g.proposals[0].approved, false);
  assert.deepEqual(g.proposals[0].votes, { p1: true, p2: true, p3: false, p4: false, p5: false });
});

test('five rejected proposals in a row: saboteurs win', () => {
  const g = newGame(5);
  for (let i = 0; i < 5; i++) {
    g.apply(g.leaderId(), { type: 'propose', team: ['p1', 'p2'] });
    voteAll(g, false);
  }
  assert.equal(g.phase, 'over');
  assert.equal(g.winnerSide, 'saboteurs');
});

test('crew cannot sabotage; one sabotage fails a normal mission', () => {
  const g = newGame(5);
  setRoles(g, ['crew', 'crew', 'navigator', 'hunter', 'saboteur']);
  g.apply('p1', { type: 'propose', team: ['p1', 'p4'] });
  voteAll(g, true);
  assert.deepEqual(g.legalMoves('p1'), [{ type: 'mission', card: 'success' }]);
  assert.throws(() => g.apply('p1', { type: 'mission', card: 'sabotage' }), /illegal/);
  g.apply('p1', { type: 'mission', card: 'success' });
  g.apply('p4', { type: 'mission', card: 'sabotage' });
  assert.equal(g.missions[0].result, 'fail');
  assert.equal(g.missions[0].fails, 1);
  assert.equal(g.mission, 1);
  assert.equal(g.leaderId(), 'p2');
  assert.match(g.history.find((h) => /FAILED/.test(h.text)).note, /P4/);
});

test('mission 4 with 7+ players needs two sabotage cards', () => {
  const g = newGame(7);
  setRoles(g, ['crew', 'crew', 'crew', 'navigator', 'hunter', 'saboteur', 'saboteur']);
  runMission(g, ['p1', 'p2'], []);
  runMission(g, ['p1', 'p2', 'p3'], []);
  runMission(g, ['p1', 'p2', 'p5'], ['p5']);
  assert.equal(g.mission, 3);
  runMission(g, ['p1', 'p2', 'p3', 'p5'], ['p5']);
  assert.equal(g.missions[3].result, 'success');
  assert.equal(g.phase, 'hunt');
});

test('hunt: finding the Navigator steals the win; missing it loses', () => {
  for (const [target, side] of [
    ['p3', 'saboteurs'],
    ['p1', 'crew'],
  ]) {
    const g = newGame(5);
    setRoles(g, ['crew', 'crew', 'navigator', 'hunter', 'saboteur']);
    for (let i = 0; i < 3; i++) runMission(g, g.current().size === 2 ? ['p1', 'p2'] : ['p1', 'p2', 'p3'], []);
    assert.equal(g.phase, 'hunt');
    assert.deepEqual(g.awaiting(), ['p4']);
    g.apply('p4', { type: 'hunt', target });
    assert.equal(g.winnerSide, side);
    assert.deepEqual(g.winners().sort(), g.players.filter((p) => sideOf(g, p.id) === side).map((p) => p.id).sort());
    assert.ok(g.view(null).players.every((p) => p.role));
  }
});

test('without a Navigator the crew wins outright on three successes', () => {
  const g = newGame(5, { navigator: false });
  assert.ok(g.players.every((p) => ['crew', 'saboteur'].includes(p.role)));
  setRoles(g, ['crew', 'crew', 'crew', 'saboteur', 'saboteur']);
  for (let i = 0; i < 3; i++) runMission(g, g.current().size === 2 ? ['p1', 'p2'] : ['p1', 'p2', 'p3'], []);
  assert.equal(g.winnerSide, 'crew');
});

test('forfeit abandons the game with no winners', () => {
  const g = newGame(6);
  g.forfeit('p3');
  assert.equal(g.phase, 'over');
  assert.deepEqual(g.winners(), []);
  assert.match(g.resultText(), /Abandoned/);
});

test('random play always ends and never leaks roles early', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rng = seeded(seed * 104729);
    const n = 5 + (seed % 6);
    const opts = { medic: seed % 2 === 0, mimic: seed % 3 === 0, ghost: n >= 7 && seed % 5 === 0, rogue: n >= 10 && seed % 7 === 0, scanner: seed % 4 < 2 };
    const g = newGame(n, opts, seed);
    let steps = 0;
    while (g.phase !== 'over') {
      assert.ok(++steps < 2000, `seed ${seed} did not finish`);
      const who = g.awaiting();
      const pid = who[Math.floor(rng() * who.length)];
      const [m] = g.legalMoves(pid);
      if (m.type === 'propose') {
        const ids = g.players.map((p) => p.id).sort(() => rng() - 0.5);
        g.apply(pid, { type: 'propose', team: ids.slice(0, m.size) });
      } else {
        const moves = g.legalMoves(pid);
        // Approve most of the time so missions happen.
        const pick = m.type === 'vote' ? moves[rng() < 0.7 ? 0 : 1] : moves[Math.floor(rng() * moves.length)];
        g.apply(pid, pick);
      }
      g.checkInvariants();
      assert.ok(g.view(null).players.every((p) => (g.phase === 'over') === (p.role !== null)));
    }
    assert.ok(g.privateRecord().roles.length === n);
  }
});

test('scanner: used after missions 2-4, result private, passes on, no re-scanning past holders', () => {
  const g = newGame(7, { scanner: true });
  setRoles(g, ['crew', 'crew', 'crew', 'navigator', 'hunter', 'saboteur', 'saboteur']);
  // First captain is seat 0, so the seat before (P7) starts with the Scanner.
  assert.equal(g.scanHolder, 'p7');
  runMission(g, ['p1', 'p2'], []);
  assert.equal(g.phase, 'propose'); // no scan after mission 1
  runMission(g, ['p1', 'p2', 'p6'], ['p6']);
  assert.equal(g.phase, 'scan');
  assert.deepEqual(g.awaiting(), ['p7']);
  const targets = g.legalMoves('p7').map((m) => m.target);
  assert.ok(!targets.includes('p7'));
  g.apply('p7', { type: 'scan', target: 'p6' });
  // Only the scanner sees the result.
  assert.deepEqual(g.view('p7').you.scans, [{ target: 'p6', side: 'saboteurs' }]);
  for (const p of g.players.filter((x) => x.id !== 'p7')) assert.deepEqual(g.view(p.id).you.scans, []);
  assert.deepEqual(g.view(null).scans, [{ by: 'p7', target: 'p6', afterMission: 1 }]);
  assert.ok(!JSON.stringify(g.view(null)).includes('"side"'), 'scan result leaked into public view');
  assert.ok(g.textView('p7').some((l) => /Your scan: P6 is a saboteur/.test(l)));
  assert.ok(!g.textView('p1').some((l) => /Your scan/.test(l)));
  assert.equal(g.scanHolder, 'p6');
  assert.equal(g.phase, 'propose');
  assert.equal(g.mission, 2);
  runMission(g, ['p1', 'p2', 'p3'], []);
  assert.equal(g.phase, 'scan');
  assert.deepEqual(g.awaiting(), ['p6']);
  assert.throws(() => g.apply('p6', { type: 'scan', target: 'p7' }), /illegal/);
  g.apply('p6', { type: 'scan', target: 'p1' });
  assert.match(g.history.at(-2).note, /P1 is loyal crew/);
});

test('scanner off: no scan phase, nobody holds it', () => {
  const g = newGame(7);
  assert.equal(g.scanHolder, null);
  setRoles(g, ['crew', 'crew', 'crew', 'navigator', 'hunter', 'saboteur', 'saboteur']);
  runMission(g, ['p1', 'p2'], []);
  runMission(g, ['p1', 'p2', 'p3'], []);
  assert.equal(g.phase, 'propose');
});
