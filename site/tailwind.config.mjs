import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}"],
  darkMode: "class",
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
      backgroundImage: {
        "grid-light":
          "linear-gradient(to right, rgba(15,23,42,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(15,23,42,0.04) 1px, transparent 1px)",
        "grid-dark":
          "linear-gradient(to right, rgba(148,163,184,0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.07) 1px, transparent 1px)",
      },
      animation: {
        "fade-in": "fadeIn 0.6s ease-out",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [typography],
};
