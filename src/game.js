// Pure Coup rules engine. No I/O; every illegal move throws.

export const ROLES = ['duke', 'assassin', 'captain', 'ambassador', 'contessa'];

export const ACTIONS = {
  income: { cost: 0, claim: null, target: false, blockers: null, blockRoles: [] },
  foreign_aid: { cost: 0, claim: null, target: false, blockers: 'any', blockRoles: ['duke'] },
  coup: { cost: 7, claim: null, target: true, blockers: null, blockRoles: [] },
  tax: { cost: 0, claim: 'duke', target: false, blockers: null, blockRoles: [] },
  assassinate: { cost: 3, claim: 'assassin', target: true, blockers: 'target', blockRoles: ['contessa'] },
  steal: { cost: 0, claim: 'captain', target: true, blockers: 'target', blockRoles: ['captain', 'ambassador'] },
  exchange: { cost: 0, claim: 'ambassador', target: false, blockers: null, blockRoles: [] },
};

const MANDATORY_COUP_COINS = 10;

export const cap = (s) => s[0].toUpperCase() + s.slice(1);

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class IllegalMove extends Error {}

function fail(msg) {
  throw new IllegalMove(msg);
}

export class Game {
  // players: [{id, name}] in seating order. startIndex: who takes the first turn.
  constructor(players, { rng, startIndex }) {
    if (players.length < 2 || players.length > 6) fail('Coup needs 2-6 players');
    if (!(startIndex >= 0 && startIndex < players.length)) fail('bad startIndex');
    this.rng = rng;
    this.deck = shuffle(ROLES.flatMap((r) => [r, r, r]), rng);
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      coins: 2,
      cards: [this.draw(), this.draw()].map((role) => ({ role, revealed: false })),
    }));
    // Official two-player rule: the starting player begins with one coin.
    if (players.length === 2) this.players[startIndex].coins = 1;
    this.turn = startIndex;
    this.turnNumber = 1;
    this.phase = 'action';
    this.ctx = null;
    this.lossQueue = [];
    this.log = [];
    // Parallel to log: the private truth behind each public line, for the post-game reveal.
    this.history = [];
    this.startingHands = this.players.map((p) => ({ id: p.id, name: p.name, hand: p.cards.map((c) => c.role) }));
    this.winner = null;
    this.windowSeq = 0;
    this.addLog(`Game started. ${this.current().name} goes first.`);
  }

  // ---------- helpers ----------
  draw() {
    if (!this.deck.length) throw new Error('deck empty');
    return this.deck.pop();
  }
  // note: private detail (bluffs, cards drawn) shown only in the post-game reveal.
  addLog(text, note = null) {
    this.log.push(text);
    this.history.push({
      text,
      note,
      hands: Object.fromEntries(this.players.map((p) => [p.name, this.hidden(p).map((c) => c.role)])),
    });
  }

  // Honest or bluff, judged against the claimant's hand at the moment of the claim.
  claimNote(p, role) {
    const hand = this.hidden(p).map((c) => cap(c.role)).join(' + ');
    return this.hidden(p).some((c) => c.role === role)
      ? `HONEST: ${p.name} really holds ${cap(role)} (hand: ${hand}).`
      : `BLUFF: ${p.name} has no ${cap(role)} (hand: ${hand}).`;
  }
  player(id) {
    const p = this.players.find((x) => x.id === id);
    if (!p) fail(`no player ${id}`);
    return p;
  }
  current() {
    return this.players[this.turn];
  }
  hidden(p) {
    return p.cards.filter((c) => !c.revealed);
  }
  alive(p) {
    return this.hidden(p).length > 0;
  }
  alivePlayers() {
    return this.players.filter((p) => this.alive(p));
  }

  awaiting() {
    switch (this.phase) {
      case 'action':
        return [this.current().id];
      case 'challenge': {
        const w = this.ctx.window;
        return this.alivePlayers()
          .filter((p) => p.id !== w.claimant && !w.passed.has(p.id))
          .map((p) => p.id);
      }
      case 'block':
        return this.ctx.blockers.filter((id) => this.alive(this.player(id)) && !this.ctx.passed.has(id));
      case 'lose':
        return [this.lossQueue[0].id];
      case 'exchange':
        return [this.ctx.actor];
      case 'over':
        return [];
      default:
        throw new Error(`unknown phase ${this.phase}`);
    }
  }

  // ---------- legal moves ----------
  legalMoves(pid) {
    if (!this.awaiting().includes(pid)) return [];
    const me = this.player(pid);
    switch (this.phase) {
      case 'action': {
        const others = this.alivePlayers().filter((p) => p.id !== pid);
        const moves = [];
        const add = (action, target) => {
          const m = { type: 'action', action };
          if (target) m.target = target.id;
          moves.push(m);
        };
        if (me.coins >= MANDATORY_COUP_COINS) {
          others.forEach((t) => add('coup', t));
          return moves;
        }
        add('income');
        add('foreign_aid');
        if (me.coins >= ACTIONS.coup.cost) others.forEach((t) => add('coup', t));
        add('tax');
        if (me.coins >= ACTIONS.assassinate.cost) others.forEach((t) => add('assassinate', t));
        others.filter((t) => t.coins > 0).forEach((t) => add('steal', t));
        add('exchange');
        return moves;
      }
      case 'challenge': {
        // Steal/Assassinate: the target may block right away instead of waiting for challenges.
        const roles = this.ctx.window.blockers.includes(pid) ? ACTIONS[this.ctx.action].blockRoles : [];
        return [{ type: 'pass' }, { type: 'challenge' }, ...roles.map((role) => ({ type: 'block', role }))];
      }
      case 'block': {
        const roles = ACTIONS[this.ctx.action].blockRoles;
        return [{ type: 'pass' }, ...roles.map((role) => ({ type: 'block', role }))];
      }
      case 'lose':
        return [...new Set(this.hidden(me).map((c) => c.role))].map((role) => ({ type: 'lose', role }));
      case 'exchange': {
        const pool = [...this.hidden(me).map((c) => c.role), ...this.ctx.drawn];
        const keepCount = this.hidden(me).length;
        const combos = new Set();
        const rec = (start, chosen) => {
          if (chosen.length === keepCount) {
            combos.add(JSON.stringify([...chosen].sort()));
            return;
          }
          for (let i = start; i < pool.length; i++) rec(i + 1, [...chosen, pool[i]]);
        };
        rec(0, []);
        return [...combos].sort().map((c) => ({ type: 'exchange', keep: JSON.parse(c) }));
      }
      default:
        throw new Error(`no moves in phase ${this.phase}`);
    }
  }

  describeMove(pid, m) {
    const name = (id) => this.player(id).name;
    switch (m.type) {
      case 'action':
        return {
          income: 'Income (+1 coin)',
          foreign_aid: 'Foreign Aid (+2 coins, blockable by Duke)',
          coup: `Coup ${m.target && name(m.target)} (pay 7)`,
          tax: 'Tax (+3 coins) — claims Duke',
          assassinate: `Assassinate ${m.target && name(m.target)} (pay 3) — claims Assassin`,
          steal: `Steal from ${m.target && name(m.target)} (up to 2) — claims Captain`,
          exchange: 'Exchange cards — claims Ambassador',
        }[m.action];
      case 'pass':
        if (this.phase === 'block') return "Don't block";
        return this.ctx.window.blockers.includes(pid) ? 'Allow it (no challenge, no block)' : "Don't challenge";
      case 'challenge': {
        const w = this.ctx.window;
        return `Challenge ${name(w.claimant)}'s ${cap(w.role)}`;
      }
      case 'block':
        return `Block with ${cap(m.role)}`;
      case 'lose':
        return `Reveal (lose) ${cap(m.role)}`;
      case 'exchange':
        return `Keep ${m.keep.map(cap).join(' + ')}`;
      default:
        throw new Error(`unknown move ${m.type}`);
    }
  }

  // ---------- applying moves ----------
  apply(pid, move) {
    if (this.phase === 'over') fail('game is over');
    if (!this.awaiting().includes(pid)) fail('not waiting on you');
    if (!move || typeof move.type !== 'string') fail('move must have a type');
    const legal = this.legalMoves(pid);
    const key = (m) => JSON.stringify(normalize(m));
    if (!legal.some((m) => key(m) === key(move))) fail(`illegal move: ${JSON.stringify(move)}`);
    move = normalize(move);

    switch (move.type) {
      case 'action':
        return this.declare(pid, move.action, move.target);
      case 'pass':
        if (this.phase === 'challenge') this.ctx.window.passed.add(pid);
        else this.ctx.passed.add(pid);
        return this.checkWindowClosed();
      case 'challenge':
        return this.resolveChallenge(pid);
      case 'block':
        return this.declareBlock(pid, move.role);
      case 'lose': {
        const p = this.player(pid);
        this.reveal(p, this.hidden(p).find((c) => c.role === move.role), this.lossQueue[0].reason);
        this.lossQueue.shift();
        return this.runLosses();
      }
      case 'exchange':
        return this.finishExchange(pid, move.keep);
      default:
        throw new Error('unreachable');
    }
  }

  declare(pid, action, targetId) {
    const def = ACTIONS[action];
    const actor = this.player(pid);
    actor.coins -= def.cost;
    this.ctx = { actor: pid, action, target: targetId ?? null, claim: def.claim, blocker: null, blockRole: null, next: null };
    const t = targetId ? this.player(targetId).name : null;
    const phrases = {
      income: 'takes Income',
      foreign_aid: 'takes Foreign Aid',
      coup: `launches a Coup against ${t}`,
      tax: 'claims Duke and takes Tax',
      assassinate: `claims Assassin and pays 3 to assassinate ${t}`,
      steal: `claims Captain and tries to steal from ${t}`,
      exchange: 'claims Ambassador to Exchange',
    };
    this.addLog(`${actor.name} ${phrases[action]}.`, def.claim ? this.claimNote(actor, def.claim) : null);

    if (action === 'income') {
      actor.coins += 1;
      return this.step('endTurn');
    }
    if (action === 'coup') {
      this.queueLoss(targetId, `couped by ${actor.name}`);
      this.ctx.next = 'endTurn';
      return this.runLosses();
    }
    if (def.claim) return this.openChallenge('action', pid, def.claim, this.eligibleBlockers());
    return this.step('toBlock');
  }

  // blockers: players who may block the action from inside this challenge window.
  openChallenge(kind, claimant, role, blockers) {
    this.phase = 'challenge';
    this.windowSeq++;
    this.ctx.window = { kind, claimant, role, blockers, passed: new Set() };
    return this.checkWindowClosed();
  }

  eligibleBlockers() {
    const def = ACTIONS[this.ctx.action];
    if (def.blockers === 'any') return this.alivePlayers().filter((p) => p.id !== this.ctx.actor).map((p) => p.id);
    if (def.blockers === 'target') return [this.ctx.target];
    return [];
  }

  declareBlock(pid, role) {
    const p = this.player(pid);
    this.ctx.blocker = pid;
    this.ctx.blockRole = role;
    this.addLog(`${p.name} claims ${cap(role)} to block.`, this.claimNote(p, role));
    return this.openChallenge('block', pid, role, []);
  }

  checkWindowClosed() {
    if (this.phase === 'challenge' && this.awaiting().length === 0) {
      const w = this.ctx.window;
      this.ctx.window = null;
      // Everyone passed, including any blockers, so the action resolves.
      if (w.kind === 'action') return this.step('resolve');
      this.addLog(`The block stands.`);
      return this.step('endTurn');
    }
    if (this.phase === 'block' && this.awaiting().length === 0) return this.step('resolve');
  }

  resolveChallenge(challengerId) {
    const w = this.ctx.window;
    const claimant = this.player(w.claimant);
    const challenger = this.player(challengerId);
    this.ctx.window = null;
    this.addLog(`${challenger.name} challenges ${claimant.name}'s ${cap(w.role)}.`);
    const card = this.hidden(claimant).find((c) => c.role === w.role);
    if (card) {
      this.addLog(`${claimant.name} shows ${cap(w.role)}: the claim was true, so ${challenger.name}'s challenge fails.`);
      this.deck.push(card.role);
      shuffle(this.deck, this.rng);
      card.role = this.draw();
      this.addLog(
        `${claimant.name} shuffles that ${cap(w.role)} back into the court deck and draws a face-down replacement. ` +
          `It is not lost: ${claimant.name} still has ${this.hidden(claimant).length} influence, and ${cap(w.role)} is no longer known to be in their hand.`,
        `${claimant.name} drew ${cap(card.role)} as the replacement.`,
      );
      this.queueLoss(challengerId, 'lost a challenge');
      // Blockers who had already allowed the action don't get a second chance.
      this.ctx.declinedBlock = w.passed;
      this.ctx.next = w.kind === 'action' ? 'toBlock' : 'endTurn';
    } else {
      this.addLog(`${claimant.name} does not have ${cap(w.role)}. The challenge succeeds.`);
      this.queueLoss(w.claimant, 'caught bluffing');
      if (w.kind === 'action') {
        const cost = ACTIONS[this.ctx.action].cost;
        if (cost) {
          claimant.coins += cost;
          this.addLog(`${claimant.name}'s ${cost} coins are returned.`);
        }
        this.ctx.next = 'endTurn';
      } else {
        this.ctx.next = 'resolve';
      }
    }
    return this.runLosses();
  }

  queueLoss(id, reason) {
    this.lossQueue.push({ id, reason });
  }

  reveal(p, card, reason) {
    card.revealed = true;
    this.addLog(`${p.name} loses ${cap(card.role)} (${reason}).${this.alive(p) ? '' : ` ${p.name} is out!`}`);
  }

  runLosses() {
    while (this.lossQueue.length) {
      const { id, reason } = this.lossQueue[0];
      const p = this.player(id);
      const hidden = this.hidden(p);
      if (hidden.length === 0) {
        this.lossQueue.shift();
        continue;
      }
      // Only a last card is revealed automatically. Two identical cards still need the
      // player's own choice, or the instant reveal would show they hold a pair.
      if (hidden.length === 1) {
        this.reveal(p, hidden[0], reason);
        this.lossQueue.shift();
        continue;
      }
      this.phase = 'lose';
      return;
    }
    if (this.alivePlayers().length === 1) return this.finish();
    const next = this.ctx.next;
    this.ctx.next = null;
    return this.step(next);
  }

  step(name) {
    if (name === 'endTurn') return this.endTurn();
    const ctx = this.ctx;
    const actor = this.player(ctx.actor);
    const target = ctx.target ? this.player(ctx.target) : null;
    switch (name) {
      case 'toBlock': {
        if (!this.alive(actor) || (target && !this.alive(target))) return this.step('endTurn');
        const declined = ctx.declinedBlock ?? new Set();
        const blockers = this.eligibleBlockers().filter((id) => !declined.has(id));
        if (!blockers.length) return this.step('resolve');
        this.phase = 'block';
        this.windowSeq++;
        ctx.blockers = blockers;
        ctx.passed = new Set();
        return this.checkWindowClosed();
      }
      case 'resolve': {
        if (!this.alive(actor)) return this.step('endTurn');
        switch (ctx.action) {
          case 'foreign_aid':
            actor.coins += 2;
            this.addLog(`${actor.name} gains 2 coins.`);
            break;
          case 'tax':
            actor.coins += 3;
            this.addLog(`${actor.name} gains 3 coins.`);
            break;
          case 'steal': {
            if (!this.alive(target)) break;
            const amt = Math.min(2, target.coins);
            target.coins -= amt;
            actor.coins += amt;
            this.addLog(`${actor.name} steals ${amt} from ${target.name}.`);
            break;
          }
          case 'assassinate':
            this.queueLoss(target.id, `assassinated by ${actor.name}`);
            ctx.next = 'endTurn';
            return this.runLosses();
          case 'exchange':
            ctx.drawn = [this.draw(), this.draw()];
            this.phase = 'exchange';
            return;
          default:
            throw new Error(`cannot resolve ${ctx.action}`);
        }
        return this.step('endTurn');
      }
      default:
        throw new Error(`unknown step ${name}`);
    }
  }

  endTurn() {
    if (this.alivePlayers().length === 1) return this.finish();
    let i = this.turn;
    do i = (i + 1) % this.players.length;
    while (!this.alive(this.players[i]));
    this.turn = i;
    this.turnNumber++;
    this.ctx = null;
    this.phase = 'action';
  }

  finishExchange(pid, keep) {
    const p = this.player(pid);
    const hidden = this.hidden(p);
    const before = hidden.map((c) => cap(c.role)).join(' + ');
    const drawn = this.ctx.drawn.map(cap).join(' + ');
    const pool = [...hidden.map((c) => c.role), ...this.ctx.drawn];
    keep.forEach((role, i) => {
      pool.splice(pool.indexOf(role), 1);
      hidden[i].role = role;
    });
    this.deck.push(...pool);
    shuffle(this.deck, this.rng);
    this.addLog(
      `${p.name} exchanges cards with the deck.`,
      `${p.name} had ${before}, drew ${drawn}, kept ${keep.map(cap).join(' + ')}, returned ${pool.map(cap).join(' + ')}.`,
    );
    this.ctx.drawn = null;
    return this.step('endTurn');
  }

  finish() {
    if (this.ctx?.drawn) this.deck.push(...this.ctx.drawn);
    this.winner = this.alivePlayers()[0].id;
    this.phase = 'over';
    this.ctx = null;
    this.lossQueue = [];
    this.addLog(`${this.player(this.winner).name} wins the game!`);
  }

  // Close an open challenge/block window by passing for everyone still undecided.
  passAll() {
    if (this.phase === 'challenge') this.awaiting().forEach((id) => this.ctx.window.passed.add(id));
    else if (this.phase === 'block') this.awaiting().forEach((id) => this.ctx.passed.add(id));
    else fail('no open window');
    this.addLog('Time is up; everyone else passes.');
    return this.checkWindowClosed();
  }

  // A player leaves mid-game: all their cards are revealed.
  forfeit(pid) {
    const p = this.player(pid);
    if (this.phase === 'over' || !this.alive(p)) return;
    this.hidden(p).forEach((c) => (c.revealed = true));
    this.addLog(`${p.name} leaves the game and forfeits.`);
    if (this.alivePlayers().length === 1) return this.finish();
    if (this.current().id === pid) {
      // Abandon the forfeiting player's turn entirely.
      if (this.ctx?.drawn) {
        this.deck.push(...this.ctx.drawn);
        shuffle(this.deck, this.rng);
      }
      this.lossQueue = [];
      return this.endTurn();
    }
    if (this.phase === 'action') return;
    if (this.phase === 'lose') return this.runLosses();
    if (this.phase === 'challenge' && this.ctx.window.claimant === pid) {
      // Their block claim is void, so the action goes through.
      this.ctx.window = null;
      return this.step('resolve');
    }
    if (this.phase === 'challenge' || this.phase === 'block') return this.checkWindowClosed();
  }

  // Full private record of a finished game.
  privateRecord() {
    if (this.phase !== 'over') throw new Error('private record requested before game over');
    return { startingHands: this.startingHands, winner: this.player(this.winner).name, events: this.history };
  }

  // ---------- views ----------
  view(pid) {
    const ctx = this.ctx;
    return {
      phase: this.phase,
      turnNumber: this.turnNumber,
      turn: this.current().id,
      deckCount: this.deck.length,
      windowSeq: this.windowSeq,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        coins: p.coins,
        alive: this.alive(p),
        influence: this.hidden(p).length,
        revealed: p.cards.filter((c) => c.revealed).map((c) => c.role),
        ...(p.id === pid ? { hand: this.hidden(p).map((c) => c.role) } : {}),
      })),
      pending: ctx && {
        actor: ctx.actor,
        action: ctx.action,
        target: ctx.target,
        claim: ctx.claim,
        blocker: ctx.blocker,
        blockRole: ctx.blockRole,
        challengeOf: ctx.window ? ctx.window.kind : null,
        canBlockNow: ctx.window ? ctx.window.blockers : [],
      },
      losing: this.phase === 'lose' ? this.lossQueue[0] : null,
      drawn: this.phase === 'exchange' && ctx.actor === pid ? ctx.drawn : null,
      awaiting: this.awaiting(),
      winner: this.winner,
      log: this.log,
    };
  }

  // Total cards must always be 15 with 3 of each role.
  checkInvariants() {
    const all = [...this.deck, ...this.players.flatMap((p) => p.cards.map((c) => c.role)), ...(this.ctx?.drawn ?? [])];
    if (all.length !== 15) throw new Error(`card count ${all.length}`);
    for (const r of ROLES) if (all.filter((x) => x === r).length !== 3) throw new Error(`role count ${r}`);
    for (const p of this.players) if (p.coins < 0) throw new Error(`negative coins ${p.name}`);
  }
}

function normalize(m) {
  switch (m.type) {
    case 'action':
      return m.target ? { type: 'action', action: m.action, target: m.target } : { type: 'action', action: m.action };
    case 'pass':
    case 'challenge':
      return { type: m.type };
    case 'block':
    case 'lose':
      return { type: m.type, role: m.role };
    case 'exchange':
      if (!Array.isArray(m.keep)) fail('exchange needs keep: [roles]');
      return { type: 'exchange', keep: [...m.keep].sort() };
    default:
      fail(`unknown move type ${m.type}`);
  }
}
