import {
  FTStorageBalance,
  RefFiFunctionCallOptions,
  TokenMetadata,
  Transaction,
  WRAP_NEAR_CONTRACT_ID,
  ftGetStorageBalance,
  ftViewFunction,
} from "@ref-finance/ref-sdk";
import { SwapOptions } from "./interface";
import Big from "big.js";

const NO_REQUIRED_REGISTRATION_TOKEN_IDS = [
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
];

export const STORAGE_TO_REGISTER_WITH_FT = "0.1";
export const STORAGE_TO_REGISTER_WITH_MFT = "0.1";

export const check_registration = (
  tokenId: string,
  accountId: string
): Promise<FTStorageBalance | null> => {
  return ftViewFunction(tokenId, {
    methodName: "check_registration",
    args: { account_id: accountId },
  });
};

export const native_usdc_has_upgrated = async (
  tokenId: string,
  accountId: string
) => {
  try {
    await ftViewFunction(tokenId, {
      methodName: "storage_balance_of",
      args: { account_id: accountId },
    });
    return true;
  } catch (error) {
    await check_registration(tokenId, accountId).then((is_registration) => {
      if (is_registration) {
        return new Promise((resove) => {
          resove({ available: "1", total: "1" });
        });
      } else {
        return new Promise((resove) => {
          resove(null);
        });
      }
    });
    return false;
  }
};

export const toNonDivisibleNumber = (
  decimals: number,
  number: string
): string => {
  if (decimals === null || decimals === undefined) return number;
  const [wholePart, fracPart = ""] = number.split(".");

  return `${wholePart}${fracPart.padEnd(decimals, "0").slice(0, decimals)}`
    .replace(/^0+/, "")
    .padStart(1, "0");
};

export const ONE_YOCTO_NEAR = "1";

export const swapFromServer = async ({
  tokenIn,
  tokenOut,
  amountIn,
  accountId,
  swapsToDoServer,
}: SwapOptions) => {
  const transactions: Transaction[] = [];
  const tokenOutActions: RefFiFunctionCallOptions[] = [];
  const { routes } = swapsToDoServer;
  const registerToken = async (token: TokenMetadata) => {
    const tokenRegistered = await ftGetStorageBalance(
      token.id,
      accountId
    ).catch(() => {
      throw new Error(`${token.id} doesn't exist.`);
    });

    if (tokenRegistered === null) {
      if (NO_REQUIRED_REGISTRATION_TOKEN_IDS.includes(token.id)) {
        const r = await native_usdc_has_upgrated(token.id, accountId);
        if (r) {
          tokenOutActions.push({
            methodName: "storage_deposit",
            args: {
              registration_only: true,
              account_id: accountId,
            },
            gas: "30000000000000",
            amount: toNonDivisibleNumber(24, STORAGE_TO_REGISTER_WITH_MFT),
          });
        } else {
          tokenOutActions.push({
            methodName: "register_account",
            args: {
              account_id: accountId,
            },
            gas: "10000000000000",
          });
        }
      } else {
        tokenOutActions.push({
          methodName: "storage_deposit",
          args: {
            registration_only: true,
            account_id: accountId,
          },
          gas: "30000000000000",
          amount: toNonDivisibleNumber(24, STORAGE_TO_REGISTER_WITH_MFT),
        });
      }
      transactions.push({
        receiverId: token.id,
        functionCalls: tokenOutActions,
      });
    }
  };

  //making sure all actions get included.
  await registerToken(tokenOut);
  const actionsList: any[] = [];
  routes.forEach((route) => {
    route.pools.forEach((pool) => {
      if (pool.amount_in !== undefined && +pool.amount_in == 0) {
        delete pool.amount_in;
      }
      pool.pool_id = Number(pool.pool_id);
      actionsList.push(pool);
    });
  });
  transactions.push({
    receiverId: tokenIn.id,
    functionCalls: [
      {
        methodName: "ft_transfer_call",
        args: {
          receiver_id: "v2.ref-finance.near",
          amount: toNonDivisibleNumber(tokenIn.decimals, amountIn),
          msg: JSON.stringify({
            force: 0,
            actions: actionsList,
            ...(tokenOut.symbol == "NEAR" ? { skip_unwrap_near: false } : {}),
          }),
        },
        gas: "180000000000000",
        amount: ONE_YOCTO_NEAR,
      },
    ],
  });

  return transactions;
};

export const wrapNear = async ({
  amountIn,
  accountId,
}: {
  amountIn: string;
  accountId: string;
}) => {
  const transaction: Transaction = {
    receiverId: WRAP_NEAR_CONTRACT_ID,
    functionCalls: [
      {
        methodName: "near_deposit",
        args: {},
        gas: "50000000000000",
        amount: toNonDivisibleNumber(24, amountIn),
      },
    ],
  };

  const tokenRegistered = await ftGetStorageBalance(
    WRAP_NEAR_CONTRACT_ID,
    accountId
  );

  if (tokenRegistered === null) {
    transaction.functionCalls.unshift({
      methodName: "storage_deposit",
      args: {
        registration_only: true,
        account_id: accountId,
      },
      gas: "30000000000000",
      amount: toNonDivisibleNumber(24, STORAGE_TO_REGISTER_WITH_MFT),
    });
  }

  return transaction;
};

export const unWrapNear = async ({ amountIn }: { amountIn: string }) => {
  const transaction: Transaction = {
    receiverId: WRAP_NEAR_CONTRACT_ID,
    functionCalls: [
      {
        methodName: "near_withdraw",
        args: {
          amount: toNonDivisibleNumber(24, amountIn),
        },
        amount: ONE_YOCTO_NEAR,
      },
    ],
  };
  return transaction;
};
