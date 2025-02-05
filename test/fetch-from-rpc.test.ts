import axios from "axios";
import { fetchFromRPC } from "../src/utils/fetch-from-rpc";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("fetchFromRPC", () => {
  // Use unique bodies for each test to avoid interference from caching.
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns result from first successful RPC call and caches the result", async () => {
    const body = { test: "cacheTest" };
    const successResponse = { result: "cachedData" };

    // First call: simulate success from the first RPC endpoint
    mockedAxios.post.mockResolvedValueOnce({ data: successResponse });

    const result = await fetchFromRPC(body);
    expect(result).toEqual(successResponse);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    // Second call with the same body should return the cached result
    const cachedResult = await fetchFromRPC(body);
    expect(cachedResult).toEqual(successResponse);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1); // Only the first call hit axios.post
  });

  test("tries next RPC endpoints if the first fails", async () => {
    const body = { test: "tryNextEndpoint" };

    // First endpoint fails.
    const error = new Error("First endpoint error");
    mockedAxios.post.mockRejectedValueOnce(error);

    // Second endpoint succeeds.
    const successResponse = { result: "secondEndpointSuccess" };
    mockedAxios.post.mockResolvedValueOnce({ data: successResponse });

    const result = await fetchFromRPC(body);
    expect(result).toEqual(successResponse);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  test("returns 0 if all RPC endpoints fail", async () => {
    const body = { test: "allFail" };

    // Simulate a failure for all endpoints. With three endpoints defined,
    // we expect three axios.post calls.
    mockedAxios.post.mockRejectedValue(new Error("Endpoint failure"));

    const result = await fetchFromRPC(body);
    expect(result).toBe(0);
    expect(mockedAxios.post).toHaveBeenCalledTimes(3);
  });

  test("handles responses with an error property and retries", async () => {
    const body = { test: "errorResponse" };

    // First endpoint returns a response containing an error.
    const responseWithError = {
      error: {
        cause: { name: "RPCError", info: { block_height: 12345 } },
        data: "some error"
      },
    };
    mockedAxios.post.mockResolvedValueOnce({ data: responseWithError });

    // Second endpoint returns a valid response.
    const successResponse = { result: "afterError" };
    mockedAxios.post.mockResolvedValueOnce({ data: successResponse });

    const result = await fetchFromRPC(body);
    expect(result).toEqual(successResponse);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  test("respects the disableCache flag by not using the cached response", async () => {
    const body = { test: "disableCache" };
    const successResponse = { result: "freshData" };

    // Simulate axios.post always returning a successful response.
    mockedAxios.post.mockResolvedValue({ data: successResponse });

    // Call with disableCache set to true — this should bypass the cache.
    const result1 = await fetchFromRPC(body, true);
    expect(result1).toEqual(successResponse);

    // Even with the same body, a new axios.post should be made.
    const result2 = await fetchFromRPC(body, true);
    expect(result2).toEqual(successResponse);

    // Total axios calls should be 2 since caching was bypassed.
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });
});
