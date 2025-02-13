import Big from "big.js";
import axios from "axios";
import { BalanceResp } from "./utils/interface";
import { tokens } from "./constants/tokens";

export async function getWhitelistTokens(account?: string | string[]) {
  // Fetch prices and balances concurrently

  if (!process.env.PIKESPEAK_KEY) {
    throw new Error("PIKESPEAK_KEY is not set");
  }

  const fetchBalancesPromise = account
    ? axios.get(`https://api.pikespeak.ai/account/balance/${account}`, {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.PIKESPEAK_KEY || "",
        },
      }).then((res) => res.data)
    : Promise.resolve([]);

  const fetchTokenPricePromises = Object.keys(tokens).map((id) => {
    return axios
      .get(
        `https://api.ref.finance/get-token-price?token_id=${
          id === "near" ? "wrap.near" : id
        }`
      )
      .then((res) => res.data)
      .catch((err) => {
        console.error(`Error fetching price for token_id ${id}: ${err.message}`);
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

  // Return sorted tokens based on balance
  return simplifiedTokens.sort(
    (a, b) => parseFloat(b.parsedBalance) - parseFloat(a.parsedBalance)
  );
}
