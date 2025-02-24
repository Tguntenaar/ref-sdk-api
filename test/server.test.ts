import request from "supertest";
import app from "../src/server";
import prisma from "../src/prisma";
import * as whitelistTokens from "../src/whitelist-tokens";
import * as swap from "../src/swap";
import * as nearPrice from "../src/near-price";
import * as ftTokens from "../src/ft-tokens";
import * as allTokenBalanceHistory from "../src/all-token-balance-history";
import * as transactionsTransferHistory from "../src/transactions-transfer-history";
import { tokens } from "../src/constants/tokens";

// Mock all external dependencies
jest.mock("../src/prisma", () => ({
  __esModule: true,
  default: {
    nearPrice: {
      findFirst: jest.fn(),
    },
    fTToken: {
      findFirst: jest.fn(),
    },
    tokenBalanceHistory: {
      findFirst: jest.fn(),
    },
  },
}));

jest.mock("../src/whitelist-tokens");
jest.mock("../src/swap");
jest.mock("../src/near-price");
jest.mock("../src/ft-tokens");
jest.mock("../src/all-token-balance-history");
jest.mock("../src/transactions-transfer-history");
jest.mock("../src/constants/tokens", () => ({
  tokens: {
    "wrap.near": {
      decimals: 24,
      icon: "icon-url",
      name: "Wrapped NEAR",
      reference: null,
      reference_hash: null,
      spec: "ft-1.0.0",
      symbol: "wNEAR",
    },
  },
}));

describe("API Endpoints", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/token-metadata", () => {
    it("should return token metadata for a valid token", async () => {
      const response = await request(app)
        .get("/api/token-metadata")
        .query({ token: "wrap.near" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(tokens["wrap.near"]);
    });

    it("should return 500 for invalid token", async () => {
      const response = await request(app)
        .get("/api/token-metadata")
        .query({ token: "non-existent-token.near" });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: "An error occurred while fetching token metadata",
      });
    });
  });

  describe("GET /api/whitelist-tokens", () => {
    it("should return whitelist tokens", async () => {
      const mockTokens = [{ token_id: "token1" }, { token_id: "token2" }];
      (whitelistTokens.getWhitelistTokens as jest.Mock).mockResolvedValue(
        mockTokens
      );

      const response = await request(app)
        .get("/api/whitelist-tokens")
        .query({ account: "test.near" });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toEqual(mockTokens);
    });
  });

  describe("GET /api/swap", () => {
    it("should handle swap request", async () => {
      // Mock the searchToken function
      jest
        .spyOn(require("../src/utils/search-token"), "searchToken")
        .mockImplementation(async (...args: unknown[]) => {
          const token = args[0] as string;
          if (token === "wrap.near") {
            return { id: "wrap.near", decimals: 24, name: "Wrapped NEAR" };
          }
          if (token === "usdc.near") {
            return { id: "usdc.near", decimals: 6, name: "USD Coin" };
          }
          return null;
        });

      const mockSwapResult = {
        transactions: [{ some: "transaction" }],
        outEstimate: "1000000",
      };
      (swap.getSwap as jest.Mock).mockResolvedValue(mockSwapResult);

      const response = await request(app).get("/api/swap").query({
        accountId: "test.near",
        tokenIn: "wrap.near",
        tokenOut: "usdc.near",
        amountIn: "1000000000000000000000000",
        slippage: "0.01",
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockSwapResult);
    });

    it("should return 400 when required parameters are missing", async () => {
      const response = await request(app).get("/api/swap").query({
        tokenIn: "wrap.near",
        tokenOut: "usdc.near",
        // missing accountId and amountIn
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error:
          "Missing required parameters. Required: accountId, tokenIn, tokenOut, amountIn",
      });
    });
  });

  describe("GET /api/near-price", () => {
    it("should return NEAR price", async () => {
      const mockPrice = 1.5;
      (nearPrice.getNearPrice as jest.Mock).mockResolvedValue(mockPrice);

      const response = await request(app).get("/api/near-price");

      expect(response.status).toBe(200);
      expect(response.body).toBe(mockPrice);
    });

    it("should fallback to database on error", async () => {
      const mockDbPrice = { price: 1.5, timestamp: new Date(), source: "test" };
      (nearPrice.getNearPrice as jest.Mock).mockRejectedValue(
        new Error("API Error")
      );
      (prisma.nearPrice.findFirst as jest.Mock).mockResolvedValue(mockDbPrice);

      const response = await request(app).get("/api/near-price");

      expect(response.status).toBe(200);
      expect(response.body).toBe(mockDbPrice.price);
    });
  });

  describe("GET /api/ft-tokens", () => {
    it("should return FT tokens for valid account", async () => {
      const mockTokens = { tokens: [] };
      (ftTokens.getFTTokens as jest.Mock).mockResolvedValue(mockTokens);

      const response = await request(app)
        .get("/api/ft-tokens")
        .query({ account_id: "test.near" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockTokens);
    });

    it("should return 400 when account_id is missing", async () => {
      const response = await request(app).get("/api/ft-tokens");

      expect(response.status).toBe(400);
    });
  });

  describe("GET /api/all-token-balance-history", () => {
    it("should return token balance history for valid parameters", async () => {
      const mockHistory = { balances: [] };
      (
        allTokenBalanceHistory.getAllTokenBalanceHistory as jest.Mock
      ).mockResolvedValue(mockHistory);

      const response = await request(app)
        .get("/api/all-token-balance-history")
        .query({
          account_id: "test.near",
          token_id: "wrap.near",
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockHistory);
    });

    it("should return 400 when parameters are missing", async () => {
      const response = await request(app).get("/api/all-token-balance-history");

      expect(response.status).toBe(400);
    });
  });

  describe("GET /api/transactions-transfer-history", () => {
    it("should return transfer history for valid treasury DAO", async () => {
      const mockHistory = { transfers: [] };
      (
        transactionsTransferHistory.getTransactionsTransferHistory as jest.Mock
      ).mockResolvedValue(mockHistory);

      const response = await request(app)
        .get("/api/transactions-transfer-history")
        .query({ treasuryDaoID: "test-dao.near" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: mockHistory });
    });

    it("should return 400 when treasuryDaoID is missing", async () => {
      const response = await request(app).get(
        "/api/transactions-transfer-history"
      );

      expect(response.status).toBe(400);
    });
  });
});
