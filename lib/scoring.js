'use strict';

// Scoring (max 20 per game):
//   10  picked the right winner (or correctly called a tie)
//  + up to 5 margin bonus: 5 minus how many points your predicted margin was off (floor 0)
//  +  5  exact final score
const WINNER = 10;
const MARGIN_MAX = 5;
const EXACT = 5;

const sign = (n) => Math.sign(n);

function scorePick(pick, game) {
  if (game.status !== 'final' || game.home_score == null || game.away_score == null) return null;
  const predMargin = pick.home_pick - pick.away_pick;
  const actualMargin = game.home_score - game.away_score;
  const marginErr = Math.abs(predMargin - actualMargin);
  const totalErr = Math.abs(pick.home_pick - game.home_score) + Math.abs(pick.away_pick - game.away_score);
  const correct = sign(predMargin) === sign(actualMargin);
  const exact = totalErr === 0;
  let points = 0;
  if (correct) points += WINNER + Math.max(0, MARGIN_MAX - marginErr);
  if (exact) points += EXACT;
  return { correct, exact, marginErr, totalErr, points, predMargin, actualMargin };
}

module.exports = { scorePick, WINNER, MARGIN_MAX, EXACT, MAX_POINTS: WINNER + MARGIN_MAX + EXACT };
