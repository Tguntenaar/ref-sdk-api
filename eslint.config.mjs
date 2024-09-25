import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/*"], // Ignore 'dist' folder
  },
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      parser: tsParser,
      globals: globals.browser,
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off", // Disable no-explicit-any rule
    },
  },
  pluginJs.configs.recommended, // Include recommended ESLint JS config
  tseslint.configs.recommended, // Include recommended TypeScript ESLint config
];
