import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, IllegalMove } from '../src/games/coup.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function newGame(n, seed = 1) {
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  return new Game(players, { rng: seeded(seed), startIndex: 0, options: {} });
}

// Force a player's hidden hand (swapping cards with the deck to keep counts valid).
function setHand(g, pid, roles) {
  const p = g.player(pid);
  p.cards.forEach((c, i) => {
    const want = roles[i];
    if (c.role === want) return;
    const j = g.deck.indexOf(want);
    if (j < 0) {
      // take from another player's hidden card
      const other = g.players.flatMap((q) => (q.id === pid ? [] : q.cards)).find((x) => x.role === want);
      other.role = c.role;
    } else g.deck[j] = c.role;
    c.role = want;
  });
  g.checkInvariants();
}

const passAllResponders = (g) => g.awaiting().forEach((id) => g.apply(id, { type: 'pass' }));

test('setup: 2 cards and 2 coins each, 2p starter gets 1', () => {
  const g = newGame(4);
  g.players.forEach((p) => {
    assert.equal(p.cards.length, 2);
    assert.equal(p.coins, 2);
  });
  assert.equal(g.deck.length, 7);
  const g2 = newGame(2);
  assert.equal(g2.players[0].coins, 1);
  assert.equal(g2.players[1].coins, 2);
});

test('income ends turn', () => {
  const g = newGame(3);
  g.apply('p1', { type: 'action', action: 'income' });
  assert.equal(g.player('p1').coins, 3);
  assert.equal(g.turn, 1);
  assert.equal(g.phase, 'action');
});

test('out-of-turn and illegal moves throw', () => {
  const g = newGame(3);
  assert.throws(() => g.apply('p2', { type: 'action', action: 'income' }), IllegalMove);
  assert.throws(() => g.apply('p1', { type: 'action', action: 'coup', target: 'p2' }), IllegalMove);
  assert.throws(() => g.apply('p1', { type: 'action', action: 'steal', target: 'p1' }), IllegalMove);
});

test('tax unchallenged gives 3', () => {
  const g = newGame(3);
  g.apply('p1', { type: 'action', action: 'tax' });
  assert.equal(g.phase, 'challenge');
  assert.deepEqual(g.awaiting().sort(), ['p2', 'p3']);
  passAllResponders(g);
  assert.equal(g.player('p1').coins, 5);
  assert.equal(g.turn, 1);
});

test('failed challenge: challenger loses, claimant replaces card, action proceeds', () => {
  const g = newGame(3);
  setHand(g, 'p1', ['duke', 'captain']);
  setHand(g, 'p2', ['assassin', 'contessa']);
  g.apply('p1', { type: 'action', action: 'tax' });
  g.apply('p2', { type: 'challenge' });
  assert.equal(g.phase, 'lose');
  assert.deepEqual(g.awaiting(), ['p2']);
  const role = g.hidden(g.player('p2'))[0].role;
  g.apply('p2', { type: 'lose', role });
  assert.equal(g.player('p2').cards.filter((c) => c.revealed).length, 1);
  assert.equal(g.player('p1').coins, 5);
  // The public log spells out that the proven card went back and was replaced, not lost.
  assert.ok(g.log.some((l) => /P1 shows Duke: the claim was true/.test(l)));
  assert.ok(g.log.some((l) => /shuffles that Duke back into the court deck and draws a face-down replacement\. It is not lost/.test(l)));
  const replaced = g.history.find((h) => /replacement/.test(h.text));
  assert.match(replaced.note, /^P1 drew \w+ as the replacement\.$/);
  g.checkInvariants();
});

test('successful challenge on assassinate refunds coins', () => {
  const g = newGame(3);
  setHand(g, 'p1', ['duke', 'duke']);
  g.player('p1').coins = 3;
  g.apply('p1', { type: 'action', action: 'assassinate', target: 'p2' });
  assert.equal(g.player('p1').coins, 0);
  g.apply('p3', { type: 'challenge' });
  assert.equal(g.player('p1').coins, 3);
  // A pair is never revealed automatically: that would give the pair away.
  assert.equal(g.phase, 'lose');
  assert.deepEqual(g.legalMoves('p1'), [{ type: 'lose', role: 'duke' }]);
  g.apply('p1', { type: 'lose', role: 'duke' });
  assert.equal(g.player('p1').cards.filter((c) => c.revealed).length, 1);
  assert.equal(g.phase, 'action');
  assert.equal(g.turn, 1);
});

test('target can block immediately, alongside challenge; then no one can challenge the action', () => {
  const g = newGame(3);
  setHand(g, 'p1', ['assassin', 'duke']);
  g.player('p1').coins = 3;
  g.apply('p1', { type: 'action', action: 'assassinate', target: 'p2' });
  assert.equal(g.phase, 'challenge');
  assert.deepEqual(g.awaiting().sort(), ['p2', 'p3']);
  assert.deepEqual(g.legalMoves('p2').map((m) => m.role ?? m.type), ['pass', 'challenge', 'contessa']);
  assert.deepEqual(g.legalMoves('p3').map((m) => m.type), ['pass', 'challenge']);
  g.apply('p2', { type: 'block', role: 'contessa' });
  // Now only the block can be challenged, by everyone but the blocker.
  assert.equal(g.view('p1').pending.challengeOf, 'block');
  assert.deepEqual(g.awaiting().sort(), ['p1', 'p3']);
  passAllResponders(g);
  assert.equal(g.player('p1').coins, 0);
  assert.equal(g.hidden(g.player('p2')).length, 2);
  assert.equal(g.turn, 1);
});

