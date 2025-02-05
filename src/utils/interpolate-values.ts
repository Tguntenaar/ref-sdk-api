/**
 * Interpolates between two points to generate a series of values over a given number of steps.
 * @param {number} start - The starting value
 * @param {number} end - The ending value
 * @param {number} steps - The number of steps to interpolate
 * @returns {number[]} - An array of interpolated values
 */
export function interpolateValues(
  start: number,
  end: number,
  steps: number
): number[] {
  if (steps < 2) {
    throw new Error("Number of steps must be at least 2 for interpolation.");
  }

  const stepSize = (end - start) / (steps - 1);
  return Array.from({ length: steps }, (_, i) => Math.round(start + i * stepSize));
}
