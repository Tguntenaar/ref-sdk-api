import axios from "axios";
import crypto from "crypto";
import prisma from "../prisma";
import NodeCache from "node-cache";


const RPC_ENDPOINTS = [
  "https://rpc.mainnet.fastnear.com/",
  "https://rpc.mainnet.near.org",
  "https://free.rpc.fastnear.com",
  "https://near.lava.build",
];

const ARCHIVAL_RPC_ENDPOINTS = [
  "https://archival-rpc.mainnet.near.org",
  "https://archival-rpc.mainnet.pagoda.co",
  "https://archival-rpc.mainnet.fastnear.com",
  "https://rpc.mainnet.near.org",
];

const CACHE_EXPIRATION = 1000 * 10; // 10 seconds
const cache = new NodeCache({
  stdTTL: CACHE_EXPIRATION,
  checkperiod: CACHE_EXPIRATION / 2,
});

export async function fetchFromRPC(body: any, disableCache: boolean = false, archival: boolean = false): Promise<any> {
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')
  
  // Extract account ID and block height from the request body if present
  let accountId: string | undefined;
  let blockHeight: number | undefined;
  
  if (body.params?.request_type === "view_account" || body.params?.request_type === "view_state") {
    accountId = body.params.account_id;
    blockHeight = body.params.block_id ? parseInt(body.params.block_id) : undefined;
  }

  // Check if we already know this account didn't exist at this block height
  if (accountId && blockHeight) {
    const accountExistenceIsFalse = await prisma.accountBlockExistence.findFirst({
      where: {
        accountId,
        blockHeight: {
          lte: blockHeight
        },
        exists: false
      },
      orderBy: {
        blockHeight: 'desc'
      }
    });

    // console.log(`accountExistenceIsFalse: ${accountExistenceIsFalse}`);

    if (accountExistenceIsFalse) {
      // TODO don't make the RPC call here. Return 0
      throw new Error(`Account ${accountId} did not exist at or before block ${blockHeight}`);
    }
  }

  if (!disableCache) {
    const existingRequest = await prisma.rpcRequest.findFirst({
      where: {
        requestHash,
    },
    orderBy: {
      timestamp: 'desc'
    }
  });

    if (existingRequest) {
      console.log(`Found cached RPC request for ${requestHash}`);
      return existingRequest.responseBody;
    }
  }
  
  let usable_endpoints = RPC_ENDPOINTS;
  if (archival) {
    usable_endpoints = ARCHIVAL_RPC_ENDPOINTS;
  }

  // Try each RPC endpoint in sequence
  for (const endpoint of usable_endpoints) {
    // FIXME: Use node-cache to skip an endpoint for 10 sec if we just received a 429
    const cacheKey = `rpc_endpoint_${endpoint}_429`;
    const cached429 = cache.get(cacheKey);
    if (cached429) {
      console.log(`Skipping endpoint ${endpoint} for 10 seconds because we received a 429`);
      continue;
    }

    try {

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      }

      if (endpoint.includes("rpc.mainnet.fastnear.com")) {
        if (!process.env.FASTNEAR_API_KEY) {
          throw new Error("FASTNEAR_API_KEY is not set");
        }
        headers["Authorization"] = `Bearer ${process.env.FASTNEAR_API_KEY}`;
      }

      const response = await axios.post(endpoint, body, {
        headers,
      });

      // Axios automatically throws on non-2xx responses and parses JSON
      const data = response.data;

      // Check for RPC errors
      if (data.error) {
        throw new Error(`RPC ${data.error.cause.name}: ${data.error.data} ${data.error.cause.info.block_height}`);
      }

      // Validate the response has required data
      if (!data.result) {
        throw new Error("Invalid response: missing result");
      }

      // Store successful response in cache
      await prisma.rpcRequest.create({
        data: {
          requestHash,
          endpoint: endpoint,
          requestBody: body,
          responseBody: data,
        },
      });

      return data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorMessage = error.response?.data?.error?.cause?.name;
        
        // Store information about non-existent accounts
        if (errorMessage === 'UNKNOWN_ACCOUNT' && accountId && blockHeight) {
          await prisma.accountBlockExistence.create({
            data: {
              accountId,
              blockHeight,
              exists: false
            }
          });
        }

        if (error.response?.status === 429) {
          console.error(`Received 429 Too Many Requests error from ${endpoint}:`, error.message);
          cache.set(cacheKey, true, CACHE_EXPIRATION);
        } else {
          console.error(`RPC request failed for ${endpoint}:`, error);
        }
      }
    }
  }

  return 0;
}