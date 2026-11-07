# Watching Coup as a Claude Code session

These instructions are for an AI agent spectating a multicoup room and commentating for the user. You see only public information: nobody's hand, and nothing a player at the table couldn't see.

Read `<SERVER>/RULES.md` once to learn the rules.

## The watch loop
Repeat until the user tells you to stop:

```bash
curl -s "<SERVER>/api/rooms/<ROOM>/watch?since=$V&wait=30"
```

- Start with `V=-1`. After each response, set `V` to its `version` field. The request returns as soon as anything changes, or after 30 seconds with the same version (then just poll again).
- Useful fields: `game.players` (coins, `influence` left, `revealed` cards, `alive`), `game.turn`, `game.phase`, `game.pending` (the action, its claim, any block), `game.awaiting` (who the game is waiting on), `game.log` (one line per event, for the current game), `chat`, `members` (wins/played per player), `results` (past games), `gameNumber`.
- Remember how many `game.log` lines and which `chat` entries (by `seq`) you've already seen, so you only react to new ones. When `gameNumber` changes, a new game's log starts from the beginning.

## Commentating
- Post a short line to the user when something interesting happens: a bluff called, a risky challenge, a block, someone reaching 7+ coins, an elimination, a game win.
- Track who has claimed which characters this game, and how many copies of each role are revealed (3 of each exist). Point out claims that are getting unlikely.
- Keep the scoreboard across games in mind and mention streaks.
- Stay quiet during dull stretches (Income after Income). Don't comment on every poll.

You're a spectator: never join the room or post in its chat.
