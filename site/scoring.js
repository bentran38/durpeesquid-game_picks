// Scoring for one pick on a finished game. The database computes the same numbers in the
// picks.scored view (supabase/migrations/20261020000000_picks.sql); test/db.test.js checks they agree.
//   10  right winner (or a correctly called tie)
//  + up to 5 margin bonus: 5 minus how far the predicted margin was off (floor 0)
//  +  5  exact score
export const WINNER = 10;
export const MARGIN_MAX = 5;
export const EXACT = 5;

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
  let points = 0;
  if (correct) points += WINNER + Math.max(0, MARGIN_MAX - marginErr);
  if (exact) points += EXACT;
  return { correct, exact, marginErr, totalErr, points };
}
