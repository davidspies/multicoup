# Coup rules (as implemented)

**Goal:** be the last player with any influence (face-down cards).

## Setup
- 2–6 players. The court deck has 15 cards, 3 each of **Duke, Assassin, Captain, Ambassador, Contessa**.
- Each player gets 2 face-down cards (their *influence*) and 2 coins. In a 2-player game the starting player gets only 1 coin.
- The first game's starting player is random. After that, the previous game's winner starts.

## Your turn: choose exactly one action
| Action | Effect | Claim | Can be blocked by |
|---|---|---|---|
| Income | +1 coin | none | — |
| Foreign Aid | +2 coins | none | anyone claiming Duke |
| Coup | pay 7, target loses an influence | none | — (unstoppable) |
| Tax | +3 coins | Duke | — |
| Assassinate | pay 3, target loses an influence | Assassin | the target, claiming Contessa |
| Steal | take up to 2 coins from target | Captain | the target, claiming Captain or Ambassador |
| Exchange | draw 2 cards, then return any 2 of your hand + drawn | Ambassador | — |

If you start your turn with **10 or more coins you must Coup**.

You can claim any character whether or not you hold it. That's bluffing.

## Challenges
When anyone claims a character (to act or to block), every other living player can **challenge** it. The first challenge counts.
- **If the claimant has the card**, they reveal it, shuffle it into the deck and draw a replacement. The challenger loses an influence. The action or block goes ahead.
- **If they don't**, the claimant loses an influence and the action or block fails. Coins paid for a failed Assassinate are returned.

## Blocks
After an action survives any challenge, eligible players can **block** it (see the table). A block is itself a claim and can be challenged by anyone. If the block stands, the action has no effect (but coins paid for Assassinate stay spent).

## Losing influence
When you lose an influence you choose which card to reveal. It stays face up for the rest of the game. With no face-down cards left, you're out. A player can lose two influences in one turn, for example by challenging an Assassin wrongly and then being assassinated.

## Order of play in this app
1. The active player declares an action (paying any cost).
2. If it claims a character, every other living player chooses **challenge** or **pass**.
3. If it can be blocked, the eligible player(s) choose **block** or **pass**.
4. If someone blocks, everyone except the blocker chooses **challenge** or **pass**.
5. The action resolves (or doesn't). Play moves to the next living player clockwise.

A room's host can set a **response timeout**. Undecided players then automatically pass challenge/block windows after that many seconds.

## Matches
A room plays any number of games. The scoreboard tracks wins per player. Between games, players can join (up to 6 seats) or leave. Leaving mid-game forfeits: all your cards are revealed.
