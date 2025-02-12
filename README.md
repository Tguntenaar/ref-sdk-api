# NEAR Token Swap API

A RESTful API service for token swaps and blockchain metadata on the NEAR network, built with Express.js and TypeScript. It leverages caching, rate limiting, and secure request handling to provide a robust service for interacting with NEAR blockchain data.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Environment Variables](#environment-variables)
- [Running the Server](#running-the-server)
- [API Endpoints](#api-endpoints)
  - [Get Token Metadata](#get-token-metadata)
  - [Whitelist Tokens](#whitelist-tokens)
  - [Token Swap](#token-swap)
  - [Get NEAR Price](#get-near-price)
  - [Fetch FT Tokens](#fetch-ft-tokens)
  - [Get All Token Balance History](#get-all-token-balance-history)
  - [Clear Token Balance History](#clear-token-balance-history)
  - [Transactions Transfer History](#transactions-transfer-history)
- [Caching & Rate Limiting](#caching--rate-limiting)
- [RPC Requests & Fallback Logic](#rpc-requests--fallback-logic)
- [License](#license)

---

## Features

- **Token Metadata Retrieval:** Get metadata for any token from a pre-defined list.
- **Whitelist Tokens:** Retrieve tokens with associated balances and prices for a given account.
- **Token Swap Functionality:** Execute swap operations with validation and default slippage.
- **NEAR Price Retrieval:** Fetch the NEAR token price via external APIs with a database fallback.
- **FT Tokens Endpoint:** Retrieve fungible token balances with caching.
- **Token Balance History:** Get historical balance data bundled by period.
- **Clear Balance History:** Delete all token balance history entries from the database.
- **Transactions Transfer History:** Retrieve transfer history information from transactions.
- **Rate Limiting & CORS:** Protect endpoints using rate limits and CORS.
- **Security:** Utilize Helmet for secure HTTP headers.
- **RPC Caching:** Use internal caching and fallback mechanisms for RPC requests.

---

## Requirements

- [Node.js](https://nodejs.org/en/) (v14+ recommended)
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)
- A running PostgreSQL database instance

---

## Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/your-username/near-token-swap-api.git
   cd near-token-swap-api
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Setup environment variables:**

   Copy the provided `.env.example` file to `.env` and configure the variables accordingly.

   ```bash
   cp .env.example .env
   ```

4. **Run migrations (if using Prisma):**

   ```bash
   npx prisma migrate dev
   ```

---

## Environment Variables

Ensure you have a `.env` file with the following variables configured:

```
HOSTNAME=127.0.0.1
PORT=3000
PIKESPEAK_KEY=
DATABASE_URL="postgresql://johndoe:randompassword@localhost:5432/mydb?schema=public"
FASTNEAR_API_KEY=
NEARBLOCKS_API_KEY=
```

---

## Running the Server

Start the server with:

```bash
npm start
```

By default, the server will run on `http://127.0.0.1:3000` (or as specified by the `HOSTNAME` and `PORT` variables).

---

## API Endpoints

### Get Token Metadata

- **Endpoint:** `GET /api/token-metadata`
- **Query Parameters:**
  - `token` (string, required): The token ID for which to retrieve metadata.
- **Response:** JSON object containing metadata for the token.
- **Example:**

  ```http
  GET /api/token-metadata?token=near
  ```

---

### Whitelist Tokens

- **Endpoint:** `GET /api/whitelist-tokens`
- **Optional Query Parameter:**
  - `account` (string): The NEAR account id to filter tokens.
- **Response:** JSON object containing whitelisted tokens along with balances and prices.
- **Example:**

  ```http
  GET /api/whitelist-tokens?account=example.near
  ```

---

### Token Swap

- **Endpoint:** `GET /api/swap`
- **Required Query Parameters:**
  - `accountId` (string): The account executing the swap.
  - `tokenIn` (string): The ID of the token to swap from.
  - `tokenOut` (string): The token to swap to.
  - `amountIn` (string): The amount of `tokenIn` being swapped.
- **Optional Query Parameter:**
  - `slippage` (string): The allowable slippage (default: "0.01" for 1%).
- **Response:** JSON object containing swap details or error information.
- **Example:**

  ```http
  GET /api/swap?accountId=example.near&tokenIn=near&tokenOut=usdt&amountIn=100&slippage=0.02
  ```

---

### Get NEAR Price

- **Endpoint:** `GET /api/near-price`
- **Description:** Retrieves the current NEAR token price. If external sources fail, it falls back to the latest price stored in the database.
- **Response:** NEAR price as a JSON value.
- **Example:**

  ```http
  GET /api/near-price
  ```

---

### Fetch FT Tokens

- **Endpoint:** `GET /api/ft-tokens`
- **Query Parameters:**
  - `account_id` (string, required): The account id to fetch fungible token information.
- **Response:** JSON object with FT token details.
- **Example:**

  ```http
  GET /api/ft-tokens?account_id=example.near
  ```

---

### Get All Token Balance History

- **Endpoint:** `GET /api/all-token-balance-history`
- **Query Parameters:**
  - `account_id` (string, required): The account id whose token balance history is to be fetched.
  - `token_id` (string, required): The token id for which balance history is required.
  - `disableCache` (optional): When provided, bypasses the cached result (note: sensitive to frequent requests).
- **Response:** JSON object mapping each period to its corresponding balance history.
- **Example:**

  ```http
  GET /api/all-token-balance-history?account_id=example.near&token_id=near
  GET /api/all-token-balance-history?account_id=example.near&token_id=near&disableCache=true
  ```

---

### Clear Token Balance History

- **Endpoint:** `DELETE /api/clear-token-balance-history`
- **Description:** Removes all `TokenBalanceHistory` records from the database.
- **Response:** JSON message confirming deletion.
- **Example:**

  ```http
  DELETE /api/clear-token-balance-history
  ```

---

### Transactions Transfer History

- **Endpoint:** `GET /api/transactions-transfer-history`
- **Query Parameters:**
  - `treasuryDaoID` (string, required): The treasury DAO ID to filter transfer transactions.
- **Response:** JSON object containing the transfer history data.
- **Example:**

  ```http
  GET /api/transactions-transfer-history?treasuryDaoID=dao.near
  ```

---

## Caching & Rate Limiting

- **Caching:**  
  - The API uses [NodeCache](https://www.npmjs.com/package/node-cache) to store short-term responses (e.g., NEAR prices and token balance histories) to reduce external API calls and recomputation.
  - RPC calls (in `src/utils/fetch-from-rpc.ts`) also cache responses and skip endpoints temporarily on rate-limited (HTTP 429) responses.

- **Rate Limiting:**  
  - All `/api/*` endpoints are limited to 180 requests per 30 seconds per IP (or forwarded IP when available).  
  - This helps protect against abuse and ensures service stability.

---

## RPC Requests & Fallback Logic

- The API makes use of multiple RPC endpoints for querying the NEAR blockchain.
- In `src/utils/fetch-from-rpc.ts`, the request is:
  - Cached based on a hash of the request body.
  - Attempted sequentially across a list of primary or archival endpoints.
  - The response is stored using Prisma if successful.
  - In the event of a known error (e.g., non-existent account), the system caches the fact to avoid unnecessary calls.

---

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for more details.

---

*For additional questions or contributions, please open an issue or submit a PR on GitHub.*