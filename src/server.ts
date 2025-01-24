import express, { Request, Response } from "express"; // Import express and its types
import { searchToken } from "./utils/search-token";
import { promises as fs } from "fs"; // Using fs.promises to read the file
import path from "path";
import cors from "cors";
import Big from "big.js";
import * as dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { BalanceResp, SmartRouter, Token } from "./utils/interface";
import { swapFromServer, unWrapNear, wrapNear } from "./utils/lib";
dotenv.config();

const app = express();
app.set('trust proxy', 1);
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = Number(process.env.PORT || 3000);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minutes
  max: 60, // limit each IP to 60 requests per minute
});

app.use(cors());
app.use(helmet());
app.use(express.json());
app.use("/api/", apiLimiter);

const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 }); // Cache for 10 min

// Add this constant at the top level of the file, after the imports
const periodMap = [
  { period: "1H", value: 1 / 6, interval: 6 },
  { period: "1D", value: 1, interval: 12 },
  { period: "1W", value: 24, interval: 8 },
  { period: "1M", value: 24 * 2, interval: 15 },
  { period: "1Y", value: 24 * 30, interval: 12 },
  { period: "All", value: 24 * 365, interval: 10 },
];

app.get("/api/token-metadata", async (req: Request, res: Response) => {
  try {
    const { token } = req.query as { token: string };
    const filePath = path.join(__dirname, "tokens.json");
    const data = await fs.readFile(filePath, "utf-8");
    const tokens: Record<string, Token> = JSON.parse(data);
    res.json(tokens[token]);
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      error: "An error occurred while fetching token metadata",
    });
  }
});

app.get("/api/whitelist-tokens", async (req: Request, res: Response) => {
  try {
    const { account } = req.query;
    const filePath = path.join(__dirname, "tokens.json");
    const data = await fs.readFile(filePath, "utf-8");
    const tokens: Record<string, Token> = JSON.parse(data);

    // Fetch prices and balances concurrently
    const fetchBalancesPromise = account
      ? fetch(`https://api.pikespeak.ai/account/balance/${account}`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.PIKESPEAK_KEY || "",
          },
        }).then((res) => res.json())
      : Promise.resolve([]);

    const fetchTokenPricePromises = Object.keys(tokens).map((id) => {
      return fetch(
        `https://api.ref.finance/get-token-price?token_id=${
          id === "near" ? "wrap.near" : id
        }`
      )
        .then((res) => res.json())
        .catch((err) => {
          console.error(
            `Error fetching price for token_id ${id}: ${err.message}`
          );
          return { price: "N/A" }; // Default value for failed fetches
        });
    });

    // Wait for both balances and token prices to resolve
    const [userBalances, tokenPrices] = await Promise.all([
      fetchBalancesPromise,
      Promise.all(fetchTokenPricePromises),
    ]);

    const filteredBalances = userBalances.filter(
      (i: any) => i.symbol !== "NEAR [Storage]"
    );

    // Map over tokens to include only the required fields
    const simplifiedTokens = Object.keys(tokens).map((id, index) => {
      const token = tokens[id];
      const priceData = tokenPrices[index];

      const parsedBalance =
        filteredBalances
          .find((i: BalanceResp) => i.contract.toLowerCase() === id)
          ?.amount.toString() || "0";

      const balance = Big(parsedBalance)
        .mul(Big(10).pow(token.decimals))
        .toFixed(4);

      return {
        id,
        decimals: token.decimals,
        parsedBalance,
        balance,
        price:
          priceData.price !== "N/A"
            ? Big(priceData.price ?? "").toFixed(4)
            : priceData.price,
        symbol: token.symbol,
        name: token.name,
        icon: token.icon,
      };
    });

    // Return sorted tokens based on balance (optional step)
    const sortedTokens = simplifiedTokens.sort(
      (a, b) => parseFloat(b.parsedBalance) - parseFloat(a.parsedBalance)
    );

    return res.json(sortedTokens);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "An error occurred while fetching tokens and balances",
    });
  }
});

app.get("/api/swap", async (req: Request, res: Response) => {
  const { accountId, tokenIn, tokenOut, amountIn, slippage } = req.query as {
    accountId: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    slippage: string;
  };

  try {
    const isWrapNearInputToken = tokenIn === "wrap.near";
    const isWrapNearOutputToken = tokenOut === "wrap.near";
    const tokenInData = await searchToken(tokenIn);
    const tokenOutData = await searchToken(tokenOut);

    if (!tokenInData || !tokenOutData) {
      return res.status(404).json({
        error: `Unable to find token(s) tokenInData: ${tokenInData?.name} tokenOutData: ${tokenOutData?.name}`,
      });
    }

    // (un)wrap NEAR
    if (tokenInData.id === tokenOutData.id) {
      if (isWrapNearInputToken && !isWrapNearOutputToken) {
        return res.json({
          transactions: [await unWrapNear({ amountIn })],
          outEstimate: amountIn,
        });
      }

      if (!isWrapNearInputToken && isWrapNearOutputToken) {
        return res.json({
          transactions: [await wrapNear({ amountIn, accountId })],
          outEstimate: amountIn,
        });
      }
    }

    const sendAmount = Big(amountIn)
      .mul(Big(10).pow(tokenInData.decimals))
      .toFixed();
    const swapRes: SmartRouter = await (
      await fetch(
        `https://smartrouter.ref.finance/findPath?amountIn=${sendAmount}&tokenIn=${tokenInData.id}&tokenOut=${tokenOutData.id}&pathDeep=3&slippage=${slippage}`
      )
    ).json();

    const receiveAmount = Big(swapRes.result_data.amount_out)
      .div(Big(10).pow(tokenOutData.decimals))
      .toFixed();

    const swapTxns = await swapFromServer({
      tokenIn: tokenInData,
      tokenOut: tokenOutData,
      amountIn: amountIn,
      accountId: accountId,
      swapsToDoServer: swapRes.result_data,
    });

    return res.json({
      transactions: swapTxns,
      outEstimate: Big(receiveAmount).toFixed(5),
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      error: "An error occurred while creating swap",
    });
  }
});

