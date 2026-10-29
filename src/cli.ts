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
 * the command runs in, unless `--config` names one.
 *
 * With an `outDir` of its own, the output is a mirror of `rootDir`: each
 * `.tilua` compiled, every other file — a `.luau` written by hand, a
 * `.meta.json`, a model — copied as it is, and anything else in `outDir`
 * removed. `outDir` is the build's alone. With `outDir` left as `rootDir`
 * each `.luau` lands beside its `.tilua`, and ends with a line saying tilua
 * wrote it: one without that line was written by hand and is never replaced,
 * and one with it whose `.tilua` is gone is removed.
 *
 * `--watch` builds again whenever a file under `rootDir`, the config or a
 * Rojo project changes, and keeps going — beside `rojo serve`, which syncs
 * what it writes into Studio.
 *
 * `tilua init` sets up the Rojo project in this folder: a `tilua.config.json`
 * with Roblox's types that compiles the folder its `$path`s share (`src`) to
 * `out`; the project's `$path`s pointed at `out`; and `/out` in `.gitignore`.
 *
 * `--noLineMap` leaves out the map that names an error's place in the
 * project's files, as the config's `"lineMap": false` does: a smaller bundle
 * for a release, whose errors name its own lines.
 *
 * `--minify` writes it on one line, as the config's `"minify": true` does:
 * smaller still, and without the line map, which one line cannot have.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, watch, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { bundle, WRITTEN_BY_TILUA, type BundleResult } from "./bundle.js"
import { resolveConfig } from "./config.js"
import { stripJsonComments, type OutputMode } from "@tilua/parser"

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

/** The folder the build writes to with `tilua init`. */
const OUT = "out"

/** `tilua init`: the Rojo project in this folder, set up to be built. A
 *  config that already compiles each `.tilua` beside itself is moved over to
 *  `out`, keeping the rest of what it says. */
function init(): never {
    const folder = process.cwd()
    let existing: { path: string; options: Record<string, unknown> } | undefined
    for (const name of ["tilua.config.json", "tilua.config.jsonc"]) {
        const path = join(folder, name)
        if (!existsSync(path)) continue
        let options: Record<string, unknown> = {}
        try {
            options = JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as Record<string, unknown>
        } catch (error) {
            console.error(`${name}: ${(error as Error).message}`)
            process.exit(1)
        }
        if (options.output !== "files" || (options.outDir !== undefined && options.outDir !== options.rootDir)) {
            console.error(`${name} is already here`)
            process.exit(1)
        }
        existing = { path, options }
    }
    const project = join(folder, "default.project.json")
    if (!existsSync(project)) {
        console.error("No default.project.json here: run `tilua init` in the folder of a Rojo project (`rojo init` makes one)")
        process.exit(1)
    }
    const text = readFileSync(project, "utf8")
    // What the project reads files from: the folder its `$path`s share.
    const paths: string[] = []
    const walk = (node: unknown): void => {
        if (!node || typeof node !== "object") return
        const path = (node as { $path?: unknown }).$path
        const named = typeof path === "string" ? path : (path as { optional?: unknown } | undefined)?.optional
        if (typeof named === "string") paths.push(named)
        for (const [key, child] of Object.entries(node)) if (!key.startsWith("$")) walk(child)
    }
    try {
        walk((JSON.parse(text) as { tree?: unknown }).tree)
    } catch (error) {
        console.error(`default.project.json: ${(error as Error).message}`)
        process.exit(1)
    }
    const split = paths.map(path => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "").split("/"))
    const shared: string[] = []
    for (let i = 0; split.length && split.every(parts => parts.length > i && parts[i] === split[0][i]); i++) shared.push(split[0][i])
    // A single `$path` that is a file is no folder to compile.
    if (split.length === 1 && /\.\w+$/.test(shared.at(-1) ?? "")) shared.pop()
    const rootDir = shared.join("/")
    if (!rootDir) {
        console.error("The project's $paths share no folder to compile from: put the code under one (src), as `rojo init` does")
        process.exit(1)
    }
    if (rootDir === OUT || rootDir.startsWith(`${OUT}/`)) {
        console.error(`The project already reads from ${OUT}: set tilua.config.json up by hand`)
        process.exit(1)
    }
    const out = join(folder, OUT)
    if (existsSync(out) && readdirSync(out).length) {
        console.error(`${OUT} is already here and not empty: the build would replace what is in it`)
        process.exit(1)
    }

    const options = existing
        ? { ...existing.options, rootDir: existing.options.rootDir ?? rootDir, outDir: OUT }
        : { types: ["roblox"], output: "files", rootDir, outDir: OUT }
    writeFileSync(existing?.path ?? join(folder, "tilua.config.json"), JSON.stringify(options, null, 4) + "\n")
    console.log(`${basename(existing?.path ?? "tilua.config.json")}: ${String(options.rootDir)} compiled to ${OUT}`)
    // Each `$path` under `rootDir` points at the same place under `out`. The
    // text is changed where the paths are written, and nowhere else.
    const escaped = rootDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    let changed = 0
    const pointed = text.replace(new RegExp(`("\\$path"\\s*:\\s*")(\\./)?${escaped}(?=/|")`, "g"), (_, head: string) => {
        changed++
        return `${head}${OUT}`
    })
    writeFileSync(project, pointed)
    console.log(`default.project.json: ${changed} $path${changed === 1 ? "" : "s"} now read from ${OUT}`)
    const ignore = join(folder, ".gitignore")
    const ignored = existsSync(ignore) ? readFileSync(ignore, "utf8") : ""
    if (!ignored.split(/\r?\n/).some(line => [OUT, `/${OUT}`, `${OUT}/`, `/${OUT}/`].includes(line.trim()))) {
        writeFileSync(ignore, `${ignored}${ignored && !ignored.endsWith("\n") ? "\n" : ""}\n# What tilua builds from ${rootDir}\n/${OUT}\n`)
        console.log(`.gitignore: /${OUT}`)
    }
    console.log("Next: npm i -D @tilua/compiler @tilua-types/roblox, then run `npx tilua --watch` beside `rojo serve`.")
    process.exit(0)
}

