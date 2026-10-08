import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  server: {
    host: true,
    proxy: { "/api": "http://localhost:8787", "/img": "http://localhost:8787" },
  },
});