function convertFTBalance(value: string, decimals: number) {
  return (parseFloat(value) / Math.pow(10, decimals)).toFixed(2);
}

async function fetchWithRetry(body: any, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch("https://archival-rpc.mainnet.near.org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return await response.json();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * i));
    }
  }
}

app.get("/api/token-balance-history", async (req: Request, res: Response) => {
  const { account_id, period, token_id, interval } = req.query;
  const cachekey = `${account_id}:${period}:${interval}:${token_id}`;
  const cachedData = cache.get(cachekey);

  if (cachedData) {
    console.log(` cached response for key: ${cachekey}`);
    return res.json(cachedData);
  }

  const parsedInterval = parseInt(interval as string);
  const parsedPeriod = parseFloat(period as string);

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

    // Prepare all block heights we need to fetch
    const blockHeights = Array.from({ length: parsedInterval }, (_, i) => 
      endBlock - BLOCKS_IN_PERIOD * i
    ).filter(block => block > 0);

    // Fetch all blocks in parallel
    const blockPromises = blockHeights.map(block_id =>
      fetchWithRetry({
        jsonrpc: "2.0",
        id: block_id,
        method: "block",
        params: { block_id },
      })
    );

    // Fetch all balances in parallel
    const balancePromises = blockHeights.map(block_id => {
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

    // Wait for all requests to complete
    const [blocks, balances] = await Promise.all([
      Promise.all(blockPromises),
      Promise.all(balancePromises),
    ]);

    // Process results
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
        balance: balance ? convertFTBalance(balance, tokens[token_id as string].decimals) : "0",
      };
    });

    const respData = balanceHistory.reverse();
    cache.set(cachekey, respData);
    return res.json(respData);

  } catch (error) {
    cache.del(cachekey);
    console.error("Error fetching balance history:", error);
    return res.status(500).json({ error: "Failed to fetch balance history" });
  }
});

// Helper function to format dates
function formatDate(timestamp: number, period: number): string {
  const date = new Date(timestamp);
  if (period <= 1) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: period >= 1 ? undefined : "numeric"
    });
  }
  
  if (period < 24 * 30) {
    return date.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
  }
  
  if (period === 24 * 30) {
    return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  }
  
  return date.toLocaleDateString("en-US", { year: "numeric" });
}

// Add this new endpoint before the server.listen call
app.get("/api/all-token-balance-history", async (req: Request, res: Response) => {
  const { account_id, token_id } = req.query;
  const cachekey = `all:${account_id}:${token_id}`;
  const cachedData = cache.get(cachekey);

  if (cachedData) {
    console.log(` cached response for key: ${cachekey}`);
    return res.json(cachedData);
  }

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

    // Fetch balance history for each period
    const allPeriodHistories = await Promise.all(
      periodMap.map(async ({ period, value, interval }) => {
        const BLOCKS_IN_PERIOD = Math.floor(BLOCKS_IN_ONE_HOUR * value);
        
        const blockHeights = Array.from({ length: interval }, (_, i) => 
          endBlock - BLOCKS_IN_PERIOD * i
        ).filter(block => block > 0);

        const blockPromises = blockHeights.map(block_id =>
          fetchWithRetry({
            jsonrpc: "2.0",
            id: block_id,
            method: "block",
            params: { block_id },
          })
        );

        const balancePromises = blockHeights.map(block_id => {
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
            date: formatDate(timestamp, value),
            balance: balance ? convertFTBalance(balance, tokens[token_id as string].decimals) : "0",
          };
        });

        return {
          period,
          data: balanceHistory.reverse()
        };
      })
    );

    const respData = Object.fromEntries(
      allPeriodHistories.map(({ period, data }) => [period, data])
    );

    cache.set(cachekey, respData);
    return res.json(respData);

  } catch (error) {
    cache.del(cachekey);
    console.error("Error fetching all balance history:", error);
    return res.status(500).json({ error: "Failed to fetch balance history" });
  }
});

// Start the server
app.listen(port, hostname, 100, () => {
  console.log(`Server is running on http://${hostname}:${port}`);
});
