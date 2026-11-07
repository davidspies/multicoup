import { randomBytes, randomInt } from 'node:crypto';
import { IllegalMove } from './games/common.js';
import { GAMES } from './games/index.js';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const rng = () => randomInt(2 ** 32) / 2 ** 32;
const SETTING_LIMITS = { responseTimeoutSec: [0, 3600], autoNextSec: [0, 3600] };

export class Room {
  constructor(code, kind) {
    this.code = code;
    this.kind = kind;
    this.Engine = GAMES[kind];
    this.options = this.Engine.defaultOptions();
    this.members = []; // seating order: {id, name, token, wins, played}
    this.nextId = 1;
    this.hostId = null;
    this.game = null;
    this.gameNumber = 0;
    this.gamePlayerIds = [];
    this.lastWinners = [];
    this.results = [];
    this.records = new Map(); // gameNumber -> private record of a finished game
    this.chat = [];
    this.chatSeq = 0;
    this.settings = { ...config.roomDefaults };
    this.version = 0;
    this.waiters = new Set();
    this.windowTimer = null;
    this.windowTimerSeq = null;
    this.deadline = null;
    this.nextTimer = null;
    this.nextAt = null;
    this.touched = Date.now();
    // Narrator controls. The key is shown only to the host, who hands it to a narrator.
    this.narratorKey = randomBytes(18).toString('base64url');
    this.paused = false;
    this.stepMode = false;
    this.held = false; // step mode: holding at a new situation until the narrator advances
    this.holdKey = null;
  }

  gated() {
    return this.paused || this.held;
  }

  situationKey() {
    const g = this.game;
    return g && `${this.gameNumber}:${g.situationKey()}`;
  }

  // In step mode, hold whenever the game reaches a new situation (not on every single pass).
  maybeHold() {
    if (!this.stepMode || !this.game) return;
    const key = this.situationKey();
    if (key !== this.holdKey) {
      this.holdKey = key;
      this.held = true;
    }
  }

  setNarration(patch) {
    if (!patch || typeof patch !== 'object') throw new HttpError(400, 'body must be an object');
    for (const [k, v] of Object.entries(patch)) {
      if (!['paused', 'stepMode'].includes(k)) throw new HttpError(400, `unknown narrator setting ${k}`);
      if (typeof v !== 'boolean') throw new HttpError(400, `${k} must be true or false`);
    }
    if ('paused' in patch && patch.paused !== this.paused) {
      this.paused = patch.paused;
      this.system(this.paused ? 'The narrator paused the game.' : 'The narrator resumed the game.');
    }
    if ('stepMode' in patch && patch.stepMode !== this.stepMode) {
      this.stepMode = patch.stepMode;
      this.held = false;
      this.holdKey = null;
      this.system(this.stepMode ? 'Step mode on: the game waits for the narrator at each new decision.' : 'Step mode off.');
    }
    this.afterGameChange();
    this.changed();
  }

  // Private record of a finished game. Defaults to the most recent one.
  reveal(gameParam) {
    if (!this.records.size) throw new HttpError(409, 'no game has finished yet');
    const n = gameParam === null ? [...this.records.keys()].at(-1) : Number(gameParam);
    if (!Number.isInteger(n)) throw new HttpError(400, 'game must be a game number');
    if (n === this.gameNumber && this.inProgress()) throw new HttpError(409, `game ${n} is still in progress`);
    const rec = this.records.get(n);
    if (!rec) throw new HttpError(404, `no record of game ${n} (kept: ${[...this.records.keys()].join(', ')})`);
    return rec;
  }

  advance() {
    if (!this.held) throw new HttpError(409, 'the game is not waiting on the narrator');
    this.held = false;
    this.afterGameChange();
    this.changed();
  }

  member(id) {
    const m = this.members.find((x) => x.id === id);
    if (!m) throw new HttpError(404, `no player ${id} in room`);
    return m;
  }
  byToken(token) {
    const m = this.members.find((x) => x.token === token);
    if (!m) throw new HttpError(403, 'invalid token for this room');
    return m;
  }
  inProgress() {
    return this.game !== null && this.game.phase !== 'over';
  }

  join(rawName) {
    const name = String(rawName ?? '').trim();
    if (!name || name.length > 24) throw new HttpError(400, 'name must be 1-24 characters');
    const seats = this.Engine.meta.maxPlayers;
    if (this.members.length >= seats) throw new HttpError(409, `room is full (${seats} seats)`);
    if (this.members.some((m) => m.name.toLowerCase() === name.toLowerCase()))
      throw new HttpError(409, `name "${name}" is taken in this room`);
    const m = { id: `p${this.nextId++}`, name, token: randomBytes(18).toString('base64url'), wins: 0, played: 0 };
    this.members.push(m);
    if (!this.hostId) this.hostId = m.id;
    this.system(`${name} joined.`);
    this.changed();
    return m;
  }

