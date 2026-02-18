/**
 * Fuzzy answer checker for Jeopardy — ported from AnswerChecker.swift.
 * Three-tier cascade: exact match → keyword matching → whole-string Levenshtein.
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'in', 'on', 'at', 'to',
  'for', 'is', 'are', 'was', 'were', 'what', 'who'
]);

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getKeyWords(str) {
  return str.split(' ').filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Single-row DP
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function wordMatches(correctWord, playerWord) {
  if (correctWord === playerWord) return true;
  if (correctWord.length > 3 && playerWord.includes(correctWord)) return true;
  if (playerWord.length > 3 && correctWord.includes(playerWord)) return true;
  const maxDist = Math.floor(correctWord.length * 0.25);
  return levenshtein(correctWord, playerWord) <= maxDist;
}

function checkAnswer(playerAnswer, correctAnswer) {
  if (!playerAnswer || !playerAnswer.trim()) {
    return { correct: false, similarity: 0 };
  }

  const correct = normalize(correctAnswer);
  const player = normalize(playerAnswer);

  // Exact match
  if (correct === player) {
    return { correct: true, similarity: 1 };
  }

  // Keyword matching
  const correctWords = getKeyWords(correct);
  const playerWords = getKeyWords(player);

  if (correctWords.length > 0 && playerWords.length > 0) {
    const hasKeyMatch = correctWords.some(cw =>
      playerWords.some(pw => wordMatches(cw, pw))
    );
    if (hasKeyMatch) {
      return { correct: true, similarity: 0.8 };
    }
  }

  // Whole-string Levenshtein
  const maxDistance = Math.max(2, Math.floor(correct.length * 0.2));
  const dist = levenshtein(correct, player);
  if (dist <= maxDistance) {
    const similarity = 1 - dist / Math.max(correct.length, 1);
    return { correct: true, similarity };
  }

  const similarity = 1 - dist / Math.max(correct.length, player.length, 1);
  return { correct: false, similarity: Math.max(0, similarity) };
}

module.exports = { checkAnswer };
