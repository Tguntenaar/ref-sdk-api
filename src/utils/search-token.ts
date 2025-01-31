import path from "path";
import fs from "fs/promises";
import {tokens} from "../constants/tokens";

export interface TokenMetadata {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  icon: string;
}

export const searchToken = async (
  id: string
): Promise<TokenMetadata | undefined> => {

  if (id.toLowerCase() === "near") {
    id = "wrap.near"; // Special case for NEAR
  }
  // Return the token with the exact id
  return tokens[id as keyof typeof tokens];
};
