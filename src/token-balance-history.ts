import { promises as fs } from "fs";
import path from "path";
import { Token } from "./utils/interface";
import { fetchWithRetry } from "./utils/fetch-with-retry";
import { formatDate } from "./utils/format-date";
import { convertFTBalance } from "./utils/convert-ft-balance";
export type TokenBalanceHistoryParams = {
  account_id: string;
  period: string;
  token_id: string;
  interval: string;
};


export async function getTokenBalanceHistory(
  params: TokenBalanceHistoryParams,
  cache: any
) {
  const { account_id, period, token_id, interval } = params;
  const cacheKey = `${account_id}:${period}:${interval}:${token_id}`;
  const cachedData = cache.get(cacheKey);

  if (cachedData) {
    console.log(` cached response for key: ${cacheKey}`);
    return cachedData;
  }

  const parsedInterval = parseInt(interval);
  const parsedPeriod = parseFloat(period);

  const filePath = path.join(__dirname, "tokens.json");
  const data = await fs.readFile(filePath, "utf-8");
  const tokens: Record<string, Token> = JSON.parse(data);

  try {
    const blockData = await fetchWithRetry({
      jsonrpc: "2.0",
      id: 1,
      method: "block",
      params: { finality: "final" },
    });

    if (!blockData.result) {
      throw new Error("Failed to fetch latest block");
    }

    const endBlock = blockData.result.header.height;
    const BLOCKS_IN_ONE_HOUR = 3200;
    const BLOCKS_IN_PERIOD = Math.floor(BLOCKS_IN_ONE_HOUR * parsedPeriod);

    const blockHeights = Array.from(
      { length: parsedInterval },
      (_, i) => endBlock - BLOCKS_IN_PERIOD * i
    ).filter((block) => block > 0);

    const blockPromises = blockHeights.map((block_id) =>
      fetchWithRetry({
        jsonrpc: "2.0",
        id: block_id,
        method: "block",
        params: { block_id },
      })
    );

    const balancePromises = blockHeights.map((block_id) => {
      if (token_id === "near") {
        return fetchWithRetry({
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
        return fetchWithRetry({
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
        date: formatDate(timestamp, parsedPeriod),
        balance: balance
          ? convertFTBalance(balance, tokens[token_id].decimals)
          : "0",
      };
    });

    const respData = balanceHistory.reverse();
    cache.set(cacheKey, respData);
    return respData;
  } catch (error) {
    cache.del(cacheKey);
    throw error;
  }
}
