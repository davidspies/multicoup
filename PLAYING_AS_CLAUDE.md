# Playing as a Claude Code session

These instructions are for an AI agent (e.g. a Claude Code session) taking one seat at a multicoup table. The room plays either **Coup** or **Hull Breach**. Humans in the room play from their browsers, and every seat sees the same game.

You need: Node 18+, and network access to the server URL (in a Claude Code cloud environment, the server's host must be allowed by the environment's network settings).

## Setup
Work in a fresh directory. The CLI keeps your seat's token in `./.multicoup-session.json`, so it's **one player per directory**.

```bash
mkdir -p ~/multicoup-seat && cd ~/multicoup-seat
curl -fsSO <SERVER>/multicoup.mjs        # download the client
node multicoup.mjs join <SERVER> <ROOM> <YourName>
node multicoup.mjs rules                 # read the rules of this room's game once
```

(To host instead: `node multicoup.mjs create <SERVER> <coup|hullbreach> <YourName>` prints a room code for others to join.)

## The play loop
Repeat until the user tells you to stop:

1. `node multicoup.mjs wait`. This blocks (up to 5 minutes) until you have a decision to make. Then it prints the table, your private information, what happened since you last looked, any chat, and your options. Give the Bash call a timeout of at least 6 minutes. If it prints `STATUS: STILL_WAITING`, just run it again. `STATUS: GAME_OVER` means a game just ended. Keep waiting for the next one.
2. Think about the situation, then act:
   - Usually: `node multicoup.mjs act <number>` from the numbered list.
   - Hull Breach captain choosing a crew: `node multicoup.mjs propose <name> <name> ...` with exactly the number of names it asks for (you may include yourself).
3. Go back to step 1.

Notes:
- If `act` says *the situation changed*, it prints the new state. Decide again from that list.
- `node multicoup.mjs say <message>` posts table talk. Bluffing and persuasion are part of both games, so use it if you like, but keep it short.
- If you're the host: `node multicoup.mjs start` starts a game once everyone is seated, and `node multicoup.mjs settings autoNextSec=15` makes later games start themselves. In Coup, `responseTimeoutSec=60` keeps slow players from stalling challenge windows. In Hull Breach, `node multicoup.mjs options medic=true mimic=true scanner=true` picks special roles and turns on the Scanner.
- Don't run several seats from one session. You'd see every player's private information, which is cheating.
- Never reveal your hidden information outright in chat unless it's a deliberate bluff or a play your side benefits from.

## Coup strategy hints
- Track which cards are revealed. With 3 copies of each role, claims become less believable as copies hit the table.
- Challenging is risky: losing a challenge costs you an influence. Challenge when a claim is unlikely or when letting it through loses you the game.
- At 7+ coins a Coup can't be stopped. At 10+ it's mandatory.
- Remember what each opponent has claimed during this game. Consistent claims are more believable.

## Hull Breach strategy hints
- The status shows your role and exactly what you know. Plain crew know nothing at the start, so reason from votes and mission results.
- The vote history (in the status output) is your main evidence: who approved crews that later failed, and who keeps proposing or backing the same people.
- A failed mission with N sabotage cards means at least N saboteurs were on that crew.
- As a saboteur, sabotaging every time gets you caught. Sometimes playing success builds trust, but don't let the crew reach three successes.
- As the Navigator, steer the crew without being obvious: the Hunter is watching for whoever seems to know too much.
- As the Hunter at the end, look for who voted and proposed "too correctly".
- With the Scanner, your scan result is real evidence only to you. Whatever the scanner announces in chat may be a lie, especially from a saboteur.
