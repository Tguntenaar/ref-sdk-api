import axios from "axios";
import Big from "big.js";
import prisma from "./prisma";

type FTCache = {
  get: (key: string) => any;
  set: (key: string, value: any, ttl: number) => void;
};

interface FastNearToken {
  balance: string;
  contract_id: string;
  last_update_block_height: number;
}

interface FtMeta {
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  reference?: string | null;
  price?: number;
}

interface FtsToken {
  contract: string;
  amount: string;
  ft_meta: FtMeta;
}

async function updateFtsWithFastNear(
  fastnearTokens: FastNearToken[],
  fts: FtsToken[]
): Promise<FtsToken[]> {
  const ftsMap = new Map<string, FtsToken>(
    fts.map((token) => [token.contract, token])
  );

  const missingTokens = fastnearTokens.filter(
    (token) => !ftsMap.has(token.contract_id)
  );

  const fetchedTokens = await Promise.all(
    missingTokens.map(async (token): Promise<FtsToken | null> => {
      try {
        const { data } = await axios.get(
          `https://api.nearblocks.io/v1/fts/${token.contract_id}`,
          {
            headers: {
              Authorization: `Bearer ${process.env.NEARBLOCKS_API_KEY}`,
            },
          }
        );

        const contractData = data?.contracts?.[0];

        if (!contractData) return null; // Skip if no data

        return {
          contract: token.contract_id,
          amount: token.balance,
          ft_meta: {
            name: contractData.name,
            symbol: contractData.symbol,
            decimals: contractData.decimals,
            icon: contractData.icon || undefined,
            reference: contractData.reference || null,
            price: parseFloat(contractData.price) || 0,
          },
        };
      } catch (error) {
        console.error(
          `Failed to fetch metadata for ${token.contract_id}:`,
          error
        );
        return null; // Skip failed requests
      }
    })
  );

  // Add fetched tokens to ftsMap, filtering out any failed requests
  fetchedTokens
    .filter((token): token is FtsToken => token !== null)
    .forEach((token) => ftsMap.set(token.contract, token));

  return Array.from(ftsMap.values());
}

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

  if (!process.env.NEARBLOCKS_API_KEY) {
    throw new Error("NEARBLOCKS_API_KEY is not set");
  }

  const { data } = await axios.get(
    `https://api3.nearblocks.io/v1/account/${account_id}/inventory`,
    {
      headers: {
        Authorization: `Bearer ${process.env.NEARBLOCKS_API_KEY}`,
      },
    }
  );

  // sometimes nearblocks doesn't return correct tokens, so to cross check with fastnear
  const fastnearResp = await axios.get(
    `https://api.fastnear.com/v1/account/${account_id}/full`
  );

  const updatedFts = await updateFtsWithFastNear(
    fastnearResp?.data?.tokens || [],
    data?.inventory?.fts || []
  );

  if (!updatedFts || !Array.isArray(updatedFts)) {
    throw new Error("No FT tokens found");
  }

  // Sort tokens by value (amount * price) in descending order
  const sortedFts = updatedFts.sort(
    (a: any, b: any) =>
      parseFloat(a.amount) * (a.ft_meta?.price || 0) -
      parseFloat(b.amount) * (b.ft_meta?.price || 0)
  );

  // Map tokens to compute cumulative amounts
  const amounts = sortedFts.map((ft: any) => {
    const amount = Big(ft.amount ?? "0");
    const decimals = ft.ft_meta?.decimals || 0;
    const tokenPrice = ft.ft_meta?.price || 0;

    // Format amount and compute value
    const tokensNumber = amount.div(Big(10).pow(decimals));
    return tokensNumber.mul(tokenPrice).toFixed(2);
  });

  // Calculate total cumulative amount
  const totalCumulativeAmt = amounts.reduce(
    (acc, value) => acc + parseFloat(value),
    0
  );

  await prisma.fTToken.create({
    data: {
      account_id,
      totalCumulativeAmt,
      fts: updatedFts as any,
    },
  });

  // Prepare the final data
  const result = {
    totalCumulativeAmt,
    fts: sortedFts,
  };

  // Cache the result
  cache.set(cacheKey, result, 60); // Cache for 1 minute

  return result;
}
