import { promises as fs } from "fs";
import path from "path";
import { Token } from "./utils/interface";
import { fetchFromRPC } from "./utils/fetch-with-retry";
import { formatDate } from "./utils/format-date";
import { convertFTBalance } from "./utils/convert-ft-balance";

type AllTokenBalanceHistoryCache = {
  get: (key: string) => any;
  set: (key: string, value: any, ttl?: number) => void;
  del: (key: string) => void;
};

export type AllTokenBalanceHistoryParams = {
  account_id: string | string[];
  token_id: string | string[];
  forwardedFor: string | string[];
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
  params: AllTokenBalanceHistoryParams,
  cache: AllTokenBalanceHistoryCache
) {
  const { account_id, token_id, forwardedFor } = params;
  const cacheKey = `all:${account_id}:${token_id}`;
  const cachedData = cache.get(cacheKey);

  if (cachedData) {
    console.log(
      ` cached response for key: ${cacheKey}, client: ${forwardedFor}`
    );
    return cachedData;
  }

  const filePath = path.join(__dirname, "tokens.json");
  const data = await fs.readFile(filePath, "utf-8");
  const tokens: Record<string, Token> = JSON.parse(data);
  
  try {
    const blockData = await fetchFromRPC({
      jsonrpc: "2.0",
      id: 1,
      method: "block",
      params: { finality: "final" },
    }, true);

    if (!blockData.result) {
      throw new Error("Failed to fetch latest block");
    }

    const endBlock = blockData.result.header.height;
    const BLOCKS_IN_ONE_HOUR = 3200;

    // Fetch balance history for each period
    const allPeriodHistories = await Promise.all(
      periodMap.map(async ({ period, value, interval }) => {
        const BLOCKS_IN_PERIOD = Math.floor(BLOCKS_IN_ONE_HOUR * value);

        const blockHeights = Array.from(
          { length: interval },
          (_, i) => endBlock - BLOCKS_IN_PERIOD * i
        ).filter((block) => block > 0);

        const blockPromises = blockHeights.map((block_id) =>
          fetchFromRPC({
            jsonrpc: "2.0",
            id: block_id,
            method: "block",
            params: { block_id },
          })
        );

        const balancePromises = blockHeights.map((block_id) => {
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

          const timestamp = blockData.result.header.timestamp / 1e6;
          return {
            timestamp,
            date: formatDate(timestamp, value),
            balance: balance
              ? convertFTBalance(balance, tokens[token_id as string].decimals)
              : "0",
          };
        });

        return {
          period,
          data: balanceHistory.reverse(),
        };
      })
    );

    const respData = Object.fromEntries(
      allPeriodHistories.map(({ period, data }) => [period, data])
    );

    cache.set(cacheKey, respData);
    return respData;
  } catch (error) {
    cache.del(cacheKey);
    throw error;
  }
}
