/**
 * Interpolates between two timestamps to generate a series of values rounded to 10-minute intervals.
 * @param {number} start - The starting value in milliseconds
 * @param {number} end - The ending value in milliseconds
 * @param {number} steps - The number of steps to interpolate
 * @returns {number[]} - An array of interpolated timestamps, rounded to 10-minute intervals
 */
export function interpolateTimestampsToTenMinutes(
  start: number,
  end: number,
  steps: number
): number[] {
  if (steps < 2) {
    throw new Error("Number of steps must be at least 2 for interpolation.");
  }

  const TEN_MINUTES_MS = 10 * 60 * 1000; // 600,000 milliseconds
  const stepSize = (end - start) / (steps - 1);
  return Array.from({ length: steps }, (_, i) => {
    const value = start + i * stepSize;
    return Math.round(value / TEN_MINUTES_MS) * TEN_MINUTES_MS;
  });
}
