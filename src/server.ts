import express, { Request, Response } from "express"; // Import express and its types
import { searchToken } from "./utils/search-token";
import { promises as fs } from "fs"; // Using fs.promises to read the file
import path from "path";
import cors from "cors";
import Big from "big.js";
import * as dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from 'express-rate-limit';
import {
  BalanceResp,
  SmartRouter,
  Token,
} from "./utils/interface";
import { swapFromServer, unWrapNear, wrapNear } from "./utils/lib";
dotenv.config();

const app = express();
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = Number(process.env.PORT || 3000);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});

app.use(cors());
app.use(helmet());
app.use(express.json());
app.use("/api/", apiLimiter);

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
        price: priceData.price !== "N/A" ? Big(priceData.price ?? "").toFixed(4)  : priceData.price,
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

// Start the server
app.listen(port, hostname, 100, () => {
  console.log(`Server is running on http://${hostname}:${port}`);
});