// Hull Breach: hidden-loyalty mission game. Loyal crew against hidden saboteurs.
// Pure rules engine. No I/O; every illegal move throws.
import { IllegalMove, fail, shuffle } from './common.js';

export { IllegalMove };

// Players -> [loyal crew, saboteurs]
const TEAM_SPLIT = { 5: [3, 2], 6: [4, 2], 7: [4, 3], 8: [5, 3], 9: [6, 3], 10: [6, 4] };
// Players -> crew size for each of the five missions
const MISSION_SIZES = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};
const MAX_PROPOSALS = 5; // the 5th rejected proposal in a row hands the game to the saboteurs
const WINS_NEEDED = 3;

export const ROLES = {
  crew: { side: 'crew', name: 'Crew', blurb: 'Loyal crew. You know only your own loyalty.' },
  navigator: {
    side: 'crew',
    name: 'Navigator',
    blurb: 'Loyal. You know who the saboteurs are (except the Ghost). Stay hidden: if the crew wins three missions, the Hunter gets one guess at who you are.',
  },
  medic: { side: 'crew', name: 'Medic', blurb: 'Loyal. You can see the Navigator, but the Mimic looks just the same to you.' },
  saboteur: { side: 'saboteurs', name: 'Saboteur', blurb: 'You know your fellow saboteurs (except the Rogue).' },
  hunter: {
    side: 'saboteurs',
    name: 'Hunter',
    blurb: 'A saboteur. If the crew completes three missions, you get one guess at who the Navigator is. Guess right and the saboteurs win.',
  },
  mimic: { side: 'saboteurs', name: 'Mimic', blurb: 'A saboteur who looks like the Navigator to the Medic.' },
  ghost: { side: 'saboteurs', name: 'Ghost', blurb: 'A saboteur hidden from the Navigator.' },
  rogue: {
    side: 'saboteurs',
    name: 'Rogue',
    blurb: "A saboteur working alone: you don't know the other saboteurs and they don't know you. The Navigator can see you.",
  },
};

// Host options: which special roles are in play. The Navigator always comes with the Hunter.
export const OPTION_KEYS = ['navigator', 'medic', 'mimic', 'ghost', 'rogue'];

const isSab = (role) => ROLES[role].side === 'saboteurs';

export class Game {
  static meta = { id: 'hullbreach', title: 'Hull Breach', minPlayers: 5, maxPlayers: 10 };

  static validateOptions(options) {
    for (const [k, v] of Object.entries(options)) {
      if (!OPTION_KEYS.includes(k)) fail(`unknown option ${k} (options: ${OPTION_KEYS.join(', ')})`);
      if (typeof v !== 'boolean') fail(`${k} must be true or false`);
    }
  }

  static defaultOptions() {
    return { navigator: true, medic: false, mimic: false, ghost: false, rogue: false };
  }

  static startIndex(players, lastWinnerIds, randInt) {
    return randInt(players.length);
  }

  static rolesFor(n, o) {
    const split = TEAM_SPLIT[n];
    if (!split) fail(`Hull Breach needs 5-10 players (have ${n})`);
    const [good, bad] = split;
    const goodSpecials = [o.navigator && 'navigator', o.medic && 'medic'].filter(Boolean);
    const badSpecials = [o.navigator && 'hunter', o.mimic && 'mimic', o.ghost && 'ghost', o.rogue && 'rogue'].filter(Boolean);
    if (badSpecials.length > bad)
      fail(`${n} players means ${bad} saboteurs, but ${badSpecials.length} special saboteur roles are on (${badSpecials.join(', ')})`);
    if (goodSpecials.length > good) fail(`too many special crew roles for ${n} players`);
    return [
      ...goodSpecials,
      ...Array(good - goodSpecials.length).fill('crew'),
      ...badSpecials,
      ...Array(bad - badSpecials.length).fill('saboteur'),
    ];
  }

