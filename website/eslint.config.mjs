import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // React 19 hook-compiler rules are aspirational — they flag patterns
    // (setState-in-effect, manual-memoization preservation) that work fine
    // but could be restructured for the new compiler. Demote to warnings so
    // they show in lint output without blocking the gate while we
    // progressively migrate components.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/purity": "warn",
    },
  },
  {
    // app/lib/*.js are CommonJS modules shared with the CLI engine. They
    // legitimately use require()/module.exports. Likewise some route.ts
    // files load these CJS modules via require() to bypass Turbopack tracing
    // of the dynamic CLI registry (see cli-engine-runner.js comment).
    files: ["app/lib/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@next/next/no-assign-module-variable": "off",
    },
  },
  {
    files: ["app/api/**/route.ts", "app/api/**/route.tsx"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@next/next/no-assign-module-variable": "off",
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
