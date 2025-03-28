import axios, { AxiosResponse } from "axios";
import chalk from "chalk";

const PROD_URL = "https://ref-sdk-api-2.fly.dev";
const LOCAL_URL = "http://localhost:3000";

type QueryParams = {
  token?: string;
  account?: string;
  account_id?: string;
  token_id?: string;
  treasuryDaoID?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  slippage?: string;
  [key: string]: string | undefined;
};

interface EndpointResponse {
  data: unknown;
  status: number;
}

const endpoints = [
  // '/api/token-metadata',
  // '/api/whitelist-tokens', I made some changes to whitelist-tokens so they differ
  "/api/swap",
  "/api/near-price",
  "/api/ft-tokens",
  // '/api/all-token-balance-history',
  // '/api/transactions-transfer-history'
] as const;

type Endpoint = (typeof endpoints)[number];

async function compareEndpoints(
  endpoint: Endpoint,
  queryParams: QueryParams = {}
): Promise<void> {
  console.log(chalk.blue(`\nTesting ${endpoint}`));
  console.log(
    chalk.blue("Query params:", JSON.stringify(queryParams, null, 2))
  );

  try {
    const prodUrl = `${PROD_URL}${endpoint}`;
    const localUrl = `${LOCAL_URL}${endpoint}`;

    console.log(chalk.blue(`Making requests to:`));
    console.log(chalk.blue(`PROD: ${prodUrl}`));
    console.log(chalk.blue(`LOCAL: ${localUrl}`));

    let prodRes: AxiosResponse | null = null;
    let localRes: AxiosResponse | null = null;

    try {
      prodRes = await axios.get(prodUrl, { params: queryParams });
      console.log(chalk.green("✓ Production request successful"));
    } catch (error) {
      console.log(chalk.red("✗ Production request failed:"));
      if (axios.isAxiosError(error)) {
        console.log(chalk.red(`Status: ${error.response?.status}`));
        console.log(chalk.red(`Error: ${error.message}`));
        console.log(
          chalk.red(
            `Response data:`,
            JSON.stringify(error.response?.data, null, 2)
          )
        );
      }
    }

    try {
      localRes = await axios.get(localUrl, { params: queryParams });
      console.log(chalk.green("✓ Local request successful"));
    } catch (error) {
      console.log(chalk.red("✗ Local request failed:"));
      if (axios.isAxiosError(error)) {
        console.log(chalk.red(`Status: ${error.response?.status}`));
        console.log(chalk.red(`Error: ${error.message}`));
        console.log(
          chalk.red(
            `Response data:`,
            JSON.stringify(error.response?.data, null, 2)
          )
        );
      }
    }

    if (!prodRes || !localRes) {
      return;
    }

    const prodData = JSON.stringify(prodRes.data, null, 2);
    const localData = JSON.stringify(localRes.data, null, 2);

    if (prodData === localData) {
      console.log(chalk.green("✓ Responses match"));
    } else {
      const prodLines = prodData.split("\n");
      const localLines = localData.split("\n");
      const diffCount = prodLines.reduce(
        (count, line, index) => count + (line !== localLines[index] ? 1 : 0),
        0
      );

      console.log(chalk.red(`✗ Responses differ (${diffCount} lines):`));
      console.log("\nDifferences:");

      prodLines.forEach((line, index) => {
        if (line !== localLines[index]) {
          console.log(chalk.red(`Line ${index + 1}:`));
          console.log(chalk.yellow(`Prod: ${line}`));
          console.log(
            chalk.yellow(`Local: ${localLines[index] || "(missing)"}`)
          );
          console.log();
        }
      });
    }
  } catch (error) {
    console.log(chalk.red(`Error in comparison:`));
    console.log(
      chalk.red(error instanceof Error ? error.stack : String(error))
    );
  }
}

async function runTests(queryParams: QueryParams): Promise<void> {
  console.log(chalk.cyan("Starting endpoint comparison tests..."));
  console.log(chalk.cyan("Using query parameters:"));
  console.log(queryParams);

  for (const endpoint of endpoints) {
    await compareEndpoints(endpoint, queryParams);
  }
}

// Usage example:
// Replace this object with your desired query parameters
const queryParams: QueryParams = {
  token: "near",
  account: "testing-treasury.sputnik-dao.near",
  account_id: "testing-treasury.sputnik-dao.near",
  token_id: "near",
  treasuryDaoID: "testing-treasury.sputnik-dao.near",
  tokenIn: "near",
  tokenOut: "wrap.near",
  amountIn: "1000000000000000000000000", // 1 NEAR (24 decimals)
  slippage: "0.01",
};

runTests(queryParams);
