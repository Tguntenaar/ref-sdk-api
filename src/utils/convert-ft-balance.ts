export function convertFTBalance(value: string, decimals: number) {
  return (parseFloat(value) / Math.pow(10, decimals)).toFixed(2);
}
