import { defineConfig } from "tsup";

export default defineConfig({
    // `index` is the library; `cli` is the `@tilua/compiler` binary.
    entry: ["src/index.ts", "src/cli.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: false,
    target: "node18",
    platform: "node",
    shims: true,
});
