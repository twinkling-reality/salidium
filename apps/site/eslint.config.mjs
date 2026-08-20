import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import next from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  globalIgnores([
    ".next/**",
    "dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  reactHooks.configs.flat["recommended-latest"],
  jsxA11y.flatConfigs.recommended,
  next.configs["core-web-vitals"],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      /*
       * A scroll container is a place a keyboard has to be able to go. On a narrow window a
       * documentation capture holds 870px of picture in a 350px column, and with no tab stop in it
       * the right-hand two thirds of every capture on the site were unreachable without a pointer.
       * `tabindex="0"` with a role and a label is the pattern for that; the rule allows it only
       * for `tabpanel` out of the box, so `group` is named here rather than the check disabled.
       */
      "jsx-a11y/no-noninteractive-tabindex": [
        "error",
        { tags: [], roles: ["group", "tabpanel"], allowExpressionValues: true },
      ],
    },
  },
]);

export default eslintConfig;