  constructor(players, { rng, startIndex, options }) {
    Game.validateOptions(options);
    const opts = { ...Game.defaultOptions(), ...options };
    const roles = shuffle(Game.rolesFor(players.length, opts), rng);
    if (!(startIndex >= 0 && startIndex < players.length)) fail('bad startIndex');
    this.options = opts;
    this.players = players.map((p, i) => ({ id: p.id, name: p.name, role: roles[i] }));
    this.missions = MISSION_SIZES[players.length].map((size, i) => ({
      size,
      twoFails: players.length >= 7 && i === 3,
      result: null, // 'success' | 'fail'
      fails: null,
      team: null,
    }));
    this.mission = 0;
    this.attempt = 1;
    this.leader = startIndex;
    this.team = null;
    this.votes = new Map();
    this.cards = new Map();
    this.proposals = []; // public record: {mission, attempt, leader, team, votes: {id: bool}, approved}
    this.phase = 'propose';
    this.winnerSide = null;
    this.reason = null;
    this.hunted = null;
    this.log = [];
    this.history = [];
    this.addLog(`Game started with ${players.length} players: ${TEAM_SPLIT[players.length][1]} of them are saboteurs.`);
    this.addLog(this.missionIntro());
  }

  // ---------- helpers ----------
  // note: private detail shown only in the post-game record.
  addLog(text, note = null) {
    this.log.push(text);
    this.history.push({ text, note });
  }
  player(id) {
    const p = this.players.find((x) => x.id === id);
    if (!p) fail(`no player ${id}`);
    return p;
  }
  name(id) {
    return this.player(id).name;
  }
  leaderId() {
    return this.players[this.leader].id;
  }
  hunter() {
    return this.players.find((p) => p.role === 'hunter') ?? null;
  }
  current() {
    return this.missions[this.mission];
  }
  score() {
    return {
      crew: this.missions.filter((m) => m.result === 'success').length,
      saboteurs: this.missions.filter((m) => m.result === 'fail').length,
    };
  }
  missionIntro() {
    const m = this.current();
    return `Mission ${this.mission + 1}: crew of ${m.size}${m.twoFails ? ', needs 2 sabotage cards to fail' : ''}. Proposal ${this.attempt} of ${MAX_PROPOSALS}: ${this.name(this.leaderId())} is captain.`;
  }

  // What player pid knows about everyone else, from their role.
  knowledge(pid) {
    const me = this.player(pid);
    const others = this.players.filter((p) => p.id !== pid);
    if (isSab(me.role) && me.role !== 'rogue')
      return others.filter((p) => isSab(p.role) && p.role !== 'rogue').map((p) => ({ id: p.id, tag: 'saboteur' }));
    if (me.role === 'navigator') return others.filter((p) => isSab(p.role) && p.role !== 'ghost').map((p) => ({ id: p.id, tag: 'saboteur' }));
    if (me.role === 'medic') return others.filter((p) => p.role === 'navigator' || p.role === 'mimic').map((p) => ({ id: p.id, tag: 'navigator?' }));
    return [];
  }

  knowledgeText(pid) {
    const me = this.player(pid);
    const k = this.knowledge(pid).map((x) => this.name(x.id));
    const list = k.join(', ');
    if (me.role === 'medic') {
      if (k.length === 0) return 'There is no Navigator this game.';
      if (k.length === 1) return `${list} is the Navigator.`;
      return `One of ${list} is the Navigator; the other is the Mimic.`;
    }
    if (me.role === 'navigator') return k.length ? `Saboteurs you can see: ${list}.` : 'You can see no saboteurs.';
    if (isSab(me.role) && me.role !== 'rogue') return k.length ? `Your fellow saboteurs: ${list}.` : 'You know of no other saboteurs.';
    return '';
  }

  // ---------- turn flow ----------
  awaiting() {
    switch (this.phase) {
      case 'propose':
        return [this.leaderId()];
      case 'vote':
        return this.players.filter((p) => !this.votes.has(p.id)).map((p) => p.id);
      case 'mission':
        return this.team.filter((id) => !this.cards.has(id));
      case 'hunt':
        return [this.hunter().id];
      case 'over':
        return [];
      default:
        throw new Error(`unknown phase ${this.phase}`);
    }
  }

  legalMoves(pid) {
    if (!this.awaiting().includes(pid)) return [];
    switch (this.phase) {
      case 'propose':
        // Too many teams to list; this is a template the client fills in.
        return [{ type: 'propose', size: this.current().size, choices: this.players.map((p) => p.id) }];
      case 'vote':
        return [
          { type: 'vote', approve: true },
          { type: 'vote', approve: false },
        ];
      case 'mission':
        return isSab(this.player(pid).role)
          ? [
              { type: 'mission', card: 'success' },
              { type: 'mission', card: 'sabotage' },
            ]
          : [{ type: 'mission', card: 'success' }];
      case 'hunt':
        return this.players.filter((p) => p.id !== pid).map((p) => ({ type: 'hunt', target: p.id }));
      default:
        throw new Error(`no moves in phase ${this.phase}`);
    }
  }