/** Is `path` `folder`, or under it? */
function isInside(folder: string, path: string): boolean {
    const below = relative(folder, path)
    return below === "" || (!below.startsWith("..") && !isAbsolute(below))
}

/** Every file under `folder`, but under `node_modules` or `.git`. */
function filesUnder(folder: string): string[] {
    return under(folder).files
}

/** Every file and every folder under `folder` — hidden ones too, since the
 *  output mirrors all of it — but under `node_modules` or `.git`. */
function under(folder: string): { files: string[]; folders: string[] } {
    const files: string[] = []
    const folders: string[] = []
    const walk = (at: string): void => {
        let items
        try {
            items = readdirSync(at, { withFileTypes: true })
        } catch {
            return
        }
        for (const item of items) {
            if (item.name === "node_modules" || item.name === ".git") continue
            const path = join(at, item.name)
            if (item.isDirectory()) {
                folders.push(path)
                walk(path)
            } else files.push(path)
        }
    }
    walk(folder)
    return { files, folders }
}

/** Remove the folders under `folder` that hold nothing, but the ones in
 *  `keep`. */
function removeEmpty(folder: string, keep: ReadonlySet<string>): void {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
        if (!item.isDirectory()) continue
        const path = join(folder, item.name)
        removeEmpty(path, keep)
        if (!readdirSync(path).length && !keep.has(resolve(path))) rmdirSync(path)
    }
}

