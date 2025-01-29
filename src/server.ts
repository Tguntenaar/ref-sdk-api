import express, { Request, Response } from "express"; // Import express and its types
import { searchToken } from "./utils/search-token";
import { promises as fs } from "fs"; // Using fs.promises to read the file
import path from "path";
import cors from "cors";
import Big from "big.js";
import * as dotenv from "dotenv";
import helmet from "helmet";
import axios from "axios";
import rateLimit from "express-rate-limit";
import { BalanceResp, SmartRouter, Token } from "./utils/interface";
import {
  deduplicateByTimestamp,
  fetchAdditionalPage,
  fetchPikespeakEndpoint,
  sortByDate,
  swapFromServer,
  unWrapNear,
  wrapNear,
} from "./utils/lib";
dotenv.config();

const app = express();
app.set("trust proxy", 1);
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = Number(process.env.PORT || 3000);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minutes
  max: 180, // limit each IP to 100 requests per minute
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

      if (!response.ok) {
        throw new Error(`HTTP error on rpc call! status: ${response.status}`);
      }

      const data = await response.json();

      // Check for RPC errors
      if (data.error) {
        throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
      }

      // Validate the response has required data
      if (!data.result) {
        throw new Error("Invalid response: missing result");
      }

      return data;
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      // Exponential backoff: 1s, 2s, 4s
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, i))
      );
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
    const blockHeights = Array.from(
      { length: parsedInterval },
      (_, i) => endBlock - BLOCKS_IN_PERIOD * i
    ).filter((block) => block > 0);

    // Fetch all blocks in parallel
    const blockPromises = blockHeights.map((block_id) =>
      fetchWithRetry({
        jsonrpc: "2.0",
        id: block_id,
        method: "block",
        params: { block_id },
      })
    );

    // Fetch all balances in parallel
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
        balance: balance
          ? convertFTBalance(balance, tokens[token_id as string].decimals)
          : "0",
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

app.get("/api/near-price", async (req: Request, res: Response) => {
  const cacheKey = `near-price`;
  const cachedData = cache.get(cacheKey);

  // Check if data exists in cache
  if (cachedData) {
    console.log(`Cached response for key: ${cacheKey}`);
    return res.json(cachedData);
  }

  // List of API endpoints to fetch NEAR price
  const apiEndpoints = [
    "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd",
    "https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT",
    "https://min-api.cryptocompare.com/data/price?fsym=NEAR&tsyms=USD",
  ];

  for (const endpoint of apiEndpoints) {
    try {
      const response = await axios.get(endpoint);
      let price: number | null = null;

      // Parse response based on the API used
      if (endpoint.includes("coingecko")) {
        price = response.data.near?.usd || null;
      } else if (endpoint.includes("binance")) {
        price = parseFloat(response.data.price) || null;
      } else if (endpoint.includes("cryptocompare")) {
        price = response.data.USD || null;
      }

      // If price is valid, cache and return it
      if (price) {
        console.log(`Fetched price from ${endpoint}: $${price}`);
        cache.set(cacheKey, price, 50); // for 50 seconds
        return res.json({ price, source: endpoint });
      }
    } catch (error: any) {
      console.error(`Error fetching price from ${endpoint}:`, error.message);
    }
  }

  // If all APIs fail
  return res
    .status(500)
    .json({ error: "Failed to fetch NEAR price from all sources." });
});

app.get("/api/ft-tokens", async (req: Request, res: Response) => {
  try {
    const { account_id } = req.query;

    if (!account_id || typeof account_id !== "string") {
      return res.status(400).json({ error: "Account ID is required" });
    }

    const cacheKey = `${account_id}-ft-tokens`;
    const cachedData = cache.get(cacheKey);

    // Check if data exists in cache
    if (cachedData) {
      console.log(`Cached response for key: ${cacheKey}`);
      return res.json(cachedData);
    }

    // Fetch data using Axios
    const { data } = await axios.get(
      `https://api3.nearblocks.io/v1/account/${account_id}/inventory`,
      {
        headers: {
          Authorization: `Bearer ${process.env.REPL_NEARBLOCKS_KEY}`,
        },
      }
    );

    const fts = data?.inventory?.fts;

    if (fts && Array.isArray(fts)) {
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

      return res.json(result);
    }

    // If no tokens are found
    return res.status(404).json({ error: "No FT tokens found" });
  } catch (error) {
    console.error("Error fetching FT tokens:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Helper function to format dates
function formatDate(timestamp: number, period: number): string {
  const date = new Date(timestamp);
  if (period <= 1) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: period >= 1 ? undefined : "numeric",
    });
  }

  if (period < 24 * 30) {
    return date.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
  }

  if (period === 24 * 30) {
    return date.toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
    });
  }

  return date.toLocaleDateString("en-US", { year: "numeric" });
}

