import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**"]
  },
  {
    files: ["tests/**/*.ts", "tests/**/*.js"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-undef": "off",
      "no-case-declarations": "off",
      "prefer-const": "off",
      "no-useless-assignment": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "no-empty": "off"
    }
  }
);
