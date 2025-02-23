import axios from "axios";
import { fetchFromRPC } from "../src/utils/fetch-from-rpc";
import prisma from "../src/prisma";

jest.mock("axios");
jest.mock("../src/prisma", () => ({
  __esModule: true,
  default: {
    rpcRequest: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    accountBlockExistence: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  },
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedPrisma = prisma as jest.Mocked<typeof prisma>;

describe("fetchFromRPC", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset Prisma mocks
    (mockedPrisma.rpcRequest.findFirst as jest.Mock).mockResolvedValue(null);
    (mockedPrisma.rpcRequest.create as jest.Mock).mockImplementation(
      async ({ data }) => data
    );
    (
      mockedPrisma.accountBlockExistence.findFirst as jest.Mock
    ).mockResolvedValue(null);
    (mockedPrisma.accountBlockExistence.create as jest.Mock).mockImplementation(
      async ({ data }) => data
    );

    // Reset axios mock for each test
    mockedAxios.post.mockReset();
  });

  beforeAll(() => {
    process.env.FASTNEAR_API_KEY = "dummy-key";
  });

  test("returns result from first successful RPC call and caches the result", async () => {
    const body = { test: "cacheTest" };
    const successResponse = { result: "cachedData" };

    // First call: simulate success from the first RPC endpoint
    mockedAxios.post.mockResolvedValueOnce({ data: successResponse });
    (mockedPrisma.rpcRequest.findFirst as jest.Mock).mockResolvedValue(null);

    const result = await fetchFromRPC(body);
    expect(result).toEqual(successResponse);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    // Second call with the same body should return the cached result
    (mockedPrisma.rpcRequest.findFirst as jest.Mock).mockResolvedValue({
      responseBody: successResponse,
    });
    const cachedResult = await fetchFromRPC(body);
    expect(cachedResult).toEqual(successResponse);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1); // Only the first call hit axios.post
  });

  test("tries next RPC endpoints if the first fails", async () => {
    const body = { test: "tryNextEndpoint" };
    const successResponse = { result: "secondEndpointSuccess" };

    // Single endpoint fails with a non-UNKNOWN_ACCOUNT error
    mockedAxios.post.mockRejectedValueOnce(new Error("First endpoint failed"));

    const result = await fetchFromRPC(body);
    expect(result).toBe(0); // Should return 0 since there's only one endpoint
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  test("returns 0 if all RPC endpoints fail", async () => {
    const body = { test: "allFail" };

    // Single endpoint fails
    mockedAxios.post.mockRejectedValueOnce(new Error("First endpoint failed"));

    const result = await fetchFromRPC(body);
    expect(result).toBe(0);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  test("handles responses with an error property and retries", async () => {
    const body = { test: "errorResponse" };

    // Single endpoint returns error response
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        error: {
          cause: { name: "RPCError", info: { block_height: 12345 } },
          data: "some error",
        },
      },
    });

    const result = await fetchFromRPC(body);
    expect(result).toBe(0); // Should return 0 since there's only one endpoint
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  test("respects the disableCache flag by not using the cached response", async () => {
    const body = { test: "disableCache" };
    const successResponse = { result: "freshData" };

    // Even with cache available, it should make new requests
    (mockedPrisma.rpcRequest.findFirst as jest.Mock).mockResolvedValue({
      responseBody: { result: "cachedData" },
    });
    mockedAxios.post.mockResolvedValue({ data: successResponse });

    // Call with disableCache set to true — this should bypass the cache
    const result1 = await fetchFromRPC(body, true);
    expect(result1).toEqual(successResponse);

    // Even with the same body, a new axios.post should be made
    const result2 = await fetchFromRPC(body, true);
    expect(result2).toEqual(successResponse);

    // Total axios calls should be 2 since caching was bypassed
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });
});
