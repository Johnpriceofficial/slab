/**
 * Centering measurement and split-to-score conversion (spec §4).
 *
 * A "split" is expressed as the majority-side percentage of a border ratio
 * (e.g. a 52/48 split is represented as `52`). Splits must only be computed
 * from straight-on photos — perspective tilt corrupts pixel ratios, so every
 * measured split carries an uncertainty band (spec §4: "±3-point uncertainty
 * band... reflect that in condition confidence").
 */
import { RAW_CARD_PRICER_DEFAULTS } from "./defaults";

export interface CenteringMeasurement {
  /** Majority-side percentage, e.g. 52 for a 52/48 split. Must be in [50, 100]. */
  majorityPercent: number;
  /** True if the photo was not shot straight-on (adds uncertainty, spec §5). */
  notStraightOn?: boolean;
}

/** The six centering bands and their 1-10 scores (spec §4 table, worst-axis-front). */
const CENTERING_BANDS: ReadonlyArray<{ maxMajorityPercent: number; score: number }> = [
  { maxMajorityPercent: 52, score: 10 }, // 50/50 - 52/48
  { maxMajorityPercent: 55, score: 9 }, // 53/47 - 55/45
  { maxMajorityPercent: 60, score: 8 }, // 56/44 - 60/40
  { maxMajorityPercent: 65, score: 6 }, // 61/39 - 65/35
  { maxMajorityPercent: 70, score: 4 }, // 66/34 - 70/30
  { maxMajorityPercent: Infinity, score: 2 }, // worse than 70/30
];

/**
 * Convert a single measured split into its 1-10 centering score (spec §4 table).
 * Throws on an out-of-range split rather than silently clamping — a caller
 * passing e.g. 40 (i.e., a minority-side percentage) has a unit-confusion bug.
 */
export function centeringScoreFromSplit(majorityPercent: number): number {
  if (!Number.isFinite(majorityPercent) || majorityPercent < 50 || majorityPercent > 100) {
    throw new Error(
      `centeringScoreFromSplit: expected a majority-side percentage in [50, 100], got ${majorityPercent}`,
    );
  }
  const band = CENTERING_BANDS.find((b) => majorityPercent <= b.maxMajorityPercent);
  // CENTERING_BANDS always has a terminal Infinity band, so `band` is never undefined.
  return band!.score;
}

/**
 * Score a card's centering for one side (front or back) given horizontal and
 * vertical splits. Spec §4: "Use the worse of the horizontal and vertical
 * conversions."
 */
export function sideScoreFromSplits(horizontal: CenteringMeasurement, vertical: CenteringMeasurement): number {
  return Math.min(centeringScoreFromSplit(horizontal.majorityPercent), centeringScoreFromSplit(vertical.majorityPercent));
}

/**
 * Overall centering score across front and back (spec §4: "Score the back
 * separately with one grade of additional tolerance"). The back score is
 * shifted one band more lenient (i.e., its raw score is treated as if it
 * were one point higher, capped at 10) before taking the worse of the two.
 */
export function centeringScore(frontScore: number, backScore: number): number {
  const backWithTolerance = Math.min(10, backScore + 1);
  return Math.min(frontScore, backWithTolerance);
}

/** The ±N point uncertainty band applied to any measured split (spec §4, §23 default). */
export function centeringUncertaintyPoints(): number {
  return RAW_CARD_PRICER_DEFAULTS.centeringMeasurementUncertaintyPoints;
}
