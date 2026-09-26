import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
<<<<<<< HEAD
    // Vendored skill cache — third-party sources, not project code.
    ".skill-cache/**",
=======
    // Generated ENSv2 ABIs (npm run gen:ens-abis).
    "app/ens/_lib/ens/abis/**",
>>>>>>> 5f547c8e44a41f2b0ab630974c19d9c2f267852e
  ]),
]);

export default eslintConfig;
