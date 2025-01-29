import { promises as fs } from "fs";
import path from "path";
import { Token } from "./utils/interface";

export async function getTokenMetadata(token: string): Promise<Token> {
  const filePath = path.join(__dirname, "tokens.json");
  const data = await fs.readFile(filePath, "utf-8");
  const tokens: Record<string, Token> = JSON.parse(data);
  return tokens[token];
}
