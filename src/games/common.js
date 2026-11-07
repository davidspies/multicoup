// Shared by every game engine.
//
// Each engine module exports a class with:
//   static meta = {id, title, minPlayers, maxPlayers}
//   static validateOptions(options)                    throws IllegalMove on bad options
//   static startIndex(players, lastWinnerIds, randInt) who goes first / leads first
//   constructor(players, {rng, startIndex, options})   throws IllegalMove if unplayable
//   phase ('over' when finished), log (public lines)
//   awaiting(), legalMoves(pid), describeMove(pid, m), apply(pid, m)
//   view(pid | null)      JSON for the browser (pid null = public)
//   situation(pid | null) {text, sub} one-line status for banners
//   textView(pid | null)  lines describing the table, for agents
//   situationKey()        changes at each new decision point (narrator step mode)
//   timedWindow()         id of an open window that may auto-pass, or null
//   expireWindow()        auto-pass that window
//   winners()             ids on the winning side ([] if abandoned)
//   resultText()          one line for the results list
//   forfeit(pid)          a player left mid-game
//   privateRecord()       full private record, only once the game is over

export class IllegalMove extends Error {}

export function fail(msg) {
  throw new IllegalMove(msg);
}

export const cap = (s) => s[0].toUpperCase() + s.slice(1);

export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
