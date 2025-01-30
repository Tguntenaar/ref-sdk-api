import axios from "axios";
import NodeCache from "node-cache";

const RPC_ENDPOINTS = [
  "https://archival-rpc.mainnet.near.org",
  "https://free.rpc.fastnear.com",
  "https://rpc.web4.near.page",
  "https://near.lava.build",
  // Add more RPC endpoints here as needed
];

// Initialize cache with default TTL of 1 week
const rpcCache = new NodeCache({ stdTTL: 3600*24*7, checkperiod: 3600*24 });

export async function fetchFromRPC(body: any, disableCache: boolean = false): Promise<any> {
  // Use stringified body as cache key
  const cacheKey = JSON.stringify(body);
  
  // Check cache first
  const cachedResult = rpcCache.get(cacheKey);
  if (cachedResult && !disableCache) {
    return cachedResult;
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
      rpcCache.set(cacheKey, data);

      return data;
    } catch (error) {
      console.error(`RPC request failed for ${endpoint}:`, error);
      lastError = error as Error;
    }
  }

  return 0;
}