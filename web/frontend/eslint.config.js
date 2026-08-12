// ESLint 9 flat config. Keep it lean: recommended TS + react-hooks rules; the
// compiler and build already gate types, so lint's job here is real footguns,
// not style.
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "../pebbles_web/static/app", "node_modules"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Inline handlers use fire-and-forget promises deliberately (api.post().finally(...))
      "@typescript-eslint/no-floating-promises": "off",
      // `catch (e) {}` on optional fetches is an established pattern here
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  }
);
