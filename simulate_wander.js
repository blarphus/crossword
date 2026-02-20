#!/usr/bin/env node
// Monte Carlo simulation to find optimal wanderChance and wanderTime
// for each (day-of-week, difficulty) pair.
//
// Model: after each word, bot flips a coin (wanderChance). If hit, it
// wanders for wanderTime ms before filling the word.
// totalTime = sum(cellTimes) + numWanderHits × wanderTime
// We want E[totalTime] ≈ targetTime × 1000.

const AI_TARGET_TIMES = [
  [2940, 2390, 1835, 1560, 1195], // Sun (dow=0)
  [630,  510,  395,  335,  255],   // Mon (dow=1)
  [770,  625,  480,  410,  310],   // Tue (dow=2)
  [1320, 1075, 825,  700,  535],   // Wed (dow=3)
  [1680, 1365, 1050, 890,  680],   // Thu (dow=4)
  [2000, 1625, 1250, 1065, 810],   // Fri (dow=5)
  [2400, 1950, 1500, 1275, 975],   // Sat (dow=6)
];

const AI_MULTIPLIER_RANGES = [
  [0.85, 1.25], // Easy
  [0.90, 1.18], // Standard-
  [0.92, 1.15], // Standard
  [0.94, 1.12], // Standard+
  [0.96, 1.08], // Expert
];

