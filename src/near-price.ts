import axios from "axios";

type NearPriceCache = {
  get: (key: string) => any;
  set: (key: string, value: any, ttl: number) => void;
};

export async function getNearPrice(cache: NearPriceCache) {
  const cacheKey = `near-price`;
  const cachedData = cache.get(cacheKey);

  if (cachedData) {
    console.log(`Cached response for key: ${cacheKey}`);
    return cachedData;
  }

  const apiEndpoints = [
    "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd",
    "https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT",
    "https://min-api.cryptocompare.com/data/price?fsym=NEAR&tsyms=USD",
  ];

  for (const endpoint of apiEndpoints) {
    try {
      const response = await axios.get(endpoint);
      let price: number | null = null;

      if (endpoint.includes("coingecko")) {
        price = response.data.near?.usd || null;
      } else if (endpoint.includes("binance")) {
        price = parseFloat(response.data.price) || null;
      } else if (endpoint.includes("cryptocompare")) {
        price = response.data.USD || null;
      }

      if (price) {
        console.log(`Fetched price from ${endpoint}: $${price}`);
        cache.set(cacheKey, price, 50); // for 50 seconds
        return { price, source: endpoint };
      }
    } catch (error: any) {
      console.error(`Error fetching price from ${endpoint}:`, error.message);
    }
  }

  throw new Error("Failed to fetch NEAR price from all sources.");
}