/** Every `.luau` under `folder` tilua wrote, by its last line. */
function writtenByTilua(folder: string): string[] {
    return filesUnder(folder).filter(path => /\.luau?$/.test(path) && isTilua(path))
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
    // With a folder of its own the output mirrors `rootDir`, and the folder
    // is the build's: what it does not write there goes. So it may hold
    // nothing else — not the sources, and not the project.
    const rootDir = resolve(found?.rootDir ?? process.cwd())
    const mirror = perFile && resolve(folder) !== rootDir
    if (mirror && (isInside(folder, rootDir) || isInside(rootDir, folder) || isInside(folder, found?.directory ?? process.cwd()))) {
        console.error(`outDir (${shown(folder)}) has to be a folder of its own: not ${isInside(rootDir, folder) ? "under" : "around"} rootDir (${shown(rootDir)}), and not around the project`)
        return false
    }

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
    if (mirror) {
        // Every file under `rootDir` that is not tilua's own goes across as it
        // is, whatever it is — a `.luau` written by hand, a `.meta.json`, a
        // model, an asset. `.tilua` is compiled, and `.d.tilua` only checked.
        const compiled = new Map(targets.map(file => [resolve(file.target), file]))
        const copies: { source: string; target: string }[] = []
        let clash = false
        const leftovers: string[] = []
        for (const source of filesUnder(rootDir)) {
            if (source.endsWith(".tilua")) continue
            // What tilua compiled beside a `.tilua` before the output had a
            // folder of its own: the build's to remove, not to copy.
            if (/\.luau?$/.test(source) && isTilua(source)) {
                leftovers.push(source)
                continue
            }
            const target = resolve(folder, relative(rootDir, source))
            if (compiled.has(target)) {
                console.error(`${shown(source)}: a .tilua compiles to the same file — rename or remove one of them`)
                clash = true
                continue
            }
            copies.push({ source, target })
        }
        if (clash) return false
        for (const leftover of leftovers) {
            rmSync(leftover)
            console.log(`${shown(leftover)}: removed — tilua compiled it beside its .tilua, and the output is in ${shown(folder)} now`)
        }
        for (const file of targets) {
            if (existsSync(file.target) && readFileSync(file.target, "utf8") === file.code) continue
            mkdirSync(dirname(file.target), { recursive: true })
            writeFileSync(file.target, file.code)
            console.log(`${shown(file.target)}: ${file.modules.length} module${file.modules.length === 1 ? "" : "s"}`)
        }
        for (const { source, target } of copies) {
            const bytes = readFileSync(source)
            if (existsSync(target) && readFileSync(target).equals(bytes)) continue
            mkdirSync(dirname(target), { recursive: true })
            copyFileSync(source, target)
            console.log(`${shown(target)}: copied`)
        }
        // What the build did not write is not the build's any more.
        const kept = new Set([...compiled.keys(), ...copies.map(copy => copy.target)])
        for (const stale of filesUnder(folder)) {
            if (kept.has(resolve(stale))) continue
            rmSync(stale)
            console.log(`${shown(stale)}: removed`)
        }
        // Every folder `rootDir` has is there, empty or not: a Rojo project
        // names folders, and one that is missing stops it.
        const folders = new Set([folder, ...under(rootDir).folders.map(path => resolve(folder, relative(rootDir, path)))])
        for (const path of folders) mkdirSync(path, { recursive: true })
        removeEmpty(folder, folders)
        return !result.diagnostics.some(d => d.severity !== "warning")
    }
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

/** Build, then build again whenever what it reads changes under the
 *  project's folder: a `.tilua`, the config, a Rojo project — and, where the
 *  output mirrors `rootDir`, any file there. */
async function watchAndBuild(from: string | undefined): Promise<void> {
    const found = resolveConfig(config, resolve(from ?? "tilua.config.json")).config
    const folder = found?.directory ?? (from !== undefined ? dirname(resolve(from)) : process.cwd())
    const rootDir = found?.rootDir
    const outDir = resolve(out ?? found?.outDir ?? folder)
    const mirrored = (output ?? found?.output) === "files" && rootDir !== undefined && outDir !== resolve(rootDir)
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
        const path = resolve(folder, name.toString())
        if (relative(folder, path).split(/[\\/]/).includes("node_modules") || isInside(outDir, path) && mirrored) return
        const read = /\.tilua$|tilua\.config\.jsonc?$|\.project\.json$/.test(path) || (mirrored && isInside(rootDir!, path))
        if (!read) return
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
