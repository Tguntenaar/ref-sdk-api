import express, { Request, Response } from "express";
import cors from "cors";
import * as dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { getTokenMetadata } from "./token-metadata";
import { getWhitelistTokens } from "./whitelist-tokens";
import { getSwap, SwapParams } from "./swap";
import { getTokenBalanceHistory, TokenBalanceHistoryParams } from "./token-balance-history";
import { getNearPrice } from "./near-price";
import { getFTTokens } from "./ft-tokens";
import { getAllTokenBalanceHistory, AllTokenBalanceHistoryParams } from "./all-token-balance-history";
import { getTransactionsTransferHistory, TransferHistoryParams } from "./transactions-transfer-history";
import crypto from "crypto";
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

app.get("/api/token-metadata", async (req: Request, res: Response) => {
  try {
    const { token } = req.query as { token: string };
    const tokenMetadata = await getTokenMetadata(token);
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
    const result = await getSwap(params);
    return res.json(result);
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      error: "An error occurred while creating swap",
    });
  }
});


app.get("/api/token-balance-history", async (req: Request, res: Response) => {
  try {
    const params = req.query as TokenBalanceHistoryParams;
    const result = await getTokenBalanceHistory(params, cache);
    return res.json(result);
  } catch (error) {
    console.error("Error fetching balance history:", error);
    return res.status(500).json({ error: "Failed to fetch balance history" });
  }
});

app.get("/api/near-price", async (req: Request, res: Response) => {
  try {
    const result = await getNearPrice(cache);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ 
      error: "Failed to fetch NEAR price from all sources." 
    });
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
    console.error("Error fetching FT tokens:", error);
    if (error instanceof Error && error.message === "No FT tokens found") {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
});


const preventDub = new NodeCache({ stdTTL: 2, checkperiod: 2 });

// Add this new endpoint before the server.listen call
app.get(
  "/api/all-token-balance-history",
  async (req: Request, res: Response) => {
    const { account_id, token_id } = req.query;

    if (!account_id || !token_id) {
      return res.status(400).json({ error: "Missing required parameters" });
    }
  
    try {
      const ip = req.ip;
      const bodyHash = crypto.createHash('md5').update(JSON.stringify(req.query)).digest('hex');
      const forwardedFor = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

      const key = `${ip}:${bodyHash}:${forwardedFor}`;

      const isDuplicateRequest = preventDub.get(key);
      if (isDuplicateRequest) {
        return res.status(429).json({ error: "Too many requests" });
      }  
      
      // Set the cache to true for 2 seconds to prevent duplicate requests
      preventDub.set(key, true, 2);

      const params: AllTokenBalanceHistoryParams = {
        account_id: account_id as string | string[],
        token_id: token_id as string | string[],
        forwardedFor: forwardedFor as string | string[],
      };

      const result = await getAllTokenBalanceHistory(params, cache);

      return res.json(result);
    } catch (error) {
      console.error("Error fetching all balance history:", error);
      return res.status(500).json({ error: "Failed to fetch balance history" });
    }
  }
);

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
app.listen(port, hostname, () => {
  console.log(`Server is running on http://${hostname}:${port}`);
});
