#!/usr/bin/env node
/**
 *   tilua [<entry>] [--out <file>] [--output single|chunks|files] [--config <tilua.config.json>]
 *                   [--noCheck] [--noLineMap] [--minify] [--watch]
 *   tilua init
 *
 * Bundles `entry` and every module it imports into one Lua file — by default
 * the entry's path with `.luau` — and reports problems as
 * `file:line:column message`. Exits with 1 when there were errors; type errors
 * still produce the bundle.
 *
 * `--output chunks` also writes a file beside it for what only an `import()`
 * reaches.
 *
 * `--output files` (or the config's `"output": "files"`) has no entry: every
 * file under the config's `rootDir` is compiled to a file of its own under
 * `outDir`, in the same place — `src/shop.tilua` to `dist/shop.luau` — each
 * of which returns its exports. `--out` is then the folder, in place of
 * `outDir`. Without an entry the config is the nearest one above the folder
 * the command runs in, unless `--config` names one. Every file it writes ends
 * with a line saying so: a `.luau` without that line was written by hand, and
 * is never replaced; one with it whose `.tilua` is gone is removed.
 *
 * `--watch` builds again whenever a `.tilua` file, the config or a Rojo
 * project changes, and keeps going — beside `rojo serve`, which syncs what it
 * writes into Studio.
 *
 * `tilua init` writes a `tilua.config.json` for the Rojo project in this
 * folder: Roblox's types, and a `.luau` beside each `.tilua` under the folder
 * its `$path`s share, where the project already reads them.
 *
 * `--noLineMap` leaves out the map that names an error's place in the
 * project's files, as the config's `"lineMap": false` does: a smaller bundle
 * for a release, whose errors name its own lines.
 *
 * `--minify` writes it on one line, as the config's `"minify": true` does:
 * smaller still, and without the line map, which one line cannot have.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { bundle, WRITTEN_BY_TILUA, type BundleResult } from "./bundle.js"
import { resolveConfig } from "./config.js"
import type { OutputMode } from "@tilua/parser"

const usage = "usage: tilua [<entry>] [--out <file>] [--output single|chunks|files] [--config <tilua.config.json>] "
    + "[--noCheck] [--noLineMap] [--minify] [--watch]\n       tilua init"
const args = process.argv.slice(2)
let entry: string | undefined
let out: string | undefined
let config: string | undefined
let typeCheck = true
let lineMap: boolean | undefined
let minify: boolean | undefined
let output: OutputMode | undefined
let watching = false
for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--out") out = args[++i]
    else if (arg === "--config") config = args[++i]
    else if (arg === "--noCheck") typeCheck = false
    else if (arg === "--noLineMap") lineMap = false
    else if (arg === "--minify") minify = true
    else if (arg === "--watch" || arg === "-w") watching = true
    else if (arg === "--target") {
        // The output is Lua that runs anywhere; a library says what more.
        console.error("--target is gone: the output runs on Lua 5.1 to 5.4, LuaJIT and Luau, "
            + "and a library says what more its Lua has — add \"luau\" to the config's 'types'")
        process.exit(2)
    }
    else if (arg === "--output") {
        const value = args[++i]
        if (value === "modules") {
            console.error("--output modules is gone: --output files writes one file per module, each of which returns its exports")
            process.exit(2)
        }
        if (value !== "single" && value !== "chunks" && value !== "files") {
            console.error(`--output must be 'single', 'chunks' or 'files', not '${value}'`)
            process.exit(2)
        }
        output = value
    }
    else if (arg === "--help" || arg === "-h") {
        console.log(usage)
        process.exit(0)
    } else entry = arg
}

const shown = (path: string): string => relative(process.cwd(), path) || "."

/** `tilua init`: a config for the Rojo project in this folder. */
function init(): never {
    const folder = process.cwd()
    for (const name of ["tilua.config.json", "tilua.config.jsonc"]) {
        if (existsSync(join(folder, name))) {
            console.error(`${name} is already here`)
            process.exit(1)
        }
    }
    // What the project reads files from: the folder its `$path`s share.
    let rootDir = "src"
    const project = join(folder, "default.project.json")
    if (existsSync(project)) {
        const paths: string[] = []
        const walk = (node: unknown): void => {
            if (!node || typeof node !== "object") return
            const path = (node as { $path?: unknown }).$path
            const named = typeof path === "string" ? path : (path as { optional?: unknown } | undefined)?.optional
            if (typeof named === "string" && !/\.\w+$/.test(named)) paths.push(named)
            for (const [key, child] of Object.entries(node)) if (!key.startsWith("$")) walk(child)
        }
        try {
            walk((JSON.parse(readFileSync(project, "utf8")) as { tree?: unknown }).tree)
        } catch (error) {
            console.error(`default.project.json: ${(error as Error).message}`)
            process.exit(1)
        }
        const split = paths.map(path => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "").split("/"))
        const shared: string[] = []
        for (let i = 0; split.length && split.every(parts => parts.length > i && parts[i] === split[0][i]); i++) shared.push(split[0][i])
        // A project that maps one folder reads that folder's files.
        if (split.length) rootDir = shared.join("/") || "."
    } else {
        console.error("No default.project.json here: rootDir is \"src\". Change it if the project reads its files from elsewhere.")
    }
    const written = { types: ["roblox"], output: "files", rootDir }
    writeFileSync(join(folder, "tilua.config.json"), JSON.stringify(written, null, 4) + "\n")
    console.log("tilua.config.json: a .luau beside each .tilua under " + rootDir)
    console.log("Next: npm i -D @tilua/compiler @tilua-types/roblox, then run `npx tilua --watch` beside `rojo serve`.")
    process.exit(0)
}

