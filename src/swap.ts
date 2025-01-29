import { searchToken } from "./utils/search-token";
import Big from "big.js";
import { SmartRouter } from "./utils/interface";
import { swapFromServer, unWrapNear, wrapNear } from "./utils/lib";
import axios from "axios";

export type SwapParams = {
  accountId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage: string;
};

export async function getSwap({ accountId, tokenIn, tokenOut, amountIn, slippage }: SwapParams) {
  const isWrapNearInputToken = tokenIn === "wrap.near";
  const isWrapNearOutputToken = tokenOut === "wrap.near";
  const tokenInData = await searchToken(tokenIn);
  const tokenOutData = await searchToken(tokenOut);

  if (!tokenInData || !tokenOutData) {
    throw new Error(`Unable to find token(s) tokenInData: ${tokenInData?.name} tokenOutData: ${tokenOutData?.name}`);
  }

  // (un)wrap NEAR
  if (tokenInData.id === tokenOutData.id) {
    if (isWrapNearInputToken && !isWrapNearOutputToken) {
      return {
        transactions: [await unWrapNear({ amountIn })],
        outEstimate: amountIn,
      };
    }

    if (!isWrapNearInputToken && isWrapNearOutputToken) {
      return {
        transactions: [await wrapNear({ amountIn, accountId })],
        outEstimate: amountIn,
      };
    }
  }

  const sendAmount = Big(amountIn)
    .mul(Big(10).pow(tokenInData.decimals))
    .toFixed();
  const swapRes: SmartRouter = (
    await axios.get(
      `https://smartrouter.ref.finance/findPath?amountIn=${sendAmount}&tokenIn=${tokenInData.id}&tokenOut=${tokenOutData.id}&pathDeep=3&slippage=${slippage}`
    )
  ).data;

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

  return {
    transactions: swapTxns,
    outEstimate: Big(receiveAmount).toFixed(5),
  };
}
