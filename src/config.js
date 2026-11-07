// The single owner of every server setting. Change values here and commit.
export const config = {
  host: '0.0.0.0',
  port: 10000, // Render's default PORT, so the host needs no port setting
  maxSeats: 6,
  // Longest a single long-poll request is held open.
  longPollMaxSec: 30,
  // Rooms with no activity for this long are deleted.
  roomIdleHours: 12,
  chatHistory: 200,
  // Initial per-room settings; the room's host can change them.
  roomDefaults: {
    // Seconds before undecided players auto-pass a challenge/block window. 0 = wait forever.
    responseTimeoutSec: 0,
    // Seconds after a game ends before the next one starts automatically. 0 = host starts it.
    autoNextSec: 0,
  },
};
