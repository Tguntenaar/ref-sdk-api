import { fetchFromRPC } from "./utils/fetch-from-rpc";
import { formatDate } from "./utils/format-date";
import { convertFTBalance } from "./utils/convert-ft-balance";
import prisma from "./prisma";
import {tokens} from "./constants/tokens";
type AllTokenBalanceHistoryCache = {
  get: (key: string) => any;
  set: (key: string, value: any, ttl?: number) => void;
  del: (key: string) => void;
};

const periodMap = [
  { period: "1H", value: 1 / 6, interval: 6 },
  { period: "1D", value: 1, interval: 12 },
  { period: "1W", value: 24, interval: 8 },
  { period: "1M", value: 24 * 2, interval: 15 },
  { period: "1Y", value: 24 * 30, interval: 12 },
  { period: "All", value: 24 * 365, interval: 10 },
];

export async function getAllTokenBalanceHistory(
  cache: AllTokenBalanceHistoryCache,
  cacheKey: string,
  account_id: string,
  token_id: string,
) {
  let rpcCallCount = 0; // Initialize counter
  
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
    rpcCallCount++; // Increment counter

    if (!blockData.result) {
      throw new Error("Failed to fetch latest block");
    }

    const endBlock = blockData.result.header.height;
    const BLOCKS_IN_ONE_HOUR = 3200;

    // Fetch balance history for each period
    const allPeriodHistories = await Promise.all(
      periodMap.map(async ({ period, value, interval }) => {
        try {
          const BLOCKS_IN_PERIOD = Math.floor(BLOCKS_IN_ONE_HOUR * value);

          const blockHeights = Array.from(
            { length: interval },
            (_, i) => endBlock - BLOCKS_IN_PERIOD * i
          ).filter((block) => block > 0);

          const blockPromises = blockHeights.map((block_id) => {
            rpcCallCount++; // Increment counter for each block request
            return fetchFromRPC({
              jsonrpc: "2.0",
              id: block_id,
              method: "block",
              params: { block_id },
            });
          });

          const balancePromises = blockHeights.map((block_id) => {
            rpcCallCount++; // Increment counter for each balance request
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

          const [blocks, balances] = await Promise.all([
            Promise.all(blockPromises),
            Promise.all(balancePromises),
          ]);

          const balanceHistory = blocks.map((blockData, index) => {
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

            const timestamp = blockData?.result?.header?.timestamp 
              ? blockData.result.header.timestamp / 1e6 
              : Date.now(); // Fallback to current timestamp if header is undefined due to rpc error
              
            return {
              timestamp,
              date: formatDate(timestamp, value),
              balance: balance
                ? convertFTBalance(balance, tokens[token_id as keyof typeof tokens].decimals)
                : "0",
            };
          });

          return {
            period,
            data: balanceHistory.reverse(),
          };
        } catch (error) {
          console.error(`Error fetching data for period ${period}:`, error);
          return {
            period,
            data: [], // Return empty data for this period instead of failing the entire request
          };
        }
      })
    );

    const respData = Object.fromEntries(
      allPeriodHistories.map(({ period, data }) => [period, data])
    );

    // Store in database for every data value that is not empty
    allPeriodHistories.forEach(async ({ period, data }) => {
      if (data.length > 0) {
        await prisma.tokenBalanceHistory.create({
          data: { account_id, token_id, period, balance_history: data },
        });
      }
    });

    // Only save to cache if we have all data
    if (Object.values(respData).every(data => data.length > 0)) {
      cache.set(cacheKey, respData);
    }

    console.log(`Total RPC calls made: ${rpcCallCount}`); // Log the total count
    return respData;
  } catch (error) {
    console.error("Error in getAllTokenBalanceHistory:", error);
    cache.del(cacheKey);
    
    // Try to get the latest data from the database as fallback
    const dbData = await prisma.tokenBalanceHistory.findFirst({
      where: {
        account_id,
        token_id,
      },
      orderBy: {
        timestamp: 'desc'
      },
    });

    if (dbData?.balance_history) {
      return dbData.balance_history;
    }

    // If no data in database, return empty data structure
    return Object.fromEntries(
      periodMap.map(({ period }) => [period, []])
    );
  }
}
