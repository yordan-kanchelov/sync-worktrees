import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        ink: {
          50: "#f7f8fa",
          100: "#eceef3",
          200: "#d6dae3",
          300: "#aab1c2",
          400: "#7a8295",
          500: "#525a70",
          600: "#383f54",
          700: "#262b3c",
          800: "#181c2a",
          900: "#0e1119",
          950: "#070910",
        },
        accent: {
          50: "#eef6ff",
          100: "#d9eaff",
          200: "#b8d8ff",
          300: "#85bcff",
          400: "#4d97ff",
          500: "#2974ff",
          600: "#1755ed",
          700: "#1244c2",
          800: "#143b99",
          900: "#163579",
        },
        signal: {
          green: "#22c55e",
          amber: "#f59e0b",
          red: "#ef4444",
        },
      },
    },
  },
  plugins: [typography],
};