  leave(id) {
    const m = this.member(id);
    if (this.inProgress() && this.gamePlayerIds.includes(id)) this.game.forfeit(id);
    this.members = this.members.filter((x) => x.id !== id);
    if (this.hostId === id) this.hostId = this.members[0]?.id ?? null;
    this.system(`${m.name} left.`);
    this.afterGameChange();
    this.changed();
  }

  kick(byId, id) {
    this.requireHost(byId);
    if (byId === id) throw new HttpError(400, 'use leave to remove yourself');
    this.leave(id);
  }

  requireHost(id) {
    if (id !== this.hostId) throw new HttpError(403, 'only the host can do that');
  }

  start(byId) {
    this.requireHost(byId);
    this.startGame();
  }

  startGame() {
    if (this.inProgress()) throw new HttpError(409, 'a game is already in progress');
    const min = this.Engine.meta.minPlayers;
    if (this.members.length < min) throw new HttpError(409, `need at least ${min} players`);
    this.clearNextTimer();
    const players = this.members.map((m) => ({ id: m.id, name: m.name }));
    const startIndex = this.Engine.startIndex(players, this.lastWinners, randomInt);
    try {
      this.game = new this.Engine(players, { rng, startIndex, options: this.options });
    } catch (e) {
      if (e instanceof IllegalMove) throw new HttpError(409, e.message);
      throw e;
    }
    this.gameNumber++;
    this.gamePlayerIds = players.map((p) => p.id);
    this.members.forEach((m) => m.played++);
    this.system(`Game ${this.gameNumber} started with ${players.length} players.`);
    this.afterGameChange();
    this.changed();
  }

  act(id, move) {
    if (!this.game) throw new HttpError(409, 'no game has started');
    if (this.gated()) throw new HttpError(409, 'the narrator is holding the game; wait for it to continue');
    try {
      this.game.apply(id, move);
    } catch (e) {
      if (e instanceof IllegalMove) throw new HttpError(400, e.message);
      throw e;
    }
    this.afterGameChange();
    this.changed();
  }

  say(id, rawText) {
    const text = String(rawText ?? '').trim();
    if (!text || text.length > 500) throw new HttpError(400, 'message must be 1-500 characters');
    this.pushChat(this.member(id).name, text);
    this.changed();
  }

  system(text) {
    this.pushChat(null, text);
  }

  pushChat(from, text) {
    this.chat.push({ seq: ++this.chatSeq, from, text, at: Date.now() });
    if (this.chat.length > config.chatHistory) this.chat.shift();
  }

  // Game options (e.g. Hull Breach's special roles); validated by the engine, checked fully at start.
  updateOptions(byId, patch) {
    this.requireHost(byId);
    if (!patch || typeof patch !== 'object') throw new HttpError(400, 'options must be an object');
    const next = { ...this.options, ...patch };
    try {
      this.Engine.validateOptions(next);
    } catch (e) {
      if (e instanceof IllegalMove) throw new HttpError(400, e.message);
      throw e;
    }
    this.options = next;
    this.system(`Game options: ${Object.entries(next).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}.`);
    this.changed();
  }

  updateSettings(byId, patch) {
    this.requireHost(byId);
    if (!patch || typeof patch !== 'object') throw new HttpError(400, 'settings must be an object');
    for (const [k, v] of Object.entries(patch)) {
      const lim = SETTING_LIMITS[k];
      if (!lim) throw new HttpError(400, `unknown setting ${k}`);
      if (!Number.isInteger(v) || v < lim[0] || v > lim[1]) throw new HttpError(400, `${k} must be an integer in [${lim}]`);
    }
    Object.assign(this.settings, patch);
    this.system(`Settings: response timeout ${this.settings.responseTimeoutSec || 'off'}, auto-next ${this.settings.autoNextSec || 'off'}.`);
    this.windowTimerSeq = null; // re-arm with new timeout
    this.afterGameChange();
    this.changed();
  }

