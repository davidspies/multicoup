# Watching Coup as a Claude Code session

These instructions are for an AI agent spectating a multicoup room and commentating (or narrating) for the user. You see only public information: nobody's hand, and nothing a player at the table couldn't see.

Read `<SERVER>/RULES.md` once to learn the rules.

## The watch loop
Repeat until the user tells you to stop:

```bash
curl -s "<SERVER>/api/rooms/<ROOM>/watch?since=$V&wait=30"
```

- Start with `V=-1`. After each response, set `V` to its `version` field. The request returns as soon as anything changes, or after 30 seconds with the same version (then just poll again).
- Useful fields: `game.players` (coins, `influence` left, `revealed` cards, `alive`), `game.turn`, `game.phase`, `game.pending` (the action, its claim, any block), `game.awaiting` (who the game is waiting on), `game.log` (one line per event, for the current game), `chat`, `members` (wins/played per player), `results` (past games), `gameNumber`.
- Remember how many `game.log` lines and which `chat` entries (by `seq`) you've already seen, so you only react to new ones. When `gameNumber` changes, a new game's log starts from the beginning.

## Reading the log: challenges and replaced cards
When a challenged player really has the card, the log shows two lines:

1. `X shows Duke: the claim was true, so Y's challenge fails.` Y then loses an influence (a separate `Y loses ...` line).
2. `X shuffles that Duke back into the court deck and draws a face-down replacement. It is not lost: ...`

So the shown card is **not** revealed or lost. It goes back into the deck, X keeps the same number of cards, and X's new card is unknown. Don't count it among the revealed cards (`game.players[].revealed` only lists lost cards), and don't assume X still holds that role afterwards. Only `X loses <Role>` lines put a card face up for good.

When a challenged player does **not** have the card, the log says `X does not have Duke. The challenge succeeds.` and X loses an influence.

## Commentating
- Post a short line to the user when something interesting happens: a bluff called, a risky challenge, a block, someone reaching 7+ coins, an elimination, a game win.
- Track who has claimed which characters this game, and how many copies of each role are revealed (3 of each exist). Point out claims that are getting unlikely.
- Keep the scoreboard across games in mind and mention streaks.
- Stay quiet during dull stretches (Income after Income). Don't comment on every poll.

You're a spectator: never join the room or post in its chat.

## Narrating (only if you were given a narrator key)
The narrator key lets you control the game's pace. Send it as `Authorization: Bearer <KEY>`:

```bash
# Make the game wait at each new decision point until you continue it:
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"stepMode": true}' "<SERVER>/api/rooms/<ROOM>/narrator"
# Continue past the current hold:
curl -s -X POST -H "Authorization: Bearer $KEY" "<SERVER>/api/rooms/<ROOM>/narrator/advance"
# Pause / resume everything:
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"paused": true}' "<SERVER>/api/rooms/<ROOM>/narrator"
```

### Post-game reveal
After a game ends, the narrator key also unlocks that game's **private record**: everyone's starting hands, and for every log line, each player's hand at that moment plus a private note. The note marks every character claim (action or block) as `HONEST:` or `BLUFF:`, and says which replacement card a proven player drew and what an Exchange drew, kept and returned.

```bash
curl -s -H "Authorization: Bearer $KEY" "<SERVER>/api/rooms/<ROOM>/reveal"          # most recent finished game
curl -s -H "Authorization: Bearer $KEY" "<SERVER>/api/rooms/<ROOM>/reveal?game=3"   # a specific game
```

Response: `{gameNumber, winner, startingHands: [{name, hand}], events: [{text, note, hands: {name: [roles]}}]}`. `events[i].text` matches `game.log[i]` from the watch feed.

When a game ends, fetch the record and give a short recap: who bluffed what and when, which bluffs were called or got through, the challenges that were right or wrong, and the turning points. With step mode on, the game also holds at its end, so you can recap before calling `advance` to let the next game start. Never reveal private information before a game is over.

The watch feed's `narrator` field shows `{paused, stepMode, held}`. In step mode, each time `narrator.held` becomes true the game has reached a new situation: a new turn, a claim waiting for responses, a block, someone choosing a card to lose, or a game ending. Narrate it, then call `advance`. Players see "waiting for the narrator" and can't act until you do. Individual passes inside a response window don't cause a hold. Don't leave the game held for long, and turn step mode off when you stop narrating. The host can also continue, pause or switch step mode off from the room screen.