  describeMove(pid, m) {
    switch (m.type) {
      case 'propose':
        return `Propose a crew of ${m.size} for mission ${this.mission + 1}`;
      case 'vote':
        return m.approve ? 'Approve the proposed crew' : 'Reject the proposed crew';
      case 'mission':
        return m.card === 'success' ? 'Play SUCCESS' : 'Play SABOTAGE';
      case 'hunt':
        return `Name ${this.name(m.target)} as the Navigator`;
      default:
        throw new Error(`unknown move ${m.type}`);
    }
  }

  apply(pid, move) {
    if (this.phase === 'over') fail('game is over');
    if (!this.awaiting().includes(pid)) fail('not waiting on you');
    if (!move || typeof move.type !== 'string') fail('move must have a type');
    if (move.type === 'propose') {
      if (this.phase !== 'propose') fail('not proposing now');
      return this.propose(move.team);
    }
    const key = (m) => JSON.stringify(m);
    const norm = normalize(move);
    if (!this.legalMoves(pid).some((m) => key(m) === key(norm))) fail(`illegal move: ${JSON.stringify(move)}`);
    switch (norm.type) {
      case 'vote':
        return this.vote(pid, norm.approve);
      case 'mission':
        return this.playCard(pid, norm.card);
      case 'hunt':
        return this.hunt(norm.target);
      default:
        throw new Error('unreachable');
    }
  }

  propose(team) {
    const size = this.current().size;
    if (!Array.isArray(team)) fail('team must be a list of player ids');
    if (new Set(team).size !== team.length) fail('team has duplicates');
    if (team.length !== size) fail(`mission ${this.mission + 1} needs exactly ${size} crew`);
    team.forEach((id) => this.player(id));
    this.team = [...team];
    this.votes = new Map();
    this.phase = 'vote';
    this.addLog(`${this.name(this.leaderId())} proposes ${team.map((id) => this.name(id)).join(', ')} for mission ${this.mission + 1}.`);
  }

  vote(pid, approve) {
    this.votes.set(pid, approve);
    if (this.votes.size < this.players.length) return;
    const votes = Object.fromEntries(this.players.map((p) => [p.id, this.votes.get(p.id)]));
    const yes = this.players.filter((p) => votes[p.id]);
    const no = this.players.filter((p) => !votes[p.id]);
    const approved = yes.length > no.length;
    this.proposals.push({ mission: this.mission, attempt: this.attempt, leader: this.leaderId(), team: this.team, votes, approved });
    const names = (ps) => ps.map((p) => p.name).join(', ') || 'nobody';
    this.addLog(`${approved ? 'Approved' : 'Rejected'} ${yes.length}–${no.length}. Approve: ${names(yes)}. Reject: ${names(no)}.`);
    this.votes = new Map();
    if (approved) {
      this.cards = new Map();
      this.phase = 'mission';
      this.addLog(`${this.team.map((id) => this.name(id)).join(', ')} go on mission ${this.mission + 1}.`);
      return;
    }
    this.team = null;
    if (this.attempt === MAX_PROPOSALS) return this.finish('saboteurs', `${MAX_PROPOSALS} crews in a row were rejected`);
    this.attempt++;
    this.nextLeader();
    this.phase = 'propose';
    this.addLog(this.missionIntro());
  }

  playCard(pid, card) {
    this.cards.set(pid, card);
    if (this.cards.size < this.team.length) return;
    const m = this.current();
    const saboteurs = this.team.filter((id) => this.cards.get(id) === 'sabotage');
    m.fails = saboteurs.length;
    m.team = this.team;
    m.result = m.fails >= (m.twoFails ? 2 : 1) ? 'fail' : 'success';
    this.addLog(
      `Mission ${this.mission + 1} ${m.result === 'success' ? 'succeeded' : 'FAILED'} with ${m.fails} sabotage card${m.fails === 1 ? '' : 's'}.`,
      saboteurs.length ? `Sabotage played by: ${saboteurs.map((id) => this.name(id)).join(', ')}.` : 'Nobody played sabotage.',
    );
    this.team = null;
    this.cards = new Map();
    const s = this.score();
    if (s.saboteurs === WINS_NEEDED) return this.finish('saboteurs', 'three missions failed');
    if (s.crew === WINS_NEEDED) {
      const h = this.hunter();
      if (!h) return this.finish('crew', 'three missions succeeded');
      this.phase = 'hunt';
      this.addLog(`The crew has completed three missions! ${h.name} reveals they are the Hunter and must name the Navigator.`);
      return;
    }
    this.mission++;
    this.attempt = 1;
    this.nextLeader();
    this.phase = 'propose';
    this.addLog(this.missionIntro());
  }

