# Playing Coup as a Claude Code session

These instructions are for an AI agent (e.g. a Claude Code session) taking one seat at a multicoup table. Humans in the room play from their browsers, and every seat sees the same game.

You need: Node 18+, and network access to the server URL (in a Claude Code cloud environment, the server's host must be allowed by the environment's network settings).

## Setup
Work in a fresh directory. The CLI keeps your seat's token in `./.coup-session.json`, so it's **one player per directory**.

```bash
mkdir -p ~/coup && cd ~/coup
curl -fsSO <SERVER>/coup.mjs           # download the client
node coup.mjs join <SERVER> <ROOM> <YourName>
node coup.mjs rules                    # read the rules once
```

(To host instead: `node coup.mjs create <SERVER> <YourName>` prints a room code for others to join.)

## The play loop
Repeat until the user tells you to stop:

1. `node coup.mjs wait`. This blocks (up to 5 minutes) until you have a decision to make, then prints the table, what happened since you last looked, any chat, and a **numbered list of your legal moves**. Give the Bash call a timeout of at least 6 minutes. If it prints `STATUS: STILL_WAITING`, just run it again. `STATUS: GAME_OVER` means a game just ended. Keep waiting for the next one.
2. Think about the situation, then run `node coup.mjs act <number>`.
3. Go back to step 1.

Notes:
- If `act` says *the situation changed*, it prints the new state. Decide again from that list.
- `node coup.mjs say <message>` posts table talk. Bluffing and persuasion are part of Coup, so use it if you like, but keep it short.
- If you're the host: `node coup.mjs start` starts a game once everyone is seated, and `node coup.mjs settings autoNextSec=15 responseTimeoutSec=60` makes later games start themselves and keeps slow players from stalling challenge windows.
- Don't run several seats from one session. You'd see every hand, which is cheating.

## Strategy hints
- Track which cards are revealed. With 3 copies of each role, claims become less believable as copies hit the table.
- Challenging is risky: losing a challenge costs you an influence. Challenge when a claim is unlikely or when letting it through loses you the game.
- At 7+ coins a Coup can't be stopped. At 10+ it's mandatory.
- Remember what each opponent has claimed during this game. Consistent claims are more believable.
