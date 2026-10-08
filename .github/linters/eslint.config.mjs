// ESLint config for super-linter, loaded via `eslint -c .github/linters/eslint.config.mjs`.
//
// Based on super-linter v8's bundled default template on purpose. Super-linter
// routes EVERY eslint-based linter (JSON, JSONC, JSON5, JS, JSX, TS, TSX, Vue)
// through this single file, and its plugins resolve from the image's
// /node_modules — importing them by the exact names the image ships is what
// makes a repo override work at all. A config importing the `typescript-eslint`
// meta-package (not bundled) fails with ERR_MODULE_NOT_FOUND and takes JSON/JS
// down with it, since they share this file.
//
// Two deliberate changes from super-linter's default:
//   1. The TypeScript block drops `plugin:n/recommended`. eslint-plugin-n's
//      n/no-missing-import cannot resolve deps because the lint job has no
//      node_modules, and n/no-process-exit is wrong for a CLI entrypoint. The
//      TypeScript compiler already covers import resolution in `npm run build`.
//   2. no-unused-vars honours the `_`-prefix convention (e.g. a mock argument
//      that must match an interface signature it doesn't use).
//   3. The UI is Preact, not React: JSX needs no React in scope, `class` is the
//      attribute name, and lists render static, never-reordered items, so the
//      React-specific rules for those are off.
import { defineConfig, globalIgnores } from "eslint/config";
import n from "eslint-plugin-n";
import prettier from "eslint-plugin-prettier";
import globals from "globals";
import eslintPluginJsonc from "eslint-plugin-jsonc";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import pluginVue from "eslint-plugin-vue";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default defineConfig([
  globalIgnores(["!**/.*", "**/node_modules/.*", "dist/**", "data/**"]),
  {
    extends: compat.extends("eslint:recommended"),

    plugins: {
      n,
      prettier,
    },

    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.jest,
        ...globals.node,
      },
    },
  },
  ...eslintPluginJsonc.configs["recommended-with-json"].map((config) => ({
    ...config,
    files: ["**/*.json"],
  })),
  ...eslintPluginJsonc.configs["recommended-with-jsonc"].map((config) => ({
    ...config,
    files: ["**/*.jsonc"],
  })),
  ...eslintPluginJsonc.configs["recommended-with-json5"].map((config) => ({
    ...config,
    files: ["**/*.json5"],
  })),
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx"],
    extends: compat.extends("plugin:react/recommended"),

    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",

      parserOptions: {
        ecmaFeatures: {
          jsx: true,
          modules: true,
        },
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.cts", "**/*.mts", "**/*.tsx"],

    extends: compat.extends("plugin:@typescript-eslint/recommended", "plugin:react/recommended", "prettier"),

    plugins: {
      "@typescript-eslint": typescriptEslint,
    },

    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },

    settings: { react: { version: "18.3" } },

    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "react/react-in-jsx-scope": "off",
      "react/no-unknown-property": "off",
      "react/jsx-key": "off",
    },
  },
  ...pluginVue.configs["flat/recommended"],
]);
