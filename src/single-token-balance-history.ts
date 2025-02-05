import { fetchFromRPC } from "./utils/fetch-from-rpc";
import { formatDate } from "./utils/format-date";
import { convertFTBalance } from "./utils/convert-ft-balance";
import prisma from "./prisma";
import { tokens } from "./constants/tokens";
import { periodMap } from "./constants/period-map";
import { interpolateValues } from "./utils/interpolate-values";

type SingleTokenBalanceHistoryCache = {
  get: (key: string) => any;
  set: (key: string, value: any, ttl?: number) => void;
  del: (key: string) => void;
};

export async function getSingleTokenBalanceHistory(
  cache: SingleTokenBalanceHistoryCache,
  cacheKey: string,
  account_id: string,
  token_id: string,
  periodConfig: { period: string, value: number, interval: number },
) {
  let rpcCallCount = 0;
  
  const cachedData = cache.get(cacheKey);

  if (cachedData) {
    console.log(` cached response for key: ${cacheKey}`);
    return cachedData;
  }

  try {
    const blockData = await fetchFromRPC({
      jsonrpc: "2.0",
      id: 1,
      method: "block",
      params: { finality: "final" },
    }, true);
    rpcCallCount++;

    if (!blockData.result) {
      throw new Error("Failed to fetch latest block");
    }

    const endBlock = blockData.result.header.height;
    const BLOCKS_IN_ONE_HOUR = 3200;
    const { period, value, interval } = periodConfig;
    const BLOCKS_IN_PERIOD = Math.floor(BLOCKS_IN_ONE_HOUR * value);

    const blockHeights = Array.from(
      { length: interval },
      (_, i) => endBlock - BLOCKS_IN_PERIOD * i
    ).filter((block) => block > 0);

    const firstBlock = blockHeights[blockHeights.length - 1];
    console.log(`Fetching first block: ${firstBlock}`);
    const firstBlockDataForPeriod = await fetchFromRPC({
      jsonrpc: "2.0",
      id: firstBlock,
      method: "block",
      params: { block_id: firstBlock},
    });
    console.log(`First block data: ${JSON.stringify(firstBlockDataForPeriod)}`);
    
    const blockTimestamps = interpolateValues(
      firstBlockDataForPeriod.result.header.timestamp / 1e6,
      blockData.result.header.timestamp / 1e6, 
      interval);

    const balancePromises = blockHeights.map((block_id) => {
      rpcCallCount++;
      if (token_id === "near") {
        return fetchFromRPC({
          jsonrpc: "2.0",
          id: 1,
          method: "query",
          params: {
            request_type: "view_account",
            block_id,
            account_id,
          },
        });
      } else {
        return fetchFromRPC({
          jsonrpc: "2.0",
          id: "dontcare",
          method: "query",
          params: {
            request_type: "call_function",
            block_id,
            account_id: token_id,
            method_name: "ft_balance_of",
            args_base64: btoa(JSON.stringify({ account_id })),
          },
        });
      }
    });

    const balances = await Promise.all(balancePromises);

    const balanceHistory = blockTimestamps.map((timestamp, index) => {
      const balanceData = balances[index];
      let balance = "0";

      if (token_id === "near") {
        balance = balanceData.result?.amount?.toString() || "0";
      } else {
        if (balanceData.result) {
          balance = String.fromCharCode(...balanceData.result.result);
          balance = balance ? balance.replace(/"/g, "") : "0";
        }
      }

      return {
        timestamp,
        date: formatDate(timestamp, value),
        balance: balance
          ? convertFTBalance(balance, tokens[token_id as keyof typeof tokens].decimals)
          : "0",
      };
    });

    const respData = {
      [period]: balanceHistory.reverse()
    };

    // Store in database if we have data
    if (balanceHistory.length > 0) {
      await prisma.tokenBalanceHistory.create({
        data: { 
          account_id, 
          token_id, 
          period, 
          balance_history: balanceHistory 
        },
      });
    }

    // Save to cache if we have data
    if (balanceHistory.length > 0) {
      console.log(`Saving to cache for key: ${cacheKey}`);
      cache.set(cacheKey, respData);
    }

    console.log(`Total RPC calls made: ${rpcCallCount}`);
    return respData;
  } catch (error) {
    console.error("Error in getSingleTokenBalanceHistory:", error);
    cache.del(cacheKey);
    
    // Try to get the latest data from the database as fallback
    const dbData = await prisma.tokenBalanceHistory.findFirst({
      where: {
        account_id,
        token_id,
        period: periodConfig.period
      },
      orderBy: {
        timestamp: 'desc'
      },
    });

    if (dbData?.balance_history) {
      return { [periodConfig.period]: dbData.balance_history };
    }

    // If no data in database, return empty data structure
    return { [periodConfig.period]: [] };
  }
}