test('everyone allowing resolves the action with no separate block step', () => {
  const g = newGame(3);
  g.player('p2').coins = 1;
  g.apply('p1', { type: 'action', action: 'steal', target: 'p2' });
  passAllResponders(g);
  assert.equal(g.player('p1').coins, 3);
  assert.equal(g.player('p2').coins, 0);
  assert.equal(g.phase, 'action');
});

test('after a failed challenge, a target who had not yet answered may still block', () => {
  const g = newGame(3);
  setHand(g, 'p1', ['captain', 'duke']);
  setHand(g, 'p3', ['assassin', 'contessa']);
  g.apply('p1', { type: 'action', action: 'steal', target: 'p2' });
  g.apply('p3', { type: 'challenge' });
  g.apply('p3', { type: 'lose', role: 'assassin' });
  assert.equal(g.phase, 'block');
  assert.deepEqual(g.awaiting(), ['p2']);
  g.apply('p2', { type: 'block', role: 'ambassador' });
  passAllResponders(g);
  assert.equal(g.player('p1').coins, 2);
});

test('a target who already allowed gets no block after a failed challenge', () => {
  const g = newGame(3);
  setHand(g, 'p1', ['captain', 'duke']);
  setHand(g, 'p3', ['assassin', 'contessa']);
  g.apply('p1', { type: 'action', action: 'steal', target: 'p2' });
  g.apply('p2', { type: 'pass' });
  g.apply('p3', { type: 'challenge' });
  g.apply('p3', { type: 'lose', role: 'assassin' });
  assert.equal(g.phase, 'action');
  assert.equal(g.player('p1').coins, 4);
});

test('bluffed contessa called: target loses both influence', () => {
  const g = newGame(3);
  setHand(g, 'p1', ['assassin', 'duke']);
  setHand(g, 'p2', ['captain', 'duke']);
  g.player('p1').coins = 3;
  g.apply('p1', { type: 'action', action: 'assassinate', target: 'p2' });
  g.apply('p2', { type: 'block', role: 'contessa' });
  g.apply('p1', { type: 'challenge' });
  g.apply('p2', { type: 'lose', role: 'captain' });
  // block failed -> assassination resolves, auto-loses last card
  assert.equal(g.alive(g.player('p2')), false);
  g.checkInvariants();
});

test('wrongly challenging an assassin, then bluffing contessa, loses both', () => {
  const g = newGame(3);
  setHand(g, 'p1', ['assassin', 'duke']);
  setHand(g, 'p2', ['captain', 'duke']);
  g.player('p1').coins = 3;
  g.apply('p1', { type: 'action', action: 'assassinate', target: 'p2' });
  g.apply('p2', { type: 'challenge' });
  g.apply('p2', { type: 'lose', role: 'captain' });
  assert.equal(g.phase, 'block');
  g.apply('p2', { type: 'block', role: 'contessa' });
  g.apply('p1', { type: 'challenge' });
  assert.equal(g.alive(g.player('p2')), false);
  g.checkInvariants();
});

test('foreign aid can be blocked by anyone claiming duke', () => {
  const g = newGame(4);
  g.apply('p1', { type: 'action', action: 'foreign_aid' });
  assert.equal(g.phase, 'block');
  assert.deepEqual(g.awaiting().sort(), ['p2', 'p3', 'p4']);
  g.apply('p3', { type: 'block', role: 'duke' });
  assert.deepEqual(g.awaiting().sort(), ['p1', 'p2', 'p4']);
  passAllResponders(g);
  assert.equal(g.player('p1').coins, 2);
});

test('exchange keeps chosen cards', () => {
  const g = newGame(3);
  setHand(g, 'p1', ['ambassador', 'duke']);
  g.apply('p1', { type: 'action', action: 'exchange' });
  passAllResponders(g);
  assert.equal(g.phase, 'exchange');
  const v = g.view('p1');
  assert.equal(v.drawn.length, 2);
  const keep = [v.drawn[0], 'duke'];
  g.apply('p1', { type: 'exchange', keep });
  assert.deepEqual(g.hidden(g.player('p1')).map((c) => c.role).sort(), keep.sort());
  g.checkInvariants();
});

test('10 coins forces coup', () => {
  const g = newGame(3);
  g.player('p1').coins = 10;
  const moves = g.legalMoves('p1');
  assert.ok(moves.every((m) => m.action === 'coup'));
  assert.equal(moves.length, 2);
});

test('views hide other hands', () => {
  const g = newGame(3);
  const v = g.view('p1');
  assert.ok(v.players[0].hand);
  assert.equal(v.players[1].hand, undefined);
});

test('forfeit of current player advances turn', () => {
  const g = newGame(3);
  g.forfeit('p1');
  assert.equal(g.turn, 1);
  g.forfeit('p3');
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 'p2');
});

test('random play always terminates with invariants intact', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const rng = seeded(seed * 7919);
    const n = 2 + (seed % 5);
    const g = newGame(n, seed);
    let steps = 0;
    while (g.phase !== 'over') {
      if (++steps > 5000) throw new Error(`seed ${seed} did not finish`);
      const who = g.awaiting();
      assert.ok(who.length > 0, `nobody to move in ${g.phase}`);
      const pid = who[Math.floor(rng() * who.length)];
      if (rng() < 0.01) {
        g.forfeit(pid);
      } else if ((g.phase === 'challenge' || g.phase === 'block') && rng() < 0.05) {
        g.passAll();
      } else {
        const moves = g.legalMoves(pid);
        g.apply(pid, moves[Math.floor(rng() * moves.length)]);
      }
      g.checkInvariants();
    }
    assert.equal(g.alivePlayers().length, 1);
  }
});
