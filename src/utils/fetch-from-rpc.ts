import axios from "axios";
import NodeCache from "node-cache";
import crypto from "crypto";
import prisma from "../prisma";
const RPC_ENDPOINTS = [
  "https://archival-rpc.mainnet.near.org",
  "https://archival-rpc.mainnet.pagoda.co",
  "https://archival-rpc.mainnet.fastnear.com",
  // Add more RPC endpoints here as needed
];

export async function fetchFromRPC(body: any, disableCache: boolean = false): Promise<any> {
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
    const accountExistence = await prisma.accountBlockExistence.findFirst({
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

    if (accountExistence) {
      throw new Error(`Account ${accountId} did not exist at or before block ${blockHeight}`);
    }
  }

  const existingRequest = await prisma.rpcRequest.findFirst({
    where: {
      requestHash,
    },
    orderBy: {
      timestamp: 'desc'
    }
  });

  if (existingRequest && !disableCache) {
    return existingRequest.responseBody;
  }

  let lastError: Error | null = null;

  // Try each RPC endpoint in sequence
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const response = await axios.post(endpoint, body, {
        headers: { "Content-Type": "application/json" },
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
        } else {
          console.error(`RPC request failed for ${endpoint}:`, error);
        }
      }
      lastError = error as Error;
    }
  }

  return 0;
}