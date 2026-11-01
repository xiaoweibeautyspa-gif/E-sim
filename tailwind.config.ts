import type { Config } from "tailwindcss";

/**
 * Tailwind configuration.
 *
 * The `brand` palette is extended here so components can use `bg-brand-600`
 * etc. Content globs cover both HTML entry and all TS/TSX source so unused
 * classes are tree-shaken.
 */
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef7ff",
          100: "#d9ecff",
          200: "#bcdfff",
          300: "#8ecbff",
          400: "#59adff",
          500: "#338cff",
          600: "#1b6ef5",
          700: "#1557e1",
          800: "#1846b5",
          900: "#1a3e8f",
        },
      },
    },
  },
  plugins: [],
};

export default config;
