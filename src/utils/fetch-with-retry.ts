import axios from "axios";

export async function fetchWithRetry(body: any, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.post("https://archival-rpc.mainnet.near.org", body, {
        headers: { "Content-Type": "application/json" },
      });

      // Axios automatically throws on non-2xx responses and parses JSON
      const data = response.data;

      // Check for RPC errors
      if (data.error) {
        throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
      }

      // Validate the response has required data
      if (!data.result) {
        throw new Error("Invalid response: missing result");
      }

      return data;
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      // Exponential backoff: 1s, 2s, 4s
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, i))
      );
    }
  }
}