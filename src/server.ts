import express, { Request, Response } from "express";
import cors from "cors";
import * as dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { getWhitelistTokens } from "./whitelist-tokens";
import { getSwap, SwapParams } from "./swap";
import { getNearPrice } from "./near-price";
import { getFTTokens } from "./ft-tokens";
import { getAllTokenBalanceHistory } from "./all-token-balance-history";
import { getTransactionsTransferHistory, TransferHistoryParams } from "./transactions-transfer-history";
import prisma from "./prisma";
import { tokens } from "./constants/tokens";
import { getSingleTokenBalanceHistory } from "./single-token-balance-history";
import { periodMap } from "./constants/period-map";
dotenv.config();

const app = express();
app.set("trust proxy", 1);
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = Number(process.env.PORT || 3000);

const apiLimiter = rateLimit({
  windowMs: 30 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use forwarded IP if available, otherwise use the direct IP
    return req.ip || req.connection.remoteAddress || 'unknown';
  }
});

app.use(cors());
app.use(helmet());
app.use(express.json());
app.use("/api/", apiLimiter);

const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 30, checkperiod: 30 }); // Cache for 30 sec

app.get("/api/token-metadata", async (req: Request, res: Response) => {
  try {
    const { token } = req.query as { token: string };
    const tokenMetadata = tokens[token as keyof typeof tokens];
    if (!tokenMetadata) {
      return res.status(500).json({
        error: "An error occurred while fetching token metadata",
      });
    }
    res.json(tokenMetadata);
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      error: "An error occurred while fetching token metadata",
    });
  }
});

app.get("/api/whitelist-tokens", async (req: Request, res: Response) => {
  try {
    const { account } = req.query as { account?: string | string[] };
    const tokens = await getWhitelistTokens(account);
    return res.json(tokens);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "An error occurred while fetching tokens and balances",
    });
  }
});

app.get("/api/swap", async (req: Request, res: Response) => {
  try {
    const params = req.query as SwapParams;
    
    // Validate required parameters
    if (!params.accountId || !params.tokenIn || !params.tokenOut || !params.amountIn) {
      return res.status(400).json({
        error: "Missing required parameters. Required: accountId, tokenIn, tokenOut, amountIn"
      });
    }

    // Set default slippage if not provided
    if (!params.slippage) {
      params.slippage = "0.01"; // 1% default slippage
    }

    const result = await getSwap(params);
    return res.json(result);
  } catch (error) {
    console.error("Error in /api/swap:", error);
    if (error instanceof Error) {
      return res.status(500).json({
        error: error.message
      });
    }
    return res.status(500).json({
      error: "An unexpected error occurred while creating swap"
    });
  }
});

app.get("/api/near-price", async (req: Request, res: Response) => {
  try {
    const result = await getNearPrice(cache);
    return res.json(result);
  } catch (error) {
    try {
      const response = await prisma.nearPrice.findFirst({
       orderBy: {
        timestamp:'desc'
       }
      })
      return res.status(200).json(response?.price);
    } catch (error) {
      return res.status(500).json({ 
        error: "Failed to fetch NEAR price from all sources." 
      });
    }
  }
});

