import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite is used both for the production build and, in dev, as middleware
// embedded in the Node server (see server/index.ts) — so the whole app lives
// on a single port. No dev server / proxy config is needed here.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web", emptyOutDir: true },
});
