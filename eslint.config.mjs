import tseslint from "typescript-eslint";

export default tseslint.config({
  ignores: ["dist/**", "node_modules/**", "coverage/**"],
}, {
  files: ["**/*.ts", "**/*.tsx"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      project: "./tsconfig.eslint.json",
      tsconfigRootDir: import.meta.dirname,
    },
  },
  plugins: {
    "@typescript-eslint": tseslint.plugin,
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "warn",
    "@typescript-eslint/switch-exhaustiveness-check": "warn",
    "@typescript-eslint/consistent-type-assertions": ["warn", { assertionStyle: "as", objectLiteralTypeAssertions: "never" }],
  },
}, {
  files: ["packages/protocol/src/**/*.ts", "packages/kernel/src/proof.ts", "packages/kernel/src/tool-safety.ts", "packages/kernel/src/run-ledger.ts"],
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unsafe-argument": "error",
    "@typescript-eslint/no-unsafe-assignment": "error",
    "@typescript-eslint/no-unsafe-member-access": "error",
    "@typescript-eslint/no-unsafe-return": "error",
  },
}, {
  files: ["tests/**/*.ts"],
  rules: {
    "@typescript-eslint/no-floating-promises": "off",
  },
});
