import express, { Request, Response } from "express"; // Import express and its types
import { searchToken } from "./utils/search-token";
import { promises as fs } from "fs"; // Using fs.promises to read the file
import path from "path";
import cors from "cors";
import {
  EstimateSwapView,
  Transaction,
  WRAP_NEAR_CONTRACT_ID,
  estimateSwap,
  fetchAllPools,
  ftGetStorageBalance,
  getExpectedOutputFromSwapTodos,
  getStablePools,
  instantSwap,
  nearDepositTransaction,
  nearWithdrawTransaction,
  percentLess,
  registerAccountOnToken,
  scientificNotationToString,
  separateRoutes,
} from "@ref-finance/ref-sdk";
import Big from "big.js";

const app = express();
const port = 3003;

interface BalanceResp {
  balance: string;
  contract_id: string;
  last_update_block_height: string | null;
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
      const balancesResp = await fetch(
        `https://api.fastnear.com/v1/account/${account}/ft`
      );
      userBalances = (await balancesResp.json())?.tokens ?? [];
      const nearBalanceResp = await (
        await fetch(`https://api.nearblocks.io/v1/account/${account}`)
      ).json();
      // update near balance
      const contractIdToUpdate = "near";
      const nearBalance = nearBalanceResp?.account?.[0]?.amount ?? "0";
      const index = userBalances.findIndex(
        (i) => i.contract_id === contractIdToUpdate
      );

      if (index !== -1) {
        userBalances[index].balance = nearBalance;
      } else {
        userBalances.push({
          contract_id: contractIdToUpdate,
          balance: nearBalance,
          last_update_block_height: null,
        });
      }
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
      tokens[id].balance =
        userBalances.find((i: BalanceResp) => i.contract_id === id)?.balance ??
        "0";
      tokens[id].parsedBalance = Big(tokens[id].balance)
        .div(Big(10).pow(tokens[id]?.decimals))
        .toFixed(4);
    });

    const sortedTokens = Object.values(tokens).sort((a, b) => {
      const balanceA = parseFloat(a.balance);
      const balanceB = parseFloat(b.balance);
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
    const { ratedPools, unRatedPools, simplePools } = await fetchAllPools();
    const stablePools = unRatedPools.concat(ratedPools);
    const stablePoolsDetail = await getStablePools(stablePools);
    const tokenInData = await searchToken(tokenIn as string);
    const tokenOutData = await searchToken(tokenOut as string);

    if (!tokenInData || !tokenOutData) {
      return {
        error: `Unable to find token(s) tokenInData: ${tokenInData?.name} tokenOutData: ${tokenOutData?.name}`,
      };
    }

    const sendAmount = amountIn;
    if (tokenInData.id === tokenOutData.id) {
      if (tokenInData.id === WRAP_NEAR_CONTRACT_ID) {
        return {
          error:
            "This endpoint does not support wrapping / unwrap NEAR directly",
        };
      }
      return { error: "TokenIn and TokenOut cannot be the same" };
    }

    const refEstimateSwap = (enableSmartRouting: boolean) => {
      return estimateSwap({
        tokenIn: tokenInData,
        tokenOut: tokenOutData,
        amountIn: sendAmount as string,
        simplePools,
        options: {
          enableSmartRouting,
          stablePools,
          stablePoolsDetail,
        },
      });
    };

    const swapTodos: EstimateSwapView[] = await refEstimateSwap(true).catch(
      () => {
        return refEstimateSwap(false); // fallback to non-smart routing if unsupported
      }
    );

    const transactionsRef: Transaction[] = await instantSwap({
      tokenIn: tokenInData,
      tokenOut: tokenOutData,
      amountIn: sendAmount as string,
      swapTodos,
      slippageTolerance: slippage as unknown as number, // in decimals
      AccountId: accountId as string,
    });

    // const tokenInStorage = await ftGetStorageBalance(tokenInData.id, accountId as string)
    // const tokenOutStorage =   await ftGetStorageBalance(tokenOutData.id, accountId as string)

    // if(!tokenInStorage){
    //   transactions.unshift({
    //     receiverId: WRAP_NEAR_CONTRACT_ID,
    //     functionCalls: [registerAccountOnToken()],
    //   });
    // }
    if (tokenInData.id === WRAP_NEAR_CONTRACT_ID) {
      transactionsRef.splice(
        -1,
        0,
        nearDepositTransaction(sendAmount as string)
      );
    }

    const outEstimate = getExpectedOutputFromSwapTodos(
      swapTodos,
      tokenOutData.id
    );

    if (tokenOutData.id === WRAP_NEAR_CONTRACT_ID) {
      const routes = separateRoutes(swapTodos, tokenOutData.id);

      const bigEstimate = routes.reduce((acc, cur) => {
        const curEstimate = Big(cur[cur.length - 1].estimate);
        return acc.add(curEstimate);
      }, outEstimate);

      const minAmountOut = percentLess(
        0.01,
        scientificNotationToString(bigEstimate.toString())
      );

      transactionsRef.push(nearWithdrawTransaction(minAmountOut));
    }

    return res.json({
      transactions: transactionsRef,
      outEstimate: Big(outEstimate).toFixed(5),
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      error: "An error occurred while fetching token metadata",
    });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
