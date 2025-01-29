import axios from "axios";
import Big from "big.js";

type FTCache = {
  get: (key: string) => any;
  set: (key: string, value: any, ttl: number) => void;
};

export async function getFTTokens(account_id: string, cache: FTCache) {
  if (!account_id) {
    throw new Error("Account ID is required");
  }

  const cacheKey = `${account_id}-ft-tokens`;
  const cachedData = cache.get(cacheKey);

  if (cachedData) {
    console.log(`Cached response for key: ${cacheKey}`);
    return cachedData;
  }

  const { data } = await axios.get(
    `https://api3.nearblocks.io/v1/account/${account_id}/inventory`,
    {
      headers: {
        Authorization: `Bearer ${process.env.REPL_NEARBLOCKS_KEY}`,
      },
    }
  );

  const fts = data?.inventory?.fts;

  if (!fts || !Array.isArray(fts)) {
    throw new Error("No FT tokens found");
  }

  // Sort tokens by value (amount * price) in descending order
  const sortedFts = fts.sort(
    (a, b) =>
      parseFloat(a.amount) * (a.ft_meta.price || 0) -
      parseFloat(b.amount) * (b.ft_meta.price || 0)
  );

  // Map tokens to compute cumulative amounts
  const amounts = sortedFts.map((ft) => {
    const amount = Big(ft.amount ?? "0");
    const decimals = ft.ft_meta.decimals || 0;
    const tokenPrice = ft.ft_meta.price || 0;

    // Format amount and compute value
    const tokensNumber = amount.div(Big(10).pow(decimals));
    return tokensNumber.mul(tokenPrice).toFixed(2);
  });

  // Calculate total cumulative amount
  const totalCumulativeAmt = amounts.reduce(
    (acc, value) => acc + parseFloat(value),
    0
  );

  // Prepare the final data
  const result = {
    totalCumulativeAmt,
    fts: sortedFts,
  };

  // Cache the result
  cache.set(cacheKey, result, 60); // Cache for 1 minute

  return result;
}