app.get("/api/ft-tokens", async (req: Request, res: Response) => {
  try {
    const { account_id } = req.query;

    if (!account_id || typeof account_id !== "string") {
      return res.status(400).json({ error: "Account ID is required" });
    }

    const result = await getFTTokens(account_id, cache);
    return res.json(result);
  } catch (error) {
    const result = await prisma.fTToken.findFirst({
      where: {
        account_id: req.query.account_id as string,
      },
      orderBy: {
        timestamp: 'desc'
      }
    });
    console.error("Error fetching FT tokens:", error);
    if (error instanceof Error && error.message === "No FT tokens found") {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
});


// Add this new endpoint before the server.listen call
app.get("/api/all-token-balance-history", async (req: Request, res: Response) => {
  const { account_id, token_id, disableCache } = req.query;

  if (!account_id || !token_id || typeof account_id !== "string" || typeof token_id !== "string") {
    return res.status(400).json({ error: "Missing required parameters account_id and token_id" });
  }

  try {
    const multipleUserKey = `all:${account_id}:${token_id}`;
    const isCached = cache.get(multipleUserKey);
    if (isCached && !disableCache) {
      console.log(`Cache hit for all-token-balance-history for ${account_id} and ${token_id}`);
      return res.json(isCached);
    }
  
    // This happens when it is not cached and the front end is requesting 3x in a second due to BOS limitations with config
    const ip = req.ip;
    const tooManyRequestKey = `all-token-balance-history:${ip}:${account_id}:${token_id}`;
    if (cache.get(tooManyRequestKey)) {
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
      return res.status(200).json(resultJson);
    }

    cache.set(tooManyRequestKey, true, 2);
    
    const result = await getAllTokenBalanceHistory(cache, multipleUserKey, account_id, token_id);

    return res.json(result);
  } catch (error) {
    console.error("Error fetching all balance history:", error);

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


    const resultJson = result.reduce((acc: Record<string, any>, item) => {
      acc[item.period] = item.balance_history;
      return acc;
    }, {});
    return res.status(200).json(resultJson);
  }
});

app.get("/api/single-token-balance-history", async (req: Request, res: Response) => {
  const { account_id, token_id, period, disableCache } = req.query;

  if (!account_id || !token_id || !period || typeof account_id !== "string" || typeof token_id !== "string" || typeof period !== "string") {
    return res.status(400).json({ error: "Missing required parameters account_id, token_id, and period" });
  }

  // Find the requested period in the periodMap
  const periodConfig = periodMap.find(p => p.period === period);
  if (!periodConfig) {
  return res.status(400).json({ error: `Invalid period: ${period}. Valid periods are: ${periodMap.map(p => p.period).join(', ')}` });
  }

  try {
    const singlePeriodKey = `single:${account_id}:${token_id}:${period}`;
    const isCached = cache.get(singlePeriodKey);
    if (isCached && !disableCache) {
      console.log(`Cache hit for single-token-balance-history for ${account_id}, ${token_id}, and period ${period}`);
      return res.json(isCached);
    }
  
    // Handle too many requests similar to all-token-balance-history
    const ip = req.ip;
    const tooManyRequestKey = `single-token-balance-history:${ip}:${account_id}:${token_id}:${period}`;
    if (cache.get(tooManyRequestKey)) {
      const result = await prisma.tokenBalanceHistory.findFirst({
        where: {
          account_id,
          token_id,
          period
        },
        orderBy: {
          timestamp: 'desc'
        }
      });
      console.log(`Returning from cache for ${account_id}, ${token_id}, and period ${period}`);
      if (result) {
        return res.status(200).json({ [period]: result.balance_history });
      }
      return res.status(404).json({ error: "No data found for the specified period" });
    }

    cache.set(tooManyRequestKey, true, 2);
    
    const result = await getSingleTokenBalanceHistory(cache, singlePeriodKey, account_id, token_id, periodConfig);

    return res.json(result);
  } catch (error) {
    console.error("Error fetching single period balance history:", error);

    const result = await prisma.tokenBalanceHistory.findFirst({
      where: {
        account_id,
        token_id,
        period
      },
      orderBy: {
        timestamp: 'desc'
      }
    });

    if (result) {
      return res.status(200).json({ [period]: result.balance_history });
    }
    return res.status(404).json({ error: "No data found for the specified period" });
  }
});

// Create a endpoint that removes all TokenBalanceHistory from the database
app.delete("/api/clear-token-balance-history", async (req: Request, res: Response) => {
  await prisma.tokenBalanceHistory.deleteMany();
  return res.status(200).json({ message: "All TokenBalanceHistory removed from the database" });
});

app.get("/api/transactions-transfer-history", async (req: Request, res: Response) => {
  try {
    const params = req.query as TransferHistoryParams;
    
    if (!params.treasuryDaoID) {
      return res.status(400).send({ error: "treasuryDaoID is required" });
    }

    const data = await getTransactionsTransferHistory(params, cache);
    return res.send({ data });
  } catch (error) {
    console.error("Error fetching data:", error);
    return res.status(500).send({ error: "An error occurred" });
  }
});

// Start the server
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, hostname, () => {
    console.log(`Server is running on http://${hostname}:${port}`);
  });
}

export default app;
