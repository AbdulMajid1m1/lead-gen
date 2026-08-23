import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4180,
    host: true,
    // The API keeps its own origin in production; proxying in dev means the
    // frontend can always call a relative /api path.
    proxy: {
      "/api": {
        target: "http://localhost:4100",
        changeOrigin: true,
        // SSE must not be buffered by the proxy or discovery progress arrives
        // all at once when the run finishes.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
            }
          });
        },
      },
    },
  },
});
