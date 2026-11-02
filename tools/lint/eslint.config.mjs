// Bug-finding rules only. Style is left out on purpose: reformatting would
// touch most files and clash with open PRs.
// How to run it: tools/lint/README.md.
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const bugRules = {
  ...js.configs.recommended.rules,
  // Cleanup rather than bugs, and noisy on this code.
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-useless-escape": "off",
  // These regexes strip control characters on purpose.
  "no-control-regex": "off",
  "preserve-caught-error": "off",
  "array-callback-return": "error",
  "no-constructor-return": "error",
  "no-self-compare": "error",
  "no-unreachable-loop": "error",
};

export default [
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  {
    ignores: [
      "**/node_modules/**", "**/dist/**", "**/*.min.js", "**/.pack-smoke/**",
      // Generated wallet bundle: rebuilt by http-mcp/wallet-build, never edited by hand.
      "http-mcp/public/portal/embedded-wallet/runtime-chunks/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: bugRules,
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
  },
  {
    files: ["http-mcp/public/**/*.{js,mjs}", "http-mcp/bin/offline-fixtures/tester-ui/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    // These also send code to a test browser, so both sets of names are real.
    files: ["http-mcp/test/**/*.mjs", "http-mcp/scripts/check-offline-tester-package.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      ...bugRules,
      // The TypeScript compiler already reports these, with fewer false alarms.
      "no-undef": "off",
      "no-redeclare": "off",
      "no-dupe-class-members": "off",
      "no-unused-vars": "off",
    },
  },
  {
    // Checks that need type information: a missed `await` on money or wallet
    // calls is the mistake we most want caught.
    files: ["stdio-mcp/src/**/*.ts"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parserOptions: {
        project: "stdio-mcp/tsconfig.json",
        tsconfigRootDir: repoRoot,
      },
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
];
