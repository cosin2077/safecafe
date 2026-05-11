import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  tsconfig: "../tsconfig.json",
  external: ["commander", "viem", "viem/accounts", "viem/chains"],
  outDir: "dist",
  clean: true,
  splitting: false,
  outExtension: () => ({ js: ".js" }),
  banner: {
    js: "#!/usr/bin/env node",
  },
})
