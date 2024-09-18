import express, { Request, Response } from "express"; // Import express and its types
import { searchToken } from "./utils/search-token";
import { promises as fs } from "fs"; // Using fs.promises to read the file
import path from "path";
import cors from "cors";
import {
  WRAP_NEAR_CONTRACT_ID,
  ftGetStorageBalance,
  nearDepositTransaction,
  nearWithdrawTransaction,
  percentLess,
  registerAccountOnToken,
  scientificNotationToString,
} from "@ref-finance/ref-sdk";
import Big from "big.js";
import * as dotenv from "dotenv";
dotenv.config();

const app = express();
const port = 3003;

interface BalanceResp {
  amount: number;
  contract: string;
  symbol: string;
}

interface Token {
  id: string;
  name: string;
  symbol: string;
  icon: string;
  price: string;
  balance: string;
  parsedBalance: string;
  decimals: number;
}

interface Pool {
  pool_id: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
}

interface Routes {
  pools: Pool[];
  amount_in: string;
  min_amount_out: string;
}

app.use(cors());
app.use(express.json());

app.get("/token-metadata", async (req: Request, res: Response) => {
  try {
    const { token } = req.query;
    const filePath = path.join(__dirname, "tokens.json");
    const data = await fs.readFile(filePath, "utf-8");
    const tokens: Record<string, Token> = JSON.parse(data);
    res.json(tokens[token as string]);
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      error: "An error occurred while fetching token metadata",
    });
  }
});

app.get("/whitelist-tokens", async (req: Request, res: Response) => {
  try {
    const { account } = req.query;
    const filePath = path.join(__dirname, "tokens.json");
    const data = await fs.readFile(filePath, "utf-8");
    const tokens: Record<string, Token> = JSON.parse(data);
    let userBalances: BalanceResp[] = [];

    // Fetch prices and balances of the tokens
    if (account) {
      const headers: HeadersInit = {
        "Content-Type": "application/json",
      };
      const apiKey = process.env.PIKESPEAK_KEY;
      if (apiKey) {
        headers["x-api-key"] = apiKey;
      }
      userBalances = await (
        await fetch(`https://api.pikespeak.ai/account/balance/${account}`, {
          method: "GET",
          headers,
        })
      ).json();

      userBalances = userBalances.filter( i => i.symbol !== "NEAR [Storage]")
    }

    const tokenIds = Object.keys(tokens);
    const tokenMetadataPromises = tokenIds.map((id) => {
      return fetch(
        `https://api.ref.finance/get-token-price?token_id=${
          id === "near" ? "wrap.near" : id
        }`
      )
        .then((res) => {
          if (!res.ok) {
            // Handle non-200 responses
            throw new Error(
              `Failed to fetch for token_id ${id}: ${res.statusText}`
            );
          }
          return res.json().catch(() => {
            // Handle invalid JSON responses
            throw new Error(`Invalid JSON response for token_id ${id}`);
          });
        })
        .catch((err) => {
          // Handle fetch errors
          console.error(err.message);
          return { price: "N/A" }; // Return null or handle appropriately
        });
    });

    // Wait for all metadata fetches to complete
    const tokenMetadataResponses = await Promise.all(tokenMetadataPromises);

    // Update tokens with fetched prices and balances
    tokenIds.forEach((id, index) => {
      const resp = tokenMetadataResponses[index];
      tokens[id].price = resp?.price ?? "0";
      tokens[id].parsedBalance =
        userBalances.find((i: BalanceResp) => i.contract.toLowerCase() === id)?.amount.toString() ??
        "0";
      tokens[id].balance = Big(tokens[id].parsedBalance)
        .mul(Big(10).pow(tokens[id]?.decimals))
        .toFixed(4);
    });

    const sortedTokens = Object.values(tokens).sort((a, b) => {
      const balanceA = parseFloat(a.parsedBalance);
      const balanceB = parseFloat(b.parsedBalance);
      return balanceB - balanceA; // Sort in descending order
    });

    return res.json(sortedTokens);
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      error: "An error occurred while fetching whitelisted tokens",
    });
  }
});

app.get("/swap", async (req: Request, res: Response) => {
  const { accountId, tokenIn, tokenOut, amountIn, slippage } = req.query;

  try {
    const tokenInData = await searchToken(tokenIn as string);
    const tokenOutData = await searchToken(tokenOut as string);

    if (!tokenInData || !tokenOutData) {
      return {
        error: `Unable to find token(s) tokenInData: ${tokenInData?.name} tokenOutData: ${tokenOutData?.name}`,
      };
    }

    if (tokenInData.id === tokenOutData.id) {
      if (tokenInData.id === WRAP_NEAR_CONTRACT_ID) {
        return {
          error:
            "This endpoint does not support wrapping / unwrap NEAR directly",
        };
      }
      return { error: "TokenIn and TokenOut cannot be the same" };
    }

    const sendAmount = Big(amountIn as string)
      .mul(Big(10).pow(tokenInData.decimals))
      .toFixed();
    const swapRes = await (
      await fetch(
        `https://smartrouter.ref.finance/findPath?amountIn=${sendAmount}&tokenIn=${tokenInData.id}&tokenOut=${tokenOutData.id}&pathDeep=3&slippage=${slippage}`
      )
    ).json();
    const routes = swapRes.result_data.routes.flatMap(
      (route: Routes) => route.pools
    );

    const receiveAmount = Big(swapRes.result_data.amount_out)
      .div(Big(10).pow(tokenOutData.decimals))
      .toFixed();

    const transactions = [];
    const tokenInStorage = await ftGetStorageBalance(
      tokenInData.id,
      accountId as string
    );
    const tokenOutStorage = await ftGetStorageBalance(
      tokenOutData.id,
      accountId as string
    );

    if (tokenInData.id === WRAP_NEAR_CONTRACT_ID) {
      transactions.unshift(nearDepositTransaction(amountIn as string));
    }

    transactions.push({
      receiverId: tokenInData.id,
      functionCalls: [
        {
          methodName: "ft_transfer_call",
          args: {
            receiver_id: "v2.ref-finance.near",
            amount: sendAmount,
            msg: JSON.stringify({
              force: 0,
              actions: routes.flat().map((action: Pool) => ({
                pool_id: parseInt(action.pool_id),
                token_in: action.token_in,
                token_out: action.token_out,
                amount_in: action.amount_in,
                min_amount_out: action.min_amount_out,
              })),
            }),
          },
          gas: "180000000000000",
          amount: "1",
        },
      ],
    });

    if (tokenOutData.id === WRAP_NEAR_CONTRACT_ID) {
      const minAmountOut = percentLess(
        0.01,
        scientificNotationToString(receiveAmount.toString())
      );

      transactions.push(nearWithdrawTransaction(minAmountOut));
    }

    if (!tokenInStorage) {
      transactions.unshift({
        receiverId: tokenInData.id,
        functionCalls: [registerAccountOnToken(accountId as string)],
      });
    }
    if (!tokenOutStorage) {
      transactions.unshift({
        receiverId: tokenOutData.id,
        functionCalls: [registerAccountOnToken(accountId as string)],
      });
    }

    return res.json({
      transactions: transactions,
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
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
