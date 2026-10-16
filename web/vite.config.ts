import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev:web` proxies the API to a running bridge's control plane.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": { target: "http://127.0.0.1:8081", headers: { host: "127.0.0.1" } } } },
});
