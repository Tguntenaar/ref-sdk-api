import { fetchFromRPC } from "./utils/fetch-from-rpc";
import { formatDate } from "./utils/format-date";
import { convertFTBalance } from "./utils/convert-ft-balance";
import prisma from "./prisma";
import {tokens} from "./constants/tokens";
import { interpolateTimestampsToTenMinutes } from "./utils/interpolate-values";
import { periodMap } from "./constants/period-map";

type AllTokenBalanceHistoryCache = {
  get: (key: string) => any;
  set: (key: string, value: any, ttl?: number) => void;
  del: (key: string) => void;
};


export async function getAllTokenBalanceHistory(
  cache: AllTokenBalanceHistoryCache,
  cacheKey: string,
  account_id: string,
  token_id: string,
) {
  let rpcCallCount = 0;

  // FIXME: we should know when the account was created + when the token was first introduced to this account
  // That way we don't double query data that we already know.
  // Near token has a constraint of having a minimum balance of 6.
  
  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    console.log(`Cached response for key: ${cacheKey}`);
    return cachedData;
  }

  try {
    const blockData = await fetchFromRPC({
      jsonrpc: "2.0",
      id: 1,
      method: "block",
      params: { finality: "final" },
    }, true, false);
    rpcCallCount++;

    if (!blockData.result) {
      throw new Error("Failed to fetch latest block");
    }

    const endBlock = blockData.result.header.height;
    const BLOCKS_IN_ONE_HOUR = 3200;

    // FIXME: This is a hack to get all the data since the last graph will most likely run into rate limits.
    // Shuffle the periodMap but keep "1Y" at index 0
    const shuffledPeriodMap = [periodMap[0], ...periodMap.slice(1).sort(() => Math.random() - 0.5)];

    // Fetch balance history for each period
    const allPeriodHistories = await Promise.all(
      shuffledPeriodMap.map(async (periodConfig) => {
        const { period, value, interval } = periodConfig;
        try {
          const useArchival = period === "1Y" || period === "1M" || period === "1W" || period === "All";
          const BLOCKS_IN_PERIOD = Math.floor(BLOCKS_IN_ONE_HOUR * value);

          const blockHeights = Array.from(
            // FIXME: we call the RPC for each interval. Maybe we can reduce the RPC 
            // calls here as well? We only need to know when the balance changed.
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
          }, false, useArchival);
          rpcCallCount++;
          
          // FIXME: we interpolate the timestamps into 10 minute buckets to not 
          // have to request the timestamp for each block from the RPC reducing 
          // the RPC call with: (the amount of blocks || intervals) - 1
          const blockTimestamps = interpolateTimestampsToTenMinutes(
            firstBlockDataForPeriod.result.header.timestamp / 1e6,
            blockData.result.header.timestamp / 1e6, 
            interval
            );

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
              }, false, useArchival);
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
              }, false, useArchival);
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
        console.log(`Saving to database for ${account_id} and ${token_id} and ${period}`);
        await prisma.tokenBalanceHistory.create({
          data: { account_id, token_id, period, balance_history: data },
        });
      }
    });

    // Only save to cache if we have all data
    if (Object.values(respData).every(data => data.length > 0)) {
      console.log(`Saving to cache for key: ${cacheKey}`);
      cache.set(cacheKey, respData);
    }

    console.log(`Total RPC calls made: ${rpcCallCount}`); // Log the total count
    return respData;
  } catch (error) {
    try {
      console.error("Error in getAllTokenBalanceHistory:", error);
      cache.del(cacheKey);
      
      const result = await prisma.tokenBalanceHistory.findMany({
        where: {
          account_id,
          token_id,
        },
        orderBy: {
          timestamp: 'desc'
        },
        distinct: ['period']
      });
      console.log(`439 Returning from cache for ${account_id} and ${token_id} and ${result.length} periods`);
      const resultJson = result.reduce((acc: Record<string, any>, item) => {
        acc[item.period] = item.balance_history;
        return acc;
      }, {});

      return resultJson;
    } catch (error) {
      console.log(`Error in fallback getAllTokenBalanceHistory: ${error}`);
      return Object.fromEntries(
        periodMap.map(({ period }) => [period, []])
      );
    }
  }
}
