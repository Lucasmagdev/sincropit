import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            lib: { entry: "electron/main.ts", formats: ["cjs"] },
          },
        },
      },
      preload: { input: "electron/preload.ts" },
    }),
  ],
});
