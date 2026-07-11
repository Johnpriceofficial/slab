import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      // Generated edge bundles (auto-built from src/server/**).
      "supabase/functions/_shared/*-bundle.js",
      // Deno edge entrypoints use remote imports tsc/eslint can't resolve here.
      "supabase/functions/**/index.ts",
      "supabase/functions/_shared/*.ts",
      "*.config.{js,ts}",
      "scripts/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // The data layer intentionally uses `any` for the pre-typegen Supabase
      // client and defensive parsing; keep it a warning, not a hard error.
      "@typescript-eslint/no-explicit-any": "off",
      // shadcn/ui components declare empty interfaces that extend HTML props.
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
