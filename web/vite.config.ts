import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const adminPort = Number(process.env.ADMIN_PORT) || 8081;
const webPort = Number(process.env.DEV_WEB_PORT) || 5173;

// `npm run dev` / `dev:web`: React HMR here; /api goes to the loopback control plane.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${adminPort}`, headers: { host: "127.0.0.1" } } },
  },
});