// Typical puzzle dimensions per day
const PUZZLE_STATS = [
  { words: 140, cells: 400 }, // Sun (21×21)
  { words: 78,  cells: 185 }, // Mon
  { words: 76,  cells: 185 }, // Tue
  { words: 74,  cells: 185 }, // Wed
  { words: 72,  cells: 185 }, // Thu
  { words: 70,  cells: 180 }, // Fri
  { words: 66,  cells: 180 }, // Sat
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DIFF_NAMES = ['Easy', 'Standard-', 'Standard', 'Standard+', 'Expert'];

// Bounds for natural-looking wandering
const MIN_WANDER_TIME = 800;
const MAX_WANDER_TIME = 8000;
const MIN_WANDER_CHANCE = 0.10;
const MAX_WANDER_CHANCE = 0.85;

// Simulate distributeAiTiming's cell portion: generates cellTimes summing to 0.75 * totalMs
function generateCellTimes(cellCount, totalMs) {
  const rawCell = [];
  let streakLen = 0;
  let streakSpeed = 1;
  for (let i = 0; i < cellCount; i++) {
    if (streakLen <= 0) {
      streakLen = 2 + Math.floor(Math.random() * 7);
      const r = Math.random();
      if (r < 0.3) streakSpeed = 0.2 + Math.random() * 0.4;
      else if (r < 0.7) streakSpeed = 0.5 + Math.random() * 1;
      else streakSpeed = 1.5 + Math.random() * 2.5;
    }
    rawCell.push(streakSpeed * (0.6 + Math.random() * 0.8));
    streakLen--;
  }
  const cellSum = rawCell.reduce((s, v) => s + v, 0);
  return rawCell.map(v => Math.max(40, (v / cellSum) * totalMs * 0.75));
}

// Run N trials and return mean total time for given params
function simulate(numWords, numCells, targetTimeSec, diffIdx, wanderChance, wanderTimeMs, trials) {
  const [lo, hi] = AI_MULTIPLIER_RANGES[diffIdx];
  let totalSum = 0;
  let totalSumSq = 0;

  for (let t = 0; t < trials; t++) {
    const mult = lo + Math.random() * (hi - lo);
    const finalSolveTime = targetTimeSec * mult;
    const totalMs = finalSolveTime * 1000;

    const cellTimes = generateCellTimes(numCells, totalMs);
    const cellTotal = cellTimes.reduce((s, v) => s + v, 0);

    let wanderTotal = 0;
    for (let w = 0; w < numWords; w++) {
      if (Math.random() < wanderChance) {
        wanderTotal += wanderTimeMs;
      }
    }

    const totalTime = cellTotal + wanderTotal;
    totalSum += totalTime;
    totalSumSq += totalTime * totalTime;
  }

  const mean = totalSum / trials;
  const variance = totalSumSq / trials - mean * mean;
  const stddev = Math.sqrt(Math.max(0, variance));
  return { mean, stddev };
}

// Main optimization with bounded wander time
function findOptimal(dow, diffIdx) {
  const targetSec = AI_TARGET_TIMES[dow][diffIdx];
  const targetMs = targetSec * 1000;
  const { words: numWords, cells: numCells } = PUZZLE_STATS[dow];

  // Analytical: wanderChance × wanderTime ≈ 0.25 × targetMs / numWords
  const wanderProduct = 0.25 * targetMs / numWords;

  let bestChance = 0.5;
  let bestTime = wanderProduct / 0.5;
  let bestError = Infinity;

  // Phase 1: Coarse sweep with bounded wanderTime
  for (let chance = MIN_WANDER_CHANCE; chance <= MAX_WANDER_CHANCE; chance += 0.05) {
    const analyticalTime = wanderProduct / chance;

    // Sweep ±30% around analytical, clamped to bounds
    for (let frac = 0.70; frac <= 1.30; frac += 0.05) {
      const wTime = Math.max(MIN_WANDER_TIME, Math.min(MAX_WANDER_TIME, analyticalTime * frac));

      const { mean } = simulate(numWords, numCells, targetSec, diffIdx, chance, wTime, 2000);
      const error = Math.abs(mean - targetMs) / targetMs;

      if (error < bestError) {
        bestError = error;
        bestChance = chance;
        bestTime = wTime;
      }
    }
  }

  // Phase 2: Fine sweep around best
  let fineChance = bestChance;
  let fineTime = bestTime;
  let fineError = bestError;

  for (let chance = bestChance - 0.04; chance <= bestChance + 0.04; chance += 0.01) {
    if (chance < MIN_WANDER_CHANCE || chance > MAX_WANDER_CHANCE) continue;
    for (let frac = 0.90; frac <= 1.10; frac += 0.02) {
      const wTime = Math.max(MIN_WANDER_TIME, Math.min(MAX_WANDER_TIME, bestTime * frac));

      const { mean } = simulate(numWords, numCells, targetSec, diffIdx, chance, wTime, 10000);
      const error = Math.abs(mean - targetMs) / targetMs;

      if (error < fineError) {
        fineError = error;
        fineChance = chance;
        fineTime = wTime;
      }
    }
  }

  // Final validation
  const final = simulate(numWords, numCells, targetSec, diffIdx, fineChance, fineTime, 20000);
  const finalError = Math.abs(final.mean - targetMs) / targetMs;

  return {
    chance: Math.round(fineChance * 100) / 100,
    time: Math.round(fineTime),
    meanError: (finalError * 100).toFixed(2),
    stddev: Math.round(final.stddev),
    meanMs: Math.round(final.mean),
    targetMs,
  };
}

// Run all combinations
console.log('Running Monte Carlo simulation (wanderTime bounded to 800-8000ms)...\n');

const chanceTable = [];
const timeTable = [];

for (let dow = 0; dow < 7; dow++) {
  const chanceRow = [];
  const timeRow = [];
  for (let diff = 0; diff < 5; diff++) {
    process.stdout.write(`  ${DAY_NAMES[dow]} × ${DIFF_NAMES[diff]}...`);
    const result = findOptimal(dow, diff);
    console.log(` chance=${result.chance}, time=${result.time}ms, err=${result.meanError}%, mean=${result.meanMs} vs target=${result.targetMs}`);
    chanceRow.push(result.chance);
    timeRow.push(result.time);
  }
  chanceTable.push(chanceRow);
  timeTable.push(timeRow);
}

console.log('\n=== RESULTS ===\n');

console.log('const AI_WANDER_CHANCE = [');
for (let dow = 0; dow < 7; dow++) {
  const vals = chanceTable[dow].map(v => v.toFixed(2)).join(', ');
  console.log(`  [${vals}], // ${DAY_NAMES[dow]}`);
}
console.log('];');

console.log('\nconst AI_WANDER_TIME = [');
for (let dow = 0; dow < 7; dow++) {
  const vals = timeTable[dow].map(v => String(v).padStart(5)).join(', ');
  console.log(`  [${vals}], // ${DAY_NAMES[dow]}`);
}
console.log('];');
