import { fetchFromRPC } from "./utils/fetch-from-rpc";
import { formatDate } from "./utils/format-date";
import { convertFTBalance } from "./utils/convert-ft-balance";
import prisma from "./prisma";
import { tokens } from "./constants/tokens";
import { interpolateTimestampsToTenMinutes } from "./utils/interpolate-values";
import { periodMap } from "./constants/period-map";
import { getUserStakeBalances } from "./utils/lib";

type AllTokenBalanceHistoryCache = {
  get: (key: string) => any;
  set: (key: string, value: any, ttl?: number) => void;
  del: (key: string) => void;
};

export async function getAllTokenBalanceHistory(
  cache: AllTokenBalanceHistoryCache,
  cacheKey: string,
  account_id: string,
  token_id: string
): Promise<
  Record<string, { timestamp: number; date: string; balance: string }[]>
> {
  let rpcCallCount = 0;

  const cachedData = cache.get(cacheKey);
  if (cachedData) {
    console.log(`Cached response for key: ${cacheKey}`);
    return cachedData;
  }

  const token = tokens[token_id as keyof typeof tokens];
  let decimals = token?.decimals || 24;

  try {
    if (!token?.decimals) {
      console.log(`Fetching token details for ${token_id}`);
      const tokenDetails = await fetchFromRPC(
        {
          jsonrpc: "2.0",
          id: "dontcare",
          method: "query",
          params: {
            request_type: "call_function",
            account_id: token_id,
            finality: "final",
            method_name: "ft_metadata",
            args_base64: btoa(JSON.stringify({})),
          },
        },
        false,
        false
      );

      const decodedResult = tokenDetails.result.result
        .map((c: number) => String.fromCharCode(c))
        .join("");

      const decodedResultObject = JSON.parse(decodedResult);
      decimals = parseInt(decodedResultObject.decimals, 10);

      console.log(`Decimals: ${decimals}`);
    }
  } catch (error) {
    console.log(`Error fetching token details for ${token_id}: ${error}`);
  }

  try {
    const blockData = await fetchFromRPC(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "block",
        params: { finality: "final" },
      },
      true,
      false
    );
    rpcCallCount++;

    if (!blockData.result) {
      throw new Error("Failed to fetch latest block");
    }

    const endBlock = blockData.result.header.height;
    const BLOCKS_IN_ONE_HOUR = 3200;

    // Shuffle the periodMap but keep "1Y" at index 0
    const shuffledPeriodMap = [
      periodMap[0],
      ...periodMap.slice(1).sort(() => Math.random() - 0.5),
    ];

    // Fetch balance history for each period
    const allPeriodHistories = await Promise.all(
      shuffledPeriodMap.map(async (periodConfig) => {
        const { period, value, interval } = periodConfig;
        try {
          const useArchival =
            period === "1Y" ||
            period === "1M" ||
            period === "1W" ||
            period === "All";
          const BLOCKS_IN_PERIOD = Math.floor(BLOCKS_IN_ONE_HOUR * value);

          const blockHeights = Array.from(
            { length: interval },
            (_, i) => endBlock - BLOCKS_IN_PERIOD * i
          ).filter((block) => block > 1000000);
          // below 1000000 it throws 422 error

          const firstBlock = blockHeights[blockHeights.length - 1];
          console.log(`Fetching first block: ${firstBlock}`);
          const firstBlockDataForPeriod = await fetchFromRPC(
            {
              jsonrpc: "2.0",
              id: firstBlock,
              method: "block",
              params: { block_id: firstBlock },
            },
            false,
            useArchival
          );
          rpcCallCount++;
          // We interpolate the timestamps into 10 minute buckets to not
          // have to request the timestamp for each block from the RPC reducing
          // the RPC call with: (the amount of blocks || intervals) - 1
          const blockTimestamps = interpolateTimestampsToTenMinutes(
            firstBlockDataForPeriod.result.header.timestamp / 1e6,
            blockData.result.header.timestamp / 1e6,
            blockHeights.length
          ).reverse();

          const balances = await Promise.all(
            blockHeights.map(async (block_id) => {
              rpcCallCount++; // Increment counter for each balance request
              if (token_id === "near") {
                console.log(
                  `Viewing account for ${account_id} at block ${block_id} ${
                    useArchival
                      ? "using archival RPC"
                      : "using non-archival RPC"
                  }`
                );
                return fetchFromRPC(
                  {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "query",
                    params: {
                      request_type: "view_account",
                      block_id,
                      account_id,
                    },
                  },
                  false,
                  useArchival
                );
              } else {
                return fetchFromRPC(
                  {
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
                  },
                  false,
                  useArchival
                );
              }
            })
          );

          let userStakeBalances: any[] = [];
          if (token_id === "near") {
            // fetch all pools where user has staked near and get the balance for each at each blockheights
            userStakeBalances = await getUserStakeBalances(
              account_id,
              blockHeights,
              rpcCallCount,
              cache,
              useArchival
            );
          }

          const balanceHistory = blockTimestamps.map((timestamp, index) => {
            const balanceData = balances[index];
            const stakeBalance = userStakeBalances[index];
            const balanceMinimum = token_id === "near" ? "6" : "0";
            let balance = balanceMinimum;

            if (token_id === "near") {
              balance =
                balanceData?.result?.amount?.toString() || balanceMinimum;
              balance = (
                BigInt(balance) + BigInt(stakeBalance || 0)
              ).toString();
            } else if (balanceData?.result?.result) {
              balance = String.fromCharCode(...balanceData.result.result);
              balance = balance ? balance.replace(/"/g, "") : balanceMinimum;
            }

            return {
              timestamp,
              date: formatDate(timestamp, value),
              balance: balance
                ? convertFTBalance(balance, decimals)
                : balanceMinimum,
            };
          });

          return {
            period,
            // Sort the balance history by timestamp in ascending order
            data: balanceHistory.sort((a, b) => a.timestamp - b.timestamp),
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
        console.log(
          `Saving to database for ${account_id} and ${token_id} and ${period}`
        );
        await prisma.tokenBalanceHistory.create({
          data: { account_id, token_id, period, balance_history: data },
        });
      }
    });

    // Only save to cache if we have all data
    if (Object.values(respData).every((data) => data.length > 0)) {
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
          timestamp: "asc",
        },
        distinct: ["period"],
      });
      console.log(
        `439 Returning from cache for ${account_id} and ${token_id} and ${result.length} periods`
      );
      const resultJson = result.reduce(
        (acc: Record<string, any>, item: any) => {
          acc[item.period] = item.balance_history;
          return acc;
        },
        {}
      );

      return resultJson;
    } catch (error) {
      console.log(`Error in fallback getAllTokenBalanceHistory: ${error}`);
      return Object.fromEntries(periodMap.map(({ period }) => [period, []]));
    }
  }
}
