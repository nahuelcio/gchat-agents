import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const adminPort = Number(process.env.ADMIN_PORT) || 8081;
const bridgePort = Number(process.env.PORT) || 8080;
const webPort = Number(process.env.DEV_WEB_PORT) || 5173;

// `npm run dev` / `dev:web`: React HMR here; /api → control plane, /play/api → public bridge.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${adminPort}`, ws: true, headers: { host: "127.0.0.1" } },
      "/play/api": { target: `http://127.0.0.1:${bridgePort}`, headers: { host: "127.0.0.1" } },
    },
  },
});
