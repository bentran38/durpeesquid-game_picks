// How one pick did on a finished game. There are no points: a pick is judged on whether it had the right
// winner (or correctly called a tie), whether it was the exact score, and how far off it was.
// The database computes the same numbers in the picks.scored view (supabase/migrations/); test/db.test.js
// checks they agree.
//   marginErr  how far the predicted margin (home minus away) was from the real margin
//   totalErr   how far the two predicted scores were from the real ones, added together

// For a game in progress: is the pick's winner ahead right now? (Not a score, just who is leading.)
export function leading(pick, game) {
  if (game.status !== 'live' || game.home_score == null || game.away_score == null) return null;
  return Math.sign(pick.home_pick - pick.away_pick) === Math.sign(game.home_score - game.away_score);
}

export function scorePick(pick, game) {
  if (game.status !== 'final' || game.home_score == null || game.away_score == null) return null;
  const predMargin = pick.home_pick - pick.away_pick;
  const actualMargin = game.home_score - game.away_score;
  const marginErr = Math.abs(predMargin - actualMargin);
  const totalErr = Math.abs(pick.home_pick - game.home_score) + Math.abs(pick.away_pick - game.away_score);
  const correct = Math.sign(predMargin) === Math.sign(actualMargin);
  const exact = totalErr === 0;
  return { correct, exact, marginErr, totalErr };
}
