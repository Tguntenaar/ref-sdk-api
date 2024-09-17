import path from "path";
import fs from "fs/promises";

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
  const filePath = path.join(__dirname, "../tokens.json");
  const data = await fs.readFile(filePath, "utf-8");
  const tokensMetadata = JSON.parse(data) as Record<string, TokenMetadata>;

  if (id.toLowerCase() === "near") {
    id = "wrap.near"; // Special case for NEAR
  }
  // Return the token with the exact id
  return tokensMetadata[id];
};