  hunt(target) {
    this.hunted = target;
    const t = this.player(target);
    this.addLog(`The Hunter names ${t.name} as the Navigator.`);
    if (t.role === 'navigator') return this.finish('saboteurs', `the Hunter found the Navigator (${t.name})`);
    return this.finish('crew', `three missions succeeded and the Hunter guessed wrong (${t.name} is ${ROLES[t.role].name})`);
  }

  nextLeader() {
    this.leader = (this.leader + 1) % this.players.length;
  }

  finish(side, reason) {
    this.winnerSide = side;
    this.reason = reason;
    this.phase = 'over';
    this.team = null;
    this.addLog(`${side === 'crew' ? 'The crew wins' : 'The saboteurs win'}: ${reason}.`);
    this.addLog(`Roles: ${this.players.map((p) => `${p.name} ${ROLES[p.role].name}`).join(', ')}.`);
  }

  // A seat can't be removed from a hidden-team game, so leaving ends it with no winner.
  forfeit(pid) {
    if (this.phase === 'over') return;
    this.winnerSide = null;
    this.reason = `${this.name(pid)} left`;
    this.phase = 'over';
    this.team = null;
    this.addLog(`${this.name(pid)} left, so this game is abandoned.`);
    this.addLog(`Roles: ${this.players.map((p) => `${p.name} ${ROLES[p.role].name}`).join(', ')}.`);
  }

  // ---------- common engine interface ----------
  winners() {
    if (!this.winnerSide) return [];
    return this.players.filter((p) => ROLES[p.role].side === this.winnerSide).map((p) => p.id);
  }
  resultText() {
    if (!this.winnerSide) return `Abandoned (${this.reason}).`;
    return `${this.winnerSide === 'crew' ? 'Crew' : 'Saboteurs'} won: ${this.reason}.`;
  }
  situationKey() {
    return `${this.phase}:${this.mission}:${this.attempt}`;
  }
  timedWindow() {
    return null;
  }
  expireWindow() {
    throw new Error('Hull Breach has no timed windows');
  }

  situation(pid) {
    const who = this.awaiting().map((id) => this.name(id)).join(', ');
    const leader = this.name(this.leaderId());
    switch (this.phase) {
      case 'propose':
        return {
          text: this.leaderId() === pid ? `You are captain: choose ${this.current().size} crew for mission ${this.mission + 1}.` : `${leader} is choosing a crew of ${this.current().size} for mission ${this.mission + 1}.`,
          sub: `Proposal ${this.attempt} of ${MAX_PROPOSALS}${this.attempt === MAX_PROPOSALS ? ': if this one is rejected, the saboteurs win.' : '.'}`,
        };
      case 'vote':
        return { text: `Vote on ${leader}'s crew: ${this.team.map((id) => this.name(id)).join(', ')}.`, sub: `Waiting on ${who}.` };
      case 'mission':
        return { text: `Mission ${this.mission + 1} is under way.`, sub: `Waiting on ${who} to play a card.` };
      case 'hunt':
        return { text: `${this.hunter().name} (Hunter) must name the Navigator.` };
      case 'over':
        return { text: this.winnerSide ? `🏆 ${this.resultText()}` : this.resultText() };
      default:
        throw new Error(`unknown phase ${this.phase}`);
    }
  }