  // Record results and (re)arm timers after anything that changes the game.
  afterGameChange() {
    const g = this.game;
    if (!g) return;
    if (g.phase === 'over' && !this.results.some((r) => r.gameNumber === this.gameNumber)) {
      const winners = g.winners();
      this.members.filter((m) => winners.includes(m.id)).forEach((m) => m.wins++);
      this.lastWinners = winners;
      this.results.push({ gameNumber: this.gameNumber, winners, text: g.resultText() });
      this.records.set(this.gameNumber, { gameNumber: this.gameNumber, ...g.privateRecord() });
      if (this.records.size > config.revealHistory) this.records.delete(this.records.keys().next().value);
      this.system(`Game ${this.gameNumber}: ${g.resultText()}`);
    }
    this.maybeHold();
    if (this.gated()) {
      // Nothing may time out while the narrator holds the game.
      this.clearWindowTimer();
      this.clearNextTimer();
      return;
    }
    const win = g.timedWindow();
    if (win === null || !this.settings.responseTimeoutSec) {
      this.clearWindowTimer();
    } else if (this.windowTimerSeq !== win) {
      this.clearWindowTimer();
      const seq = win;
      const ms = this.settings.responseTimeoutSec * 1000;
      this.windowTimerSeq = seq;
      this.deadline = Date.now() + ms;
      this.windowTimer = setTimeout(() => {
        this.windowTimer = null;
        if (this.game !== g || g.timedWindow() !== seq) return;
        g.expireWindow();
        this.afterGameChange();
        this.changed();
      }, ms);
    }
    const enough = this.members.length >= this.Engine.meta.minPlayers;
    if (g.phase === 'over' && this.settings.autoNextSec && !this.nextTimer && enough) {
      const ms = this.settings.autoNextSec * 1000;
      this.nextAt = Date.now() + ms;
      this.nextTimer = setTimeout(() => {
        this.nextTimer = null;
        this.nextAt = null;
        if (!this.inProgress() && !this.gated() && this.members.length >= this.Engine.meta.minPlayers) this.startGame();
      }, ms);
    }
    if (this.nextTimer && (!this.settings.autoNextSec || !enough)) this.clearNextTimer();
  }

  clearWindowTimer() {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
    this.windowTimerSeq = null;
    this.deadline = null;
  }
  clearNextTimer() {
    if (this.nextTimer) clearTimeout(this.nextTimer);
    this.nextTimer = null;
    this.nextAt = null;
  }

  changed() {
    this.version++;
    this.touched = Date.now();
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  // Resolves once version > since, or after ms.
  waitForChange(since, ms) {
    if (this.version > since) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  // What anyone at the table can see: no hands, no drawn cards, no tokens.
  publicView() {
    const { you, legal, canStart, narratorKey, ...rest } = this.view(null);
    return rest;
  }

  view(id) {
    const g = this.game;
    const isHost = id !== null && id === this.hostId;
    const seated = g && this.gamePlayerIds.includes(id);
    const viewer = seated ? id : null;
    const legal = seated && !this.gated() ? g.legalMoves(id).map((m) => ({ ...m, label: g.describeMove(id, m) })) : [];
    const meta = this.Engine.meta;
    return {
      version: this.version,
      code: this.code,
      kind: this.kind,
      title: meta.title,
      minPlayers: meta.minPlayers,
      maxPlayers: meta.maxPlayers,
      options: this.options,
      you: id,
      hostId: this.hostId,
      settings: this.settings,
      members: this.members.map((m) => ({
        id: m.id,
        name: m.name,
        wins: m.wins,
        played: m.played,
        inGame: this.inProgress() && this.gamePlayerIds.includes(m.id),
      })),
      gameNumber: this.gameNumber,
      inProgress: this.inProgress(),
      game: g && g.view(viewer),
      situation: g && g.situation(viewer),
      text: g && g.textView(viewer),
      legal,
      canStart: isHost && !this.inProgress() && this.members.length >= meta.minPlayers,
      narrator: { paused: this.paused, stepMode: this.stepMode, held: this.held },
      narratorKey: isHost ? this.narratorKey : null,
      responseDeadline: this.deadline,
      nextGameAt: this.nextAt,
      results: this.results,
      chat: this.chat,
    };
  }
}

export class Lobby {
  constructor() {
    this.rooms = new Map();
  }
  create(kind) {
    if (!Object.hasOwn(GAMES, kind)) throw new HttpError(400, `game must be one of: ${Object.keys(GAMES).join(', ')}`);
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code;
    do code = Array.from({ length: 4 }, () => letters[randomInt(letters.length)]).join('');
    while (this.rooms.has(code));
    const room = new Room(code, kind);
    this.rooms.set(code, room);
    return room;
  }
  get(code) {
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) throw new HttpError(404, `no room ${code}`);
    return room;
  }
  sweep() {
    const cutoff = Date.now() - config.roomIdleHours * 3600e3;
    for (const [code, room] of this.rooms) {
      if (room.touched < cutoff) {
        room.clearWindowTimer();
        room.clearNextTimer();
        this.rooms.delete(code);
      }
    }
  }
}