/** Every `.luau` under `folder` tilua wrote, by its last line. */
function writtenByTilua(folder: string): string[] {
    const found: string[] = []
    const walk = (at: string): void => {
        let items
        try {
            items = readdirSync(at, { withFileTypes: true })
        } catch {
            return
        }
        for (const item of items) {
            if (item.name.startsWith(".") || item.name === "node_modules") continue
            const path = join(at, item.name)
            if (item.isDirectory()) walk(path)
            else if (/\.luau?$/.test(item.name) && isTilua(path)) found.push(path)
        }
    }
    walk(folder)
    return found
}

/** Did tilua write the file at `path`? */
function isTilua(path: string): boolean {
    try {
        const text = readFileSync(path, "utf8").trimEnd()
        return text.slice(text.lastIndexOf("\n") + 1).startsWith(WRITTEN_BY_TILUA)
    } catch {
        return false
    }
}

/** One build: report what it says, and write what it made. False when it
 *  failed. */
async function build(from: string | undefined): Promise<boolean> {
    // Where the files go has to be known here, and for a file per module that
    // is the config's `outDir` — which only the config says.
    const found = resolveConfig(config, resolve(from ?? "tilua.config.json")).config
    const mode = output ?? found?.output ?? "single"
    if (mode !== "files" && from === undefined) {
        console.error(usage)
        process.exit(2)
    }
    const perFile = mode === "files"
    const entryFile = perFile || from === undefined ? undefined : out ?? from.replace(/\.tilua$/, "") + ".luau"
    const folder = resolve(entryFile !== undefined ? dirname(entryFile) : out ?? found?.outDir ?? process.cwd())

    const result: BundleResult = await bundle({
        entry: perFile ? undefined : from, config, typeCheck, output: mode, lineMap, minify,
        outDir: perFile ? out : undefined,
        outFile: entryFile !== undefined ? basename(entryFile) : undefined,
    })
    for (const d of result.diagnostics) {
        console.error(`${shown(d.file)}:${d.line}:${d.column} ${d.severity === "warning" ? "warning: " : ""}${d.message}`)
    }
    if (result.code === undefined) {
        console.error("no output written")
        return false
    }

    const targets = result.files.map(file => ({ ...file, target: join(folder, file.path) }))
    if (perFile) {
        // A `.luau` someone wrote is theirs: one a `.tilua` would replace stops
        // the build before anything is written.
        const theirs = targets.filter(file => existsSync(file.target) && !isTilua(file.target))
        for (const file of theirs) {
            console.error(`${shown(file.target)}: this file was not written by tilua, and a .tilua would replace it — rename or remove one of them`)
        }
        if (theirs.length) return false
    }
    for (const file of targets) {
        // Unchanged files are left alone, so a watcher syncing them (Rojo)
        // sees only what changed.
        if (existsSync(file.target) && readFileSync(file.target, "utf8") === file.code) continue
        mkdirSync(dirname(file.target), { recursive: true })
        writeFileSync(file.target, file.code)
        console.log(`${shown(file.target)}: ${file.modules.length} module${file.modules.length === 1 ? "" : "s"}`)
    }
    if (perFile) {
        // What tilua wrote before, whose `.tilua` is gone or renamed.
        const kept = new Set(targets.map(file => resolve(file.target)))
        for (const stale of writtenByTilua(folder)) {
            if (kept.has(resolve(stale))) continue
            rmSync(stale)
            console.log(`${shown(stale)}: removed, its .tilua is gone`)
        }
    }
    return !result.diagnostics.some(d => d.severity !== "warning")
}

/** Build, then build again whenever a `.tilua`, the config or a Rojo project
 *  changes under the project's folder. */
async function watchAndBuild(from: string | undefined): Promise<void> {
    const found = resolveConfig(config, resolve(from ?? "tilua.config.json")).config
    const folder = found?.directory ?? (from !== undefined ? dirname(resolve(from)) : process.cwd())
    let running = false
    let again = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async (): Promise<void> => {
        if (running) {
            again = true
            return
        }
        running = true
        const ok = await build(from).catch(error => {
            console.error(error instanceof Error ? error.message : error)
            return false
        })
        console.log(`[${new Date().toLocaleTimeString()}] ${ok ? "built" : "built with errors"}; watching ${shown(folder)}`)
        running = false
        if (again) {
            again = false
            await run()
        }
    }
    await run()
    watch(folder, { recursive: true }, (_event, name) => {
        if (!name) return
        const path = name.toString()
        if (path.split(sep).includes("node_modules")) return
        if (!/\.tilua$|tilua\.config\.jsonc?$|\.project\.json$/.test(path)) return
        clearTimeout(timer)
        timer = setTimeout(() => void run(), 100)
    })
}

// In a function, not at the top level: bundling is async, and a top-level
// `await` cannot be compiled to CommonJS, which this ships as too.
async function main(): Promise<void> {
    if (entry === "init") init()
    if (watching) return watchAndBuild(entry)
    process.exit((await build(entry)) ? 0 : 1)
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
