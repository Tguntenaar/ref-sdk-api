import {
  deduplicateByTimestamp,
  fetchAdditionalPage,
  fetchPikespeakEndpoint,
  sortByDate,
} from "./utils/lib";

type TransferHistoryCache = {
  get: (key: string) => any;
  set: (key: string, value: any, ttl: number) => void;
  del: (key: string) => void;
};

export type TransferHistoryParams = {
  page?: string;
  lockupContract?: string;
  treasuryDaoID: string;
};

const totalTxnsPerPage = 20; // Return 20 items per page

export async function getTransactionsTransferHistory(
  params: TransferHistoryParams,
  cache: TransferHistoryCache
) {
  const { page = "1", lockupContract, treasuryDaoID } = params;

  if (!treasuryDaoID) {
    throw new Error("treasuryDaoID is required");
  }

  const requestedPage = parseInt(page, 10);
  const cacheKey = `${treasuryDaoID}-${lockupContract || "no-lockup"}`;

  // Retrieve cached raw data and timestamp (before sorting)
  let cachedData = cache.get(cacheKey) || [];
  let cachedTimestamp = cache.get(`${cacheKey}-timestamp`);

  const currentTime = Date.now();

  try {
    // If cache is empty or older than 10 minutes, fetch new data
    if (!cachedData || !cachedTimestamp) {
      const accounts: any[] = [treasuryDaoID];
      if (lockupContract) {
        accounts.push(lockupContract);
      }

      // Fetch transfers for all accounts (treasuryDaoID + lockupContract if provided)
      const latestPagePromises = accounts.flatMap((account) => [
        fetchPikespeakEndpoint(
          `https://api.pikespeak.ai/account/near-transfer/${account}?limit=${totalTxnsPerPage}&offset=0`
        ),
        fetchPikespeakEndpoint(
          `https://api.pikespeak.ai/account/ft-transfer/${account}?limit=${totalTxnsPerPage}&offset=0`
        ),
      ]);
      const latestPageResults = await Promise.all(latestPagePromises);

      if (latestPageResults.some((result: any) => !result.ok)) {
        throw new Error("Failed to fetch the latest page");
      }

      const latestPageData = latestPageResults.flatMap(
        (result: any) => result.body
      );

      // Check for updates: Compare the raw API data (not sorted)
      const latestPageDataLength = latestPageData.length;
      const cachedSlice = cachedData.slice(0, latestPageDataLength); // Get the same length slice from the cached data

      // Only update if the latest page data differs from the cached slice
      if (
        cachedData.length === 0 ||
        JSON.stringify(latestPageData) !== JSON.stringify(cachedSlice)
      ) {
        console.log("Updates detected, fetching new data...");

        const updatedData = [...latestPageData, ...cachedData];

        // Deduplicate cached data based on timestamp
        cachedData = deduplicateByTimestamp(updatedData);
        cache.set(cacheKey, cachedData, 0);
        cache.set(`${cacheKey}-timestamp`, currentTime, 120);
      }
    }

    // Check if additional pages need to be fetched
    const totalCachedPages = Math.ceil(
      cachedData.length / (totalTxnsPerPage * 2)
    );

    if (requestedPage > totalCachedPages) {
      const additionalData = await fetchAdditionalPage(
        totalTxnsPerPage,
        treasuryDaoID,
        lockupContract,
        totalCachedPages
      );

      // Add the newly fetched data and deduplicate it
      cachedData = [...cachedData, ...additionalData];
      cachedData = deduplicateByTimestamp(cachedData);

      // Save the updated data to the cache
      cache.set(cacheKey, cachedData, 0);
      cache.set(`${cacheKey}-timestamp`, currentTime, 120);
    }

    const endIndex = requestedPage * totalTxnsPerPage;
    return sortByDate(cachedData.slice(0, endIndex));
  } catch (error) {
    throw error;
  }
}
