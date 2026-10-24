#!/usr/bin/env node
/**
 *   tilua <entry> [--out <file>] [--output single|chunks|modules] [--config <tilua.config.json>]
 *                 [--noCheck] [--target luau|lua51]
 *
 * Bundles `entry` and every module it imports into one Luau file — by default
 * the entry's path with `.luau` — and reports problems as
 * `file:line:column message`. Exits with 1 when there were errors; type errors
 * still produce the bundle.
 *
 * `--output chunks` also writes a file beside it for what only an `import()`
 * reaches. `--output modules` writes one file per module, in the project's
 * own tree: `--out` is then the folder that tree goes in — by default the
 * project's, so each `.luau` lands beside its `.tilua`.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { bundle } from "./bundle.js"
import { resolveConfig } from "./config.js"
import type { BuildTarget, OutputMode } from "@tilua/parser"

const usage = "usage: tilua <entry> [--out <file>] [--output single|chunks|modules] [--config <tilua.config.json>] [--noCheck] [--target luau|lua51]"
const args = process.argv.slice(2)
let entry: string | undefined
let out: string | undefined
let config: string | undefined
let typeCheck = true
let buildTarget: BuildTarget | undefined
let output: OutputMode | undefined
for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--out") out = args[++i]
    else if (arg === "--config") config = args[++i]
    else if (arg === "--noCheck") typeCheck = false
    else if (arg === "--target") {
        const value = args[++i]
        if (value !== "luau" && value !== "lua51") {
            console.error(`--target must be 'luau' or 'lua51', not '${value}'`)
            process.exit(2)
        }
        buildTarget = value
    }
    else if (arg === "--output") {
        const value = args[++i]
        if (value !== "single" && value !== "chunks" && value !== "modules") {
            console.error(`--output must be 'single', 'chunks' or 'modules', not '${value}'`)
            process.exit(2)
        }
        output = value
    }
    else if (arg === "--help" || arg === "-h") {
        console.log(usage)
        process.exit(0)
    } else entry = arg
}
if (!entry) {
    console.error(usage)
    process.exit(2)
}

// In a function, not at the top level: bundling is async, and a top-level
// `await` cannot be compiled to CommonJS, which this ships as too.
async function main(from: string): Promise<never> {
    // Where the files go has to be known here, and for one file per module
    // that is the project's folder — which only the config says.
    const found = resolveConfig(config, resolve(from)).config
    const mode = output ?? found?.output ?? "single"
    const entryFile = mode === "modules" ? undefined : out ?? from.replace(/\.tilua$/, "") + ".luau"
    const folder = entryFile !== undefined ? dirname(entryFile) : out ?? found?.directory ?? dirname(from)

    const result = await bundle({
        entry: from, config, typeCheck, target: buildTarget, output: mode,
        outFile: entryFile !== undefined ? basename(entryFile) : undefined,
    })
    for (const d of result.diagnostics) {
        console.error(`${relative(process.cwd(), d.file)}:${d.line}:${d.column} ${d.message}`)
    }
    if (result.code === undefined) {
        console.error("no bundle written")
        process.exit(1)
    }
    for (const file of result.files) {
        const target = join(folder, file.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.code)
        console.log(`${target}: ${file.modules.length} module${file.modules.length === 1 ? "" : "s"}`)
    }
    process.exit(result.diagnostics.length ? 1 : 0)
}

main(entry).catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
