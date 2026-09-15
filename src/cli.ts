#!/usr/bin/env node
/**
 *   tilua <entry> [--out <file>] [--config <tilua.config.json>] [--noCheck] [--target luau|lua51]
 *
 * Bundles `entry` and every module it imports into one Luau file — by default
 * the entry's path with `.luau` — and reports problems as
 * `file:line:column message`. Exits with 1 when there were errors; type errors
 * still produce the bundle.
 */
import { writeFileSync } from "node:fs"
import { relative } from "node:path"
import { bundle } from "./bundle.js"
import type { BuildTarget } from "@tilua/parser"

const usage = "usage: tilua <entry> [--out <file>] [--config <tilua.config.json>] [--noCheck] [--target luau|lua51]"
const args = process.argv.slice(2)
let entry: string | undefined
let out: string | undefined
let config: string | undefined
let typeCheck = true
let buildTarget: BuildTarget | undefined
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
    const result = await bundle({ entry: from, config, typeCheck, target: buildTarget })
    for (const d of result.diagnostics) {
        console.error(`${relative(process.cwd(), d.file)}:${d.line}:${d.column} ${d.message}`)
    }
    if (result.code === undefined) {
        console.error("no bundle written")
        process.exit(1)
    }
    const target = out ?? from.replace(/\.tilua$/, "") + ".luau"
    writeFileSync(target, result.code)
    console.log(`${target}: ${result.modules.length} module${result.modules.length === 1 ? "" : "s"}`)
    process.exit(result.diagnostics.length ? 1 : 0)
}

main(entry).catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
