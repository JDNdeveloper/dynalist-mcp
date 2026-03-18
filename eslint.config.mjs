import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='z'][callee.property.name='any']",
          message: "z.any() is banned. Use a typed Zod schema instead.",
        },
        {
          selector:
            "CallExpression[callee.object.name='z'][callee.property.name='object']" +
            ":not(MemberExpression[property.name='strict'] > " +
            "CallExpression[callee.object.name='z'][callee.property.name='object'])",
          message: "z.object() must be immediately chained with .strict() to reject unknown keys.",
        },
      ],
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    ignores: ["dist/"],
  },
);
