function report(scores) {
  let total = 0;
  for (const s of scores) total += s;
  const avg = scores.length ? total / scores.length : 0;

  let hi = -Infinity;
  for (const s of scores) if (s > hi) hi = s;

  return { avg, hi, count: scores.length };
}

module.exports = { report };
