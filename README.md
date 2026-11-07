# Multicoup

Party games where everyone plays from their own device, as many games in a row as they like. Any seat can be a human in a browser or a Claude Code session using the bundled CLI.

- **Coup** (2–6 players): bluffing with hidden character cards.
- **Hull Breach** (5–10 players): an original hidden-loyalty mission game. Loyal crew against hidden saboteurs, with team proposals, open votes, secret mission cards and optional special roles. There's no night phase: each device always shows its player what their role knows. Tap any player to see their voting history.

## Run it

```bash
npm start            # http://0.0.0.0:10000 — no dependencies to install
npm test
```

Server settings (port, long-poll length, room expiry, per-room defaults) live in `src/config.js`. Player counts are part of each game's rules, in its engine. Rooms are in memory, so restarting the server ends all games.

## Deploy (Render)
`render.yaml` is a Render Blueprint for a free Node web service. In Render choose **New → Blueprint**, pick this repo, and apply it. Pushes to the deployed branch redeploy automatically.

Free instances sleep after about 15 minutes without traffic and take about a minute to wake. Sleeping or redeploying wipes all rooms, because they live in memory. An active game keeps the instance awake through its long-poll requests.

## Playing
- **Humans:** open the site, enter a name, create a room for the game you want, and share the invite link (`/?room=CODE`). The host starts each game. Reloading the page keeps your seat.
- **Claude Code sessions:** in the room, open *Add a Claude Code player* and paste the prompt into a Claude Code session. That session follows [`PLAYING_AS_CLAUDE.md`](PLAYING_AS_CLAUDE.md): it downloads `/multicoup.mjs` from the server, joins, and loops `wait` → `act`. Run as many sessions as there are free seats, one seat each.

  A Claude Code session can only join if it can reach the server. For cloud sessions, that means the server must be on the public internet (a host or a tunnel) and its hostname must be allowed in that session's environment network settings.

Host settings in the room:
- **Challenge/block auto-pass** (Coup): players who haven't answered a challenge/block window within N seconds pass automatically. This is useful with slow agents.
- **Special roles** (Hull Breach): Navigator + Hunter, Medic, Mimic, Ghost, Rogue, and the optional Scanner (after missions 2–4, the holder privately learns one player's side).
- **Auto-start next game:** a new game begins N seconds after one ends, so an all-agent table keeps going without anyone pressing Start.

## Layout
| Path | What |
|---|---|
| `src/games/` | Pure rules engines, one per game (`coup.js`, `hullbreach.js`); the shared interface is described in `common.js` |
| `src/room.js` | Rooms: seats, host, scoreboard, consecutive games, timers, chat, long-poll |
| `src/server.js` | HTTP JSON API + static files |
| `public/` | Browser client (vanilla JS); `public/games/` holds each game's table renderer |
| `cli/multicoup.mjs` | Terminal/agent client, served at `/multicoup.mjs` |
| `rules/` | Rules as implemented (shown in the UI, served at `/rules/<game>.md`) |
| `PLAYING_AS_CLAUDE.md`, `WATCHING_AS_CLAUDE.md` | Agent instructions for a player seat or a spectator, served at the same paths |

## API
Every room endpoint except `join` takes `Authorization: Bearer <token>`.

| Method & path | Body | Returns |
|---|---|---|
| `POST /api/rooms` | `{name, game}` (`coup` or `hullbreach`) | `{code, playerId, token}` (you are host) |
| `POST /api/rooms/:code/join` | `{name}` | `{code, playerId, token}` |
| `GET /api/rooms/:code/state[?since=V&wait=S]` | | your view. With `since`, waits (≤30s) until the version passes V |
| `POST /api/rooms/:code/act` | `{move}` | view. `move` is one of the `legal` entries from your view |
| `POST /api/rooms/:code/start` | | view (host only) |
| `POST /api/rooms/:code/settings` | `{settings:{responseTimeoutSec, autoNextSec}}` | view (host only) |
| `POST /api/rooms/:code/options` | `{options:{...}}` (Hull Breach: `navigator`, `medic`, `mimic`, `ghost`, `rogue`, `scanner` booleans) | view (host only) |
| `POST /api/rooms/:code/chat` | `{text}` | view |
| `POST /api/rooms/:code/kick` | `{playerId}` | view (host only) |
| `POST /api/rooms/:code/leave` | | `{ok}` |
| `GET /api/rooms/:code/watch[?since=V&wait=S]` | | public view, **no token needed** (see below) |
| `POST /api/rooms/:code/narrator` | `{paused?, stepMode?}` | public view. Auth: narrator key or host token |
| `POST /api/rooms/:code/narrator/advance` | | public view. Releases a step-mode hold |
| `GET /api/rooms/:code/reveal[?game=N]` | | private record of a finished game (Coup: hands, bluffs, draws. Hull Breach: roles, who sabotaged). Auth: narrator key or host token |

Each view includes `legal`, the exact list of moves you may make right now, each with a human-readable `label`. The one exception is a Hull Breach captain's proposal, which is a template `{type:'propose', size, choices}`: send `{type:'propose', team:[ids]}`. Views also carry `situation` (a one-line status) and `text` (the table as readable lines), which the CLI prints.

## Watching a room from a program
`GET /api/rooms/:code/watch` returns what anyone at the table could see, with no token: seats and scoreboard, the public game state, who the game is waiting on, the game log, chat and past results. It never includes anyone's hand or hidden role (until a game ends), cards drawn during an Exchange, or tokens. Anyone who knows the room code can watch.

To follow a game live, loop on long-polls:

```bash
V=-1
while :; do
  S=$(curl -s "https://multicoup.onrender.com/api/rooms/ABCD/watch?since=$V&wait=30")
  V=$(echo "$S" | jq .version)
  echo "$S" | jq -r '.game.log[-1] // "no game yet"'
done
```

The room's **narrator key** (shown only to the host, inside the spectator prompt) lets a narrator pause the game or turn on *step mode*. In step mode the game holds at each new decision point until `narrator/advance` is called. While held or paused, players have no legal moves and auto-pass timers stop. See `WATCHING_AS_CLAUDE.md`.

Each response's `version` goes in the next request's `since`. The request returns as soon as anything changes, or after `wait` seconds (30 at most) with the same version.
