import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The CJS helpers in app/lib/*.js are deliberately CommonJS — they
  // export via `module.exports` so both .ts route handlers and (legacy)
  // node tests can `require()` them. The TS route handlers wrap that
  // require in a typed assertion to keep the call sites strongly-typed.
  // Disabling `no-require-imports` for both surfaces is the honest fix.
  {
    files: ["app/lib/**/*.js", "app/api/**/route.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