  textView(pid) {
    const lines = [];
    const me = this.players.find((p) => p.id === pid);
    if (me) {
      const r = ROLES[me.role];
      lines.push(`You are ${me.name}, the ${r.name} (${r.side === 'crew' ? 'loyal crew' : 'SABOTEUR'}). ${r.blurb}`);
      const k = this.knowledgeText(pid);
      if (k) lines.push(`What you know: ${k}`);
    }
    lines.push(`Special roles in play: ${this.specialRoles().join(', ') || 'none'}.`);
    const s = this.score();
    lines.push(`Missions: ${this.missions.map((m, i) => `${i + 1}:${m.result === 'success' ? 'OK' : m.result === 'fail' ? `FAIL(${m.fails})` : `${m.size}${m.twoFails ? '*' : ''}`}`).join('  ')}   Score: crew ${s.crew}, saboteurs ${s.saboteurs}. (* needs 2 sabotage cards)`);
    lines.push(`Seats (clockwise): ${this.players.map((p) => `${p.name}${p.id === this.leaderId() && this.phase !== 'over' ? ' [captain]' : ''}${this.phase === 'over' ? ` (${ROLES[p.role].name})` : ''}`).join(', ')}`);
    if (this.team) lines.push(`Proposed crew: ${this.team.map((id) => this.name(id)).join(', ')}.`);
    if (this.phase === 'vote') lines.push(`Votes in: ${this.votes.size}/${this.players.length}. Still to vote: ${this.awaiting().map((id) => this.name(id)).join(', ')}.`);
    if (this.proposals.length) {
      lines.push('Vote history (Y = approve, n = reject):');
      for (const pr of this.proposals) {
        const v = this.players.map((p) => `${p.name}:${pr.votes[p.id] ? 'Y' : 'n'}`).join(' ');
        const m = this.missions[pr.mission];
        const outcome = pr.approved ? (m.team === pr.team && m.result ? ` -> mission ${m.result === 'success' ? 'OK' : `FAILED (${m.fails})`}` : ' -> approved') : ' -> rejected';
        lines.push(`  M${pr.mission + 1}.${pr.attempt} captain ${this.name(pr.leader)}, crew [${pr.team.map((id) => this.name(id)).join(', ')}]: ${v}${outcome}`);
      }
    }
    return lines;
  }

  specialRoles() {
    const o = this.options;
    return [o.navigator && 'Navigator', o.navigator && 'Hunter', o.medic && 'Medic', o.mimic && 'Mimic', o.ghost && 'Ghost', o.rogue && 'Rogue'].filter(Boolean);
  }

  view(pid) {
    const me = this.players.find((p) => p.id === pid);
    const over = this.phase === 'over';
    return {
      kind: 'hullbreach',
      phase: this.phase,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        voted: this.phase === 'vote' && this.votes.has(p.id),
        played: this.phase === 'mission' && this.cards.has(p.id),
        role: over ? p.role : null,
      })),
      you: me && {
        role: me.role,
        roleName: ROLES[me.role].name,
        side: ROLES[me.role].side,
        blurb: ROLES[me.role].blurb,
        knows: this.knowledge(pid),
        knowsText: this.knowledgeText(pid),
      },
      roleNames: Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [k, r.name])),
      specialRoles: this.specialRoles(),
      missions: this.missions.map((m) => ({ size: m.size, twoFails: m.twoFails, result: m.result, fails: m.fails })),
      mission: this.mission,
      attempt: this.attempt,
      maxProposals: MAX_PROPOSALS,
      leader: this.leaderId(),
      team: this.team,
      proposals: this.proposals,
      hunter: this.phase === 'hunt' || over ? (this.hunter()?.id ?? null) : null,
      hunted: this.hunted,
      winnerSide: this.winnerSide,
      reason: this.reason,
      awaiting: this.awaiting(),
      log: this.log,
    };
  }

  privateRecord() {
    if (this.phase !== 'over') throw new Error('private record requested before game over');
    return {
      result: this.resultText(),
      roles: this.players.map((p) => ({ name: p.name, role: ROLES[p.role].name, side: ROLES[p.role].side })),
      events: this.history,
    };
  }

  checkInvariants() {
    const s = this.score();
    if (s.crew > WINS_NEEDED || s.saboteurs > WINS_NEEDED) throw new Error('score overflow');
    if (this.attempt < 1 || this.attempt > MAX_PROPOSALS) throw new Error(`attempt ${this.attempt}`);
    const [good, bad] = TEAM_SPLIT[this.players.length];
    if (this.players.filter((p) => isSab(p.role)).length !== bad) throw new Error('saboteur count');
    if (this.players.filter((p) => !isSab(p.role)).length !== good) throw new Error('crew count');
  }
}

function normalize(m) {
  switch (m.type) {
    case 'vote':
      return { type: 'vote', approve: m.approve };
    case 'mission':
      return { type: 'mission', card: m.card };
    case 'hunt':
      return { type: 'hunt', target: m.target };
    default:
      fail(`unknown move type ${m.type}`);
  }
}