// Add this new endpoint before the server.listen call
app.get(
  "/api/all-token-balance-history",
  async (req: Request, res: Response) => {
    const { account_id, token_id } = req.query;
    const forwardedFor =
      req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const cachekey = `all:${account_id}:${token_id}`;
    const cachedData = cache.get(cachekey);

    if (cachedData) {
      console.log(
        ` cached response for key: ${cachekey}, client: ${forwardedFor}`
      );
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

          const blockHeights = Array.from(
            { length: interval },
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

      cache.set(cachekey, respData);
      return res.json(respData);
    } catch (error) {
      cache.del(cachekey);
      console.error("Error fetching all balance history:", error);
      return res.status(500).json({ error: "Failed to fetch balance history" });
    }
  }
);

const totalTxnsPerPage = 20; // Return 20 items per page

app.get("/api/transactions-transfer-history", async (req, res) => {
  const { page = 1, lockupContract, treasuryDaoID } = req.query;

  if (!treasuryDaoID) {
    return res.status(400).send({ error: "treasuryDaoID is required" });
  }

  const requestedPage = parseInt(page as string, 10);
  const cacheKey = `${treasuryDaoID}-${lockupContract || "no-lockup"}`;

  // Retrieve cached raw data and timestamp (before sorting)
  let cachedData = cache.get(cacheKey) || [];
  let cachedTimestamp = cache.get(`${cacheKey}-timestamp`);

  const currentTime = Date.now();

  try {
    // If cache is empty or older than 10 minutes, fetch new data
    if (!cachedData || !cachedTimestamp) {
      const accounts: any[] = [treasuryDaoID];
      if (lockupContract) {
        accounts.push(lockupContract);
      }

      // Fetch transfers for all accounts (treasuryDaoID + lockupContract if provided)
      const latestPagePromises = accounts.flatMap((account) => [
        fetchPikespeakEndpoint(
          `https://api.pikespeak.ai/account/near-transfer/${account}?limit=${totalTxnsPerPage}&offset=0`
        ),
        fetchPikespeakEndpoint(
          `https://api.pikespeak.ai/account/ft-transfer/${account}?limit=${totalTxnsPerPage}&offset=0`
        ),
      ]);
      const latestPageResults = await Promise.all(latestPagePromises);

      if (latestPageResults.some((result: any) => !result.ok)) {
        return res
          .status(500)
          .send({ error: "Failed to fetch the latest page" });
      }

      const latestPageData = latestPageResults.flatMap(
        (result: any) => result.body
      );

      // Check for updates: Compare the raw API data (not sorted)
      const latestPageDataLength = latestPageData.length;
      const cachedSlice = cachedData.slice(0, latestPageDataLength); // Get the same length slice from the cached data

      // Only update if the latest page data differs from the cached slice
      if (
        cachedData.length === 0 ||
        JSON.stringify(latestPageData) !== JSON.stringify(cachedSlice)
      ) {
        console.log("Updates detected, fetching new data...");

        const updatedData = [...latestPageData, ...cachedData];

        // Deduplicate cached data based on timestamp
        cachedData = deduplicateByTimestamp(updatedData);
        cache.set(cacheKey, cachedData, 0);
        cache.set(`${cacheKey}-timestamp`, currentTime, 120);
      }
    }

    // Check if additional pages need to be fetched
    const totalCachedPages = Math.ceil(
      cachedData.length / (totalTxnsPerPage * 2)
    );

    if (requestedPage > totalCachedPages) {
      const additionalData = await fetchAdditionalPage(
        totalTxnsPerPage,
        treasuryDaoID as string,
        lockupContract as string | null,
        totalCachedPages
      );

      // Add the newly fetched data and deduplicate it
      cachedData = [...cachedData, ...additionalData];
      cachedData = deduplicateByTimestamp(cachedData);

      // Save the updated data to the cache
      cache.set(cacheKey, cachedData, 0);
      cache.set(`${cacheKey}-timestamp`, currentTime, 120);
    }

    const endIndex = requestedPage * totalTxnsPerPage;
    const pageData = sortByDate(cachedData.slice(0, endIndex));

    return res.send({
      data: pageData,
    });
  } catch (error) {
    console.error("Error fetching data:", error);
    return res.status(500).send({ error: "An error occurred" });
  }
});

// Start the server
app.listen(port, hostname, 100, () => {
  console.log(`Server is running on http://${hostname}:${port}`);
});
