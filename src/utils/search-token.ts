import Fuse, { IFuseOptions } from "fuse.js";
import { ftGetTokensMetadata } from "@ref-finance/ref-sdk";

type AllowlistedToken = {
  spec?: string;
  name: string;
  symbol: string;
  icon?: string;
  reference?: string | null;
  reference_hash?: string | null;
  tax_rate?: number;
  decimals: number;
  id: string;
};

const options: IFuseOptions<AllowlistedToken> = {
  includeScore: true,
  keys: [
    { name: "name", weight: 0.2 },
    { name: "symbol", weight: 0.3 },
    { name: "id", weight: 0.5 },
  ],
  isCaseSensitive: false,
  threshold: 0.3,
};

export const searchToken = async (
  query: string,
): Promise<AllowlistedToken[]> => {
  const tokensMetadata = await ftGetTokensMetadata();
  const tokensArray = Object.values(tokensMetadata);

  const fuse = new Fuse(tokensArray, options);

  if (query.toLowerCase() === "near") {
    query = "wrap.near"; // Special case for NEAR
  }
  // Search the tokens with the query
  const result = fuse.search(query);

  // Map the result to only return the tokens
  return result.map((res) => res.item);
};
