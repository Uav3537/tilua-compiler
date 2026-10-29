/**
 * A tilua project -> one Luau file.
 *
 * Roblox's `require` takes an Instance, so a bundle cannot use it between its
 * own modules. Instead every module becomes an entry in one table, loaded by a
 * `require` of the bundle's own:
 *
 *   local G
 *   G = {
 *       modules = {
 *           ["src/util"] = {
 *               names = { clamp = true },
 *               load = function(exports)
 *                   function exports.clamp(x) ... end
 *               end,
 *           },
 *           ["src/main"] = {
 *               load = function(exports)
 *                   local util
 *                   util = G.require("src/util")
 *                   print(util.clamp(2))
 *               end,
 *           },
 *       },
 *       records = {},
 *       require = function(name) ... end,
 *   }
 *   G.require("src/main")
 *
 * Modules behave as ES modules do:
 *
 *   - A module's record exists, marked `loading`, before its code runs. In a
 *     cycle — `a` imports `b`, which imports `a` back — `b` gets `a`'s exports
 *     table as it stands instead of loading `a` again, and `a`'s hoisted
 *     functions are already on it.
 *   - Reading an export the module has not initialized yet (`names`) is an
 *     error, like reading a `let` before its declaration.
 *   - Imports are read through the exporting module's table, so they are live;
 *     so are re-exports (`links`) and `export *` (`stars`), which the table
 *     looks up in the other module on every read.
 *   - `import("./x")` is `G.import("src/x")`, a wrapper around that same
 *     `require`: the module's exports table, asked for where the code runs.
 *
 * A project -> several Luau files (`output`).
 *
 * The table does not have to be filled by one file. The entry's file holds the
 * runtime and some of the modules; every other file is a function that adds
 * its modules to the table it is handed:
 *
 *   return function(G)
 *       G.modules["src/shop"] = { load = function(exports) ... end }
 *   end
 *
 * `G.files` says which file each of those modules is in, and `require` loads
 * that file — once — the first time one of its modules is asked for, from
 * beside the entry's file: with `loadfile`, which every Lua but Luau has, or
 * with `require` by path where a library says its Lua reads one
 * (`requireByPath`, as `@tilua-types/luau` does). `"chunks"` keeps everything
 * the entry imports in the entry's file and splits off what only an
 * `import()` reaches.
 *
 * A project -> a file per module, and no entry (`"output": "files"`).
 *
 * Every `.tilua` under `rootDir` becomes a file under `outDir`, in the same
 * place, and any of them is a file a script can `require`. The runtime is a
 * file of its own, `_tilua.luau`, which each of them requires first; each
 * then adds its module to the table and returns the module's exports:
 *
 *   local G = require("./_tilua")
 *   G.modules["src/main"] = { load = function(exports)
 *       local shape
 *       shape = G.require("src/shape", function() return require("./shape") end)
 *       ...
 *   end }
 *   return G.run("src/main")
 *
 * An import is still `G.require`, so the modules still behave as ES modules
 * do — a cycle gets the exports as they stand, which Luau's own `require`
 * would refuse — and the function after the name loads the module's file,
 * with its path written out, only if nothing has yet. `run` is `require`
 * under `xpcall` for the first file asked for, so an error is reported in the
 * project's files once, however deep the files that raised it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path"
import {
    parse, analyzeScopes, analyzeTypes, moduleExports, resolveModulePath, resolveTypeLibraries, importExpressions,
    directivesOf, applyDirectives, UNUSED_EXPECT_ERROR, UNUSED_EXPECT_WARNING, ParseError, LexError, luauString,
    type ModuleExports, type Program, type ScopeAnalysis, type TiluaConfig, type TypeAnalysis, type Directives,
    type OutputMode, type TypeLibraries,
} from "@tilua/parser"
import { parse as parseLuau, parseExpressionFromSource, print, type Program as LuauProgram, type Statement as LuauStatement, type TableExpression, type TableField } from "luau-parser"
import { resolveConfig, type ConfigInput } from "./config.js"
import { lower, syntaxOf, SharedRuntime, type ModuleInfo } from "./lower.js"
import { treeShake } from "./treeshake.js"
import { buildLineMap, lineMapSource, VLQ_DIGITS, type Origin } from "./linemap.js"
import { printOptions, printOutput } from "./output.js"
import { loadLowerings, type FilesAnswer, type LoadedLowering } from "./lowering.js"
import * as luau from "./luau.js"
import { Names } from "./names.js"

export interface BundleOptions {
    /** The file the bundle runs. Needed unless the output is `"files"`,
     *  which has no entry: every file under the config's `rootDir` is one. */
    readonly entry?: string
    /** A `tilua.config.json` path or contents. Default: the nearest config above the entry. */
    readonly config?: ConfigInput
    /** The project folder. Modules are named by their path from it, and an
     *  inline config's relative paths resolve from it. Default: the config
     *  file's folder, or else the entry's. */
    readonly root?: string
    /** Check types against the config's `types` too. Default: true. */
    readonly typeCheck?: boolean
    /** How many files to make. Overrides the config's `output`; `"single"`
     *  without either. With `"files"`, every file under the config's
     *  `rootDir` is compiled to a file of its own, its path from `rootDir`. */
    readonly output?: OutputMode
    /** Leave out what the entry never reaches. Overrides the config's
     *  `treeShaking`; off without either. */
    readonly treeShaking?: boolean
    /** Write the map from the bundle's lines back to the project's. Overrides
     *  the config's `lineMap`; on without either. Without it an error names
     *  the bundle's lines, and the entry does not run under `xpcall`. */
    readonly lineMap?: boolean
    /** Indent the output: `"\t"` or a number of spaces. Overrides the
     *  config's `indent`; no indentation without either. */
    readonly indent?: "\t" | number
    /** Write the output on one line, with as few `;` as it can take — and so
     *  without the line map, which one line cannot have. Overrides the
     *  config's `minify`; off without either. */
    readonly minify?: boolean
    /** With `"files"`, the folder the output is written to — where a host's
     *  layout (a Rojo project) finds it. Overrides the config's `outDir`;
     *  `rootDir` without either. */
    readonly outDir?: string
    /** What the entry's file is called: `main.luau`. The other files of
     *  `"chunks"` are named after it (`main_shop.luau`), and every file takes
     *  its extension. Default: the entry's own name, with `.luau`. */
    readonly outFile?: string
}

/** How the last line of every file `"files"` writes starts: what says a
 *  file is tilua's to replace or remove, and not one written by hand. On the
 *  last line, so no line the line map counts moves. */
export const WRITTEN_BY_TILUA = "-- Written by tilua"

/** One file of the output. */
export interface BundleFile {
    /** Where it goes, from the folder the output is written to: `main.luau`,
     *  `src/shop/buy.luau`. Files find each other by these, so they have to be
     *  written as they are named. */
    readonly path: string
    readonly code: string
    /** The modules in it, by name. */
    readonly modules: string[]
}

export interface BundleDiagnostic {
    /** Absolute path of the file it is about. */
    readonly file: string
    readonly message: string
    readonly line: number
    readonly column: number
    /** `type` and `config` problems are reported without stopping the build;
     *  `syntax`, `scope` (such as assigning to an import) and `module`
     *  problems leave no bundle. */
    readonly category: "syntax" | "scope" | "module" | "type" | "config"
    /** A test that always comes out the same, and the like: said, and no
     *  reason for the build to fail. */
    readonly severity?: "warning"
}

export interface BundleResult {
    /** The bundle — the entry's file, when there are several, and the first
     *  module's with `"files"` — or `undefined` when a module could not be
     *  compiled. Type errors are reported but do not stop it. */
    readonly code?: string
    /** Every file of the output, the entry's first. Empty when there is no
     *  bundle. */
    readonly files: BundleFile[]
    /** The bundled modules' names, entry first. */
    readonly modules: string[]
    readonly diagnostics: BundleDiagnostic[]
}

interface SourceModule {
    readonly file: string
    readonly name: string
    /** The file's own text. `console:log` shows a function as the code it was
     *  written as, which only the text has. */
    readonly text: string
    readonly program: Program
    readonly scopes: ScopeAnalysis
}

export async function bundle(options: BundleOptions): Promise<BundleResult> {
    const diagnostics: BundleDiagnostic[] = []
    // Without an entry, the config is the one above the folder the build
    // runs in (or `root`): a config there is what the files are under.
    const from = options.entry !== undefined ? resolve(options.entry) : resolve(options.root ?? process.cwd(), "tilua.config.json")
    const inline = options.config !== undefined && typeof options.config !== "string"
    const { config, problems } = resolveConfig(options.config, from, options.root ?? (inline ? dirname(from) : process.cwd()))
    for (const p of problems) diagnostics.push({ file: p.file, message: p.message, line: p.line ?? 1, column: p.column ?? 1, category: "config" })

    const root = resolve(options.root ?? config?.directory ?? dirname(from))
    const nameOf = (file: string): string => relative(root, file).replace(/\\/g, "/").replace(/\.tilua$/, "")
    const mode: OutputMode = options.output ?? config?.output ?? "single"
    // A file per module, and no entry: every file under `rootDir` is one.
    const perFile = mode === "files"
    const rootDir = resolve(config?.rootDir ?? root)
    const entry = options.entry !== undefined ? resolve(options.entry) : undefined
    /** Where a problem with the build as a whole is reported. */
    const anchor = entry ?? config?.path ?? from
    const stop = (message: string, file = anchor): BundleResult => ({
        files: [], modules: [], diagnostics: [...diagnostics, { file, message, line: 1, column: 1, category: "config" }],
    })
    if (!perFile && entry === undefined) return stop("No entry to build: only \"output\": \"files\" builds without one")

    // Every module the entry reaches through an import, types included — or
    // every file under `rootDir`, and what they reach.
    const sources = new Map<string, SourceModule>()
    const directives = new Map<string, Directives>()
    const queue = perFile ? tiluaFiles(rootDir) : [entry!]
    if (perFile && !queue.length) return stop(`No .tilua file under ${relative(process.cwd(), rootDir) || "."}`)
    while (queue.length) {
        const file = queue.shift()!
        if (sources.has(file)) continue
        const parsed = parseFile(file, diagnostics, directives)
        if (!parsed) return { files: [], modules: [], diagnostics }
        const { program, text } = parsed
        const scopes = analyzeScopes(program, { noLib: config?.noLib })
        for (const d of scopes.diagnostics) {
            diagnostics.push({ file, message: d.message, line: d.node.line.start, column: d.node.column.start, category: "scope" })
        }
        sources.set(file, { file, name: nameOf(file), text, program, scopes })
        // What an `import()` names is part of the project too.
        const dynamic = importExpressions(program).flatMap(node => (node.source.type === "StringLiteral" ? [node.source.value] : []))
        for (const specifier of [...importedSpecifiers(program), ...dynamic]) {
            const target = resolveModulePath(file, specifier, config)
            if (target && !target.endsWith(".d.tilua")) queue.push(target)
        }
    }

    // A file outside `rootDir` has no place under `outDir`.
    if (perFile) {
        const outside = [...sources.keys()].filter(file => isOutside(rootDir, file))
        if (outside.length) {
            return {
                files: [], modules: [],
                diagnostics: [...diagnostics, ...outside.map(file => ({
                    file, message: `This file is imported, but it is outside rootDir (${relative(root, rootDir) || "."}), where every file of "files" output has to be`,
                    line: 1, column: 1, category: "module" as const,
                }))],
            }
        }
    }

    // Types are needed either way: lowering reads them (`for x in list`).
    const analysis = analyzeModules([...sources.values()], config)

    // What the project's type libraries lower. The compiler lowers tilua
    // itself; a call written against a library's types is the library's to
    // explain, and this is where those explanations come from.
    const { lowerings, problems: loweringProblems } = await loadLowerings(analysis.lowerings)
    for (const p of loweringProblems) {
        diagnostics.push({ file: p.file, message: p.message, line: 1, column: 1, category: "config" })
    }
    if (options.typeCheck !== false) diagnostics.push(...analysis.diagnostics)

    // Lower each module the entry needs at runtime: an import only of types
    // requires nothing, and brings no module in.
    const names = Names.from(...[...sources.values()].map(s => s.program))
    const G = names.fresh("G")
    const requireExpression = luau.member(luau.identifier(G), "require")
    const importExpression = luau.member(luau.identifier(G), "import")
    // Another file of the output is loaded with `require` where the
    // libraries say their Lua reads a path, and with `loadfile` elsewhere.
    const byPath = syntaxOf(lowerings).has("requireByPath")
    // Each file is required by the others, and by whatever script wants it:
    // only a Lua that requires a file by its path can.
    if (perFile && !byPath) {
        return stop("\"output\": \"files\" needs a Lua that requires a file by its path, which Lua 5.1 does not — "
            + "add \"luau\" to 'types' (\"roblox\" loads it)", config?.path ?? anchor)
    }
    /** Where each module's file goes with `"files"`: its path from `rootDir`. */
    const outputPath = (file: string): string => relative(rootDir, file).replace(/\\/g, "/").replace(/\.tilua$/, ".luau")
    const fileOfModule = new Map([...sources.values()].map(s => [s.name, s.file]))
    // Where the files end up, and how they reach each other there: as they
    // are written, unless a library's host puts them somewhere else.
    const outDir = resolve(options.outDir ?? config?.outDir ?? rootDir)
    const written = (file: string): string => join(outDir, outputPath(file))
    let host: FilesAnswer | undefined
    let runtimeFile = join(outDir, "_tilua.luau")
    if (perFile) {
        const outputs = [...sources.keys()].map(written)
        const taken = new Set(outputs.map(pathKey))
        for (let n = 2; taken.has(pathKey(runtimeFile)); n++) runtimeFile = join(outDir, `_tilua${n}.luau`)
        for (let i = lowerings.length - 1; i >= 0 && !host; i--) {
            const { plugin, options: own } = lowerings[i]
            host = plugin.files?.({ options: own ?? {}, directory: config?.directory ?? root, outDir, files: outputs, runtime: runtimeFile })
        }
        for (const problem of host?.problems ?? []) {
            diagnostics.push({
                file: problem.file ?? config?.path ?? anchor, message: problem.message, line: 1, column: 1, category: "config",
                ...(problem.severity === "warning" && { severity: "warning" as const }),
            })
        }
        if (host?.runtime !== undefined) {
            if (isOutside(outDir, resolve(host.runtime))) return stop(`The runtime has to go inside outDir, not at ${host.runtime}`)
            if (taken.has(pathKey(host.runtime))) return stop(`The runtime cannot go at ${host.runtime}: a module's file is there`)
            runtimeFile = resolve(host.runtime)
        }
    }
    /** Where a file of the output is in the host, as names from the top. */
    const placeOf = (file: string): readonly string[] => host?.place?.(file) ?? placeInFolder(relative(outDir, file))
    /** What the file at `from` passes to `require` for the one at `to`. */
    const requireFrom = (from: string, to: string): string => pathBetween(placeOf(from), placeOf(to), host?.root)
    /** A file the host runs, which nothing loads with `require`. */
    const isScript = (file: string): boolean => host?.script?.(file) ?? false
    const modules = new Map<string, LoweredModule>()
    // Where every emitted statement was written, across all the modules. The
    // bundle is one file, so this is the only way back to the project.
    const origins = new WeakMap<LuauStatement, Origin>()
    // Each helper once for the bundle, not once in every module that uses it.
    const shared = new SharedRuntime(names)
    // What the entry never reaches is left out, when the project asks.
    const shaking = options.treeShaking ?? config?.treeShaking ?? false
    // How the output is written, and in which Lua.
    const format = { indent: options.indent ?? config?.indent, minify: options.minify ?? config?.minify ?? false }
    const printing = printOptions(syntaxOf(lowerings), format)
    // Errors named in the project's files, or left as Luau raised them. A
    // minified file is one line, which a map cannot tell apart.
    const mapping = !format.minify && (options.lineMap ?? config?.lineMap ?? true)
    const resolveIn = (file: string) => (specifier: string): string | undefined => {
        const found = resolveModulePath(file, specifier, config)
        return found !== undefined && sources.has(found) ? found : undefined
    }
    // Without an entry every file is one, and nothing is left unreached.
    const shaken = shaking && entry !== undefined && !perFile
        ? treeShake([...sources.values()].map(s => ({ file: s.file, program: s.program, scopes: s.scopes, resolve: resolveIn(s.file) })), entry)
        : undefined
    const pending = perFile ? [...sources.keys()] : [entry!]
    while (pending.length) {
        const file = pending.shift()!
        if (modules.has(file)) continue
        const source = sources.get(file)!
        const shown = relative(root, file).replace(/\\/g, "/")
        const imports = new Set<string>()
        const dynamicImports = new Set<string>()
        const lowered = lower(source.program, source.scopes, {
            names,
            types: analysis.types.get(file),
            lowerings,
            noLib: config?.noLib,
            source: source.text,
            file: shown,
            shared,
            shaken: shaken && {
                ...shaken.modules.get(file)!,
                runs: specifier => {
                    const target = resolveIn(file)(specifier)
                    return target !== undefined && shaken.sideEffects.has(target)
                },
                needed: specifier => {
                    const target = resolveIn(file)(specifier)
                    return target !== undefined && shaken.required.has(target)
                },
            },
            module: {
                name: source.name,
                require: requireExpression,
                import: importExpression,
                // One file has one line map. Several have one each, and a
                // module reads the one of the file it is in.
                lines: !mapping ? undefined : mode === "single" ? `${G}.lines` : `${G}.maps[${luauString(source.name)}]`,
                fail: mapping ? `${G}.fail` : undefined,
                arrays: `${G}.arrays`,
                // The file a module is in, required from this one by its
                // path, written out.
                loader: !perFile ? undefined : name => {
                    const target = fileOfModule.get(name)
                    if (target === undefined) return undefined
                    return parseExpressionFromSource(`function() return require(${luauString(requireFrom(written(file), written(target)))}) end`)
                },
                resolve: (specifier, dynamic) => {
                    const found = resolveModulePath(file, specifier, config)
                    if (!found || found.endsWith(".d.tilua") || !sources.has(found)) return undefined
                    pending.push(found)
                    const name = sources.get(found)!.name
                    ;(dynamic ? dynamicImports : imports).add(name)
                    return name
                },
            },
        })
        for (const d of lowered.diagnostics) diagnostics.push({ file, ...d, category: "module" })
        for (const statement of allStatements(lowered.statements)) {
            const line = lowered.origins.get(statement)
            if (line !== undefined) origins.set(statement, { file: shown, line })
        }
        modules.set(file, {
            name: source.name,
            statements: lowered.statements,
            exportsName: lowered.exportsName,
            info: lowered.module,
            usesScriptArgs: lowered.usesScriptArgs,
            shared: lowered.shared,
            imports,
            dynamicImports,
        })
    }

    // `--@tilua-nocheck`, `--@tilua-ignore`, `--@tilua-expect-error` and
    // `--@tilua-expect-warning` apply to scope and type errors and to
    // warnings, file by file.
    for (const [file, fileDirectives] of directives) {
        const semantic = diagnostics.filter(d => d.file === file && (d.category === "scope" || d.category === "type"))
        const { kept, unusedExpectErrors, unusedExpectWarnings } =
            applyDirectives(fileDirectives, semantic, d => d.line, d => d.severity === "warning")
        const suppressed = new Set(semantic.filter(d => !kept.includes(d)))
        const remaining = diagnostics.filter(d => !suppressed.has(d))
        diagnostics.length = 0
        diagnostics.push(...remaining)
        // Without type checking there is nothing an expect-error could expect.
        if (options.typeCheck === false) continue
        for (const d of unusedExpectErrors) {
            diagnostics.push({ file, message: UNUSED_EXPECT_ERROR, line: d.line, column: d.column, category: "type" })
        }
        for (const d of unusedExpectWarnings) {
            diagnostics.push({ file, message: UNUSED_EXPECT_WARNING, line: d.line, column: d.column, category: "type", severity: "warning" })
        }
    }

    // The type checker reports a missing module too; say it once.
    const moduleProblems = new Set(diagnostics.filter(d => d.category === "module").map(d => `${d.file}:${d.line}:${d.column}:${d.message}`))
    const reported = diagnostics.filter(d => d.category !== "type" || !moduleProblems.has(`${d.file}:${d.line}:${d.column}:${d.message}`))
    diagnostics.length = 0
    diagnostics.push(...reported)

    const lowered = [...modules.values()]
    const moduleNames = lowered.map(m => m.name)
    if (diagnostics.some(d => d.category === "syntax" || d.category === "scope" || d.category === "module")) {
        return { files: [], modules: moduleNames, diagnostics }
    }

    // The runtime tables too, member by member: what the modules read.
    if (shaking) shared.shake(lowered.flatMap(m => m.statements))

    // Printed as it will be written, so that what cannot be is found before
    // any of it is.
    const unwritable = (problem: string): BundleResult => ({
        files: [], modules: moduleNames,
        diagnostics: [...diagnostics, { file: anchor, message: problem, line: 1, column: 1, category: "config" }],
    })
    const write = (node: LuauProgram): string | { problem: string } => {
        const printed = printOutput(node, printing)
        return "problem" in printed ? printed : printed.code
    }

    if (perFile) {
        // A script the host runs is not a module: nothing can import one.
        const imported: BundleDiagnostic[] = []
        for (const [file, source] of sources) {
            for (const { specifier, line, column } of importSites(source.program)) {
                const target = resolveIn(file)(specifier)
                if (target === undefined || !isScript(written(target))) continue
                imported.push({
                    file, line, column, category: "module",
                    message: `'${specifier}' is a script the game runs, which nothing can import: move what it shares into a module of its own`,
                })
            }
        }
        if (imported.length) return { files: [], modules: moduleNames, diagnostics: [...diagnostics, ...imported] }

        const runtimePath = relative(outDir, runtimeFile).replace(/\\/g, "/")
        const files: BundleFile[] = []
        for (const [file, module] of modules) {
            const path = outputPath(file)
            const at = written(file)
            const script = isScript(at)
            // What the host runs first, then the runtime. The helpers are the
            // runtime's, set up once there; a file takes the ones its module
            // names as upvalues.
            const prelude = host?.prelude?.(at)
            const body: LuauStatement[] = [
                ...(prelude !== undefined ? parseLuau(prelude).body.statements : []),
                ...parseLuau(`local ${G} = require(${luauString(requireFrom(at, runtimeFile))})`).body.statements,
            ]
            for (let i = 0; i < module.shared.length; i += 100) {
                const some = module.shared.slice(i, i + 100)
                body.push(luau.local(some, some.map(name => luau.member(luau.member(luau.identifier(G), "shared"), name))))
            }
            if (module.usesScriptArgs) body.push(...parseLuau(`local scriptArgs = ${G}.scriptArgs`).body.statements)
            body.push(luau.assign(
                [luau.index(luau.member(luau.identifier(G), "modules"), luau.string(module.name))],
                [moduleTable(module)],
            ))
            // What the file returns: its module's exports, typed where a
            // library says how. Every file returns them — a script that
            // requires it gets a table, whether or not it has anything in it.
            const value = `${G}.${mapping ? "run" : "require"}(${luauString(module.name)})`
            // A script's is thrown away: nothing requires one to read it.
            const returned = module.info.exports && !script
                ? entryReturn(lowerings, module.name, value, () => analysis.exportsOf(file))
                : { statements: [], value }
            if ("problem" in returned) return stop(returned.problem.message, file)
            const ending = parseLuau(`${returned.statements.join("\n")}\nreturn ${returned.value}`).body.statements
            const chunk = luau.program(body)
            // The map goes after everything it describes.
            if (mapping) {
                const text = write(chunk)
                if (typeof text !== "string") return unwritable(text.problem)
                const lines = buildLineMap(chunk, parseLuau(text), origins)
                // Named as the host names it, which is what an error says.
                const named = host?.place?.(at) ? `${placeOf(at).join("/")}.luau` : path
                body.push(...mapRegistration(G, { path: named, modules: [module] }, lineMapSource(lines, `${G}.lineMap`)))
            }
            body.push(...ending)
            const code = write(chunk)
            if (typeof code !== "string") return unwritable(code.problem)
            const from = relative(dirname(at), file).replace(/\\/g, "/")
            files.push({ path, code: `${code}\n${WRITTEN_BY_TILUA} from ${from}: edit that file, not this one.\n`, modules: [module.name] })
        }

        const runtimeProgram = parseLuau(runtime(G, {
            several: true,
            perFile: true,
            byPath,
            files: new Map(),
            imports: lowered.some(m => m.dynamicImports.size > 0),
            mapping,
        }))
        // Every helper a module names, once: declared before the runtime's
        // table, set up after it — a helper may read the table as it is — and
        // handed to the modules' files on it.
        const helpers = shared.chunk(new Set(lowered.flatMap(m => m.shared)))
        const helperNames = helpers.declare.flatMap(statement => (statement.type === "LocalStatement" ? statement.names.map(n => n.name) : []))
        runtimeProgram.body.statements.unshift(...helpers.declare)
        runtimeProgram.body.statements.push(...helpers.define)
        if (helperNames.length) {
            runtimeProgram.body.statements.push(luau.assign(
                [luau.member(luau.identifier(G), "shared")],
                [luau.table(helperNames.map(name => luau.field(name, luau.identifier(name))))],
            ))
        }
        // No chunk was started with anything: `scriptArgs` is empty.
        if (lowered.some(m => m.usesScriptArgs)) {
            runtimeProgram.body.statements.push(...parseLuau(`${G}.scriptArgs = {}\n${G}.arrays[${G}.scriptArgs] = true`).body.statements)
        }
        runtimeProgram.body.statements.push(luau.returns([luau.identifier(G)]))
        const runtimeCode = write(runtimeProgram)
        if (typeof runtimeCode !== "string") return unwritable(runtimeCode.problem)
        files.push({ path: runtimePath, code: `${runtimeCode}\n${WRITTEN_BY_TILUA}: the runtime every file of the project requires.\n`, modules: [] })
        return { code: files[0].code, files, modules: moduleNames, diagnostics }
    }

    const several = mode !== "single"
    const layout = layoutOf(mode, modules.get(entry!)!, lowered, options.outFile)
    const usesScriptArgs = lowered.some(m => m.usesScriptArgs)
    /** What `load` is handed for each module that is not in the entry's file. */
    const elsewhere = new Map<string, string>()
    for (const file of layout.slice(1)) {
        for (const module of file.modules) elsewhere.set(module.name, loadPath(layout[0].path, file.path, byPath))
    }

    const program = parseLuau(runtime(G, {
        several,
        byPath,
        files: elsewhere,
        imports: lowered.some(m => m.dynamicImports.size > 0),
        mapping,
    }))
    const assignment = program.body.statements[1]
    // `scriptArgs` is what the bundle was started with — the chunk's own
    // `...` — and every module reaches it, so it comes before them all.
    if (usesScriptArgs) {
        program.body.statements.unshift(luau.local(["scriptArgs"], [luau.table([{ type: "TableFieldPositional", value: { type: "VarargExpression" } as never }])]))
        program.body.statements.push(...parseLuau(`${G}.arrays[scriptArgs] = true`).body.statements)
        // A module in another file has no way to the entry's locals.
        if (several) program.body.statements.push(...parseLuau(`${G}.scriptArgs = scriptArgs`).body.statements)
    }
    const modulesTable = assignment.type === "AssignmentStatement" && assignment.values[0].type === "TableExpression"
        ? (assignment.values[0].fields.find(f => f.type === "TableFieldNamed" && f.name.name === "modules") as { value: TableExpression } | undefined)?.value
        : undefined
    if (!modulesTable) throw new Error("@tilua/compiler: the bundle runtime has no modules table")
    for (const module of layout[0].modules) {
        modulesTable.fields.push({ type: "TableFieldComputed", key: luau.string(module.name), value: moduleTable(module) })
    }
    // The helpers the file's modules name are upvalues of them all.
    const helpers = shared.chunk(new Set(layout[0].modules.flatMap(m => m.shared)))
    program.body.statements.unshift(...helpers.declare)
    // The entry runs under `xpcall`, so an error nothing caught — `nil.x`, an
    // `error` of the author's — is reported in the project's files rather than
    // as a line of this bundle, and only then raised. Without a map there is
    // nothing to report it in, and it is left to rise as it is.
    const ok = names.fresh("ok")
    const result = names.fresh("result")
    const entryName = luauString(sources.get(entry!)!.name)
    const returnsExports = modules.get(entry!)!.info.exports
    // What it returns is the libraries' to say — a type, where their Lua has
    // types — and the exports table as it is otherwise.
    const returned = returnsExports
        ? entryReturn(lowerings, sources.get(entry!)!.name, mapping ? result : `${G}.require(${entryName})`, () => analysis.exportsOf(entry!))
        : undefined
    if (returned && "problem" in returned) return stop(returned.problem.message)
    const declarations = returned?.statements.join("\n") ?? ""
    const entryStatements = parseLuau(!mapping ? `${declarations}
${returned ? `return ${returned.value}` : `${G}.require(${entryName})`}` : `
local ${ok}, ${result} = xpcall(function()
    return ${G}.require(${entryName})
end, ${G}.fail)
if not ${ok} then
    error(${result}, 0)
end
${declarations}
${returned ? `return ${returned.value}` : ""}
`).body.statements
    program.body.statements.push(...entryStatements)

    // The map is read off the printed text, so it can only be built once that
    // text exists. Its own assignment then goes in immediately before the entry
    // runs — after every module body, so nothing the map describes moves.
    let printed = write(program)
    if (typeof printed !== "string") return unwritable(printed.problem)
    const map = mapping ? buildLineMap(program, parseLuau(printed), origins) : new Map<number, Origin>()
    if (mapping && (map.size || several)) {
        const mapStatements: LuauStatement[] = [luau.assign(
            [luau.member(luau.identifier(G), "lines")],
            [parseExpressionFromSource(lineMapSource(map, `${G}.lineMap`))],
        )]
        if (several) mapStatements.push(...mapRegistration(G, layout[0], `${G}.lines`))
        program.body.statements.splice(program.body.statements.length - entryStatements.length, 0, ...mapStatements)
    }
    // Set up once the map is there, which a helper may read as it is.
    program.body.statements.splice(program.body.statements.length - entryStatements.length, 0, ...helpers.define)

    printed = write(program)
    if (typeof printed !== "string") return unwritable(printed.problem)
    const files: BundleFile[] = [{ path: layout[0].path, code: printed + "\n", modules: layout[0].modules.map(m => m.name) }]
    for (const file of layout.slice(1)) {
        // Every other file: a function that adds its modules to the table it
        // is handed. It has no locals of its own for a module to trip over.
        const fileHelpers = shared.chunk(new Set(file.modules.flatMap(m => m.shared)))
        const body: LuauStatement[] = [...fileHelpers.declare]
        if (file.modules.some(m => m.usesScriptArgs)) body.push(...parseLuau(`local scriptArgs = ${G}.scriptArgs`).body.statements)
        for (const module of file.modules) {
            body.push(luau.assign(
                [luau.index(luau.member(luau.identifier(G), "modules"), luau.string(module.name))],
                [moduleTable(module)],
            ))
        }
        const chunk = luau.program([luau.returns([luau.functionExpression(luau.functionBody([G], body))])])
        // As in the entry's file: the map goes after everything it describes.
        if (mapping) {
            const lines = buildLineMap(chunk, parseLuau(print(chunk, printing)), origins)
            body.push(...mapRegistration(G, file, lineMapSource(lines, `${G}.lineMap`)))
        }
        body.push(...fileHelpers.define)
        const code = write(chunk)
        if (typeof code !== "string") return unwritable(code.problem)
        files.push({ path: file.path, code: code + "\n", modules: file.modules.map(m => m.name) })
    }

    return { code: files[0].code, files, modules: moduleNames, diagnostics }
}

/** What a file returns for a module that exports — the entry, or each
 *  module with `"files"`: `value`, unless a library's `entryExports` answers
 *  — the last loaded first. What it answers is Luau, and has to parse. */
function entryReturn(
    lowerings: readonly LoadedLowering[],
    module: string,
    value: string,
    exports: () => ModuleExports,
): { statements: string[]; value: string } | { problem: { message: string } } {
    const syntax = [...syntaxOf(lowerings)]
    for (let i = lowerings.length - 1; i >= 0; i--) {
        const { plugin, from, options } = lowerings[i]
        if (!plugin.entryExports) continue
        const answer = plugin.entryExports({ options: options ?? {}, module, value, exports: exports(), syntax })
        if (!answer) continue
        const statements = [...(answer.statements ?? [])]
        try {
            parseLuau(`${statements.join("\n")}\nreturn ${answer.value}`)
        } catch (error) {
            return { problem: { message: `'${from}' answered entryExports with Luau that does not parse: ${(error as Error).message}` } }
        }
        return { statements, value: answer.value }
    }
    return { statements: [], value }
}

/** A module, lowered, and the modules it reaches. */
interface LoweredModule {
    readonly name: string
    readonly statements: LuauStatement[]
    readonly exportsName: string
    readonly info: ModuleInfo
    readonly usesScriptArgs: boolean
    /** The bundle's shared helpers it names. */
    readonly shared: readonly string[]
    /** Modules it needs before it can run: `import`, `export ... from`. */
    readonly imports: Set<string>
    /** Modules an `import()` in it names: needed when that runs, if it does. */
    readonly dynamicImports: Set<string>
}

/** A file of the output, before it is written out as Luau. */
interface OutputFile {
    readonly path: string
    readonly modules: LoweredModule[]
}

/** A module as the bundle's table holds it: what `require` needs to know
 *  about its exports, and `load`, which runs it. */
function moduleTable(module: LoweredModule): TableExpression {
    const { names: exported, links, stars } = module.info
    const fields: TableField[] = []
    if (exported.length) fields.push(luau.field("names", luau.table(exported.map(n => luau.field(n, luau.boolean(true))))))
    if (links.length) {
        fields.push(luau.field("links", luau.table(links.map(link => luau.field(link.name, luau.table([
            { type: "TableFieldPositional", value: luau.string(link.module) },
            ...(link.imported === undefined ? [] : [{ type: "TableFieldPositional" as const, value: luau.string(link.imported) }]),
        ]))))))
    }
    if (stars.length) fields.push(luau.field("stars", luau.table(stars.map(star => ({ type: "TableFieldPositional", value: luau.string(star) })))))
    // Vararg, so a top-level `...` is still valid Luau.
    fields.push(luau.field("load", luau.functionExpression(luau.functionBody([module.exportsName], module.statements, true))))
    return luau.table(fields)
}

/**
 * Which file each module goes in. The entry's file is first.
 *
 * `"chunks"`: a module the entry reaches through `import` statements alone is
 * needed before anything runs, and stays in the entry's file. Every other
 * module is there because some `import()` leads to it, and goes with the
 * `import()`s that do: the modules one alone reaches are its file, and the
 * ones several share are a file of their own, so nothing is written twice and
 * nothing is loaded before one of them is asked for.
 */
function layoutOf(mode: OutputMode, entry: LoweredModule, modules: readonly LoweredModule[], outFile: string | undefined): OutputFile[] {
    const extension = (outFile !== undefined && extname(outFile)) || ".luau"
    const entryStem = outFile !== undefined ? basename(outFile, extname(outFile)) : posix.basename(entry.name)
    const others = modules.filter(m => m !== entry)

    if (mode === "single") return [{ path: `${entryStem}${extension}`, modules: [entry, ...others] }]

    const byName = new Map(modules.map(m => [m.name, m]))
    const reach = (root: string): Set<string> => {
        const seen = new Set<string>()
        const stack = [root]
        while (stack.length) {
            const name = stack.pop()!
            if (seen.has(name)) continue
            seen.add(name)
            stack.push(...(byName.get(name)?.imports ?? []))
        }
        return seen
    }
    const inEntry = reach(entry.name)
    const roots = [...new Set(modules.flatMap(m => [...m.dynamicImports]))].filter(root => !inEntry.has(root))
    const reached = new Map(roots.map(root => [root, reach(root)]))
    const groups = new Map<string, { roots: string[]; modules: LoweredModule[] }>()
    for (const module of others) {
        if (inEntry.has(module.name)) continue
        const by = roots.filter(root => reached.get(root)!.has(module.name))
        const key = by.join("\n")
        if (!groups.has(key)) groups.set(key, { roots: by, modules: [] })
        groups.get(key)!.modules.push(module)
    }

    const files: OutputFile[] = [{ path: `${entryStem}${extension}`, modules: modules.filter(m => inEntry.has(m.name)) }]
    const taken = new Set([entryStem])
    for (const group of groups.values()) {
        // Named for the `import()` that reaches it, when there is only one.
        const label = group.roots.length === 1 ? group.roots[0].replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "chunk" : "shared"
        let stem = `${entryStem}_${label}`
        for (let n = 2; taken.has(stem); n++) stem = `${entryStem}_${label}_${n}`
        taken.add(stem)
        files.push({ path: `${stem}${extension}`, modules: group.modules })
    }
    return files
}

/** What the entry's `load` is handed to load `file`: where it is from the
 *  entry's own file, as the loader names a file. */
function loadPath(entryPath: string, file: string, byPath: boolean): string {
    // `loadfile` reads the file itself, so it is named in full.
    return byPath ? requirePath(entryPath, file) : posix.relative(posix.dirname(entryPath), file)
}

/** Where a file is, from the folder the output is written to: its path
 *  without the extension — and for `init.luau`, which is the folder it is in
 *  (as Luau and Rojo both read it), the folder. */
function placeInFolder(path: string): string[] {
    const parts = path.replace(/\\/g, "/").replace(/\.luau?$/, "").split("/").filter(part => part !== "")
    if (parts.at(-1) === "init") parts.pop()
    return parts
}

/** What a file at `from` passes to `require` to reach the one at `to`, both
 *  as names from the top of the tree. Luau reads `./x` from the requiring
 *  file's parent, `../x` from the one above that, and `@self/x` from the file
 *  itself, which only a folder-module (`init.luau`) has anything under. A file
 *  under another top-level container is reached from the top, by `root`. */
function pathBetween(from: readonly string[], to: readonly string[], root: string | undefined): string {
    if (root !== undefined && from[0] !== to[0]) return `${root}/${to.join("/")}`
    if (to.length > from.length && from.every((part, i) => to[i] === part)) return `@self/${to.slice(from.length).join("/")}`
    const base = from.slice(0, -1)
    // Down from the deepest folder they share, which `to` is not itself: a
    // file is named from the folder it is in.
    let shared = 0
    while (shared < base.length && shared < to.length - 1 && base[shared] === to[shared]) shared++
    const up = base.length - shared
    return `${up === 0 ? "./" : "../".repeat(up)}${to.slice(shared).join("/")}`
}

/** Every module a file names — `import`, `export ... from`, `import()` —
 *  and where it does. */
function importSites(program: Program): { specifier: string; line: number; column: number }[] {
    const sites: { specifier: string; line: number; column: number }[] = []
    for (const statement of program.body.statements) {
        if (statement.type === "ImportStatement" || statement.type === "ExportAllStatement"
            || (statement.type === "ExportNamedStatement" && statement.source)) {
            const source = (statement as { source: { value: string; line: { start: number }; column: { start: number } } }).source
            sites.push({ specifier: source.value, line: source.line.start, column: source.column.start })
        }
    }
    for (const node of importExpressions(program)) {
        if (node.source.type === "StringLiteral") sites.push({ specifier: node.source.value, line: node.source.line.start, column: node.source.column.start })
    }
    return sites
}

/** A path as the file system compares it. */
function pathKey(path: string): string {
    const full = resolve(path)
    return process.platform === "win32" ? full.toLowerCase() : full
}

/** How the file of the output at `from` requires the one at `to`: a path
 *  that says where it starts, and has no extension. */
function requirePath(from: string, to: string): string {
    const path = posix.relative(posix.dirname(from), to)
    const bare = path.slice(0, path.length - posix.extname(path).length)
    return bare.startsWith("../") ? bare : `./${bare}`
}

/** Every `.tilua` file under `folder` — not a definitions file, and nothing
 *  under `node_modules` or a hidden folder — in path order. */
function tiluaFiles(folder: string): string[] {
    const found: string[] = []
    const walk = (at: string): void => {
        let entries
        try {
            entries = readdirSync(at, { withFileTypes: true })
        } catch {
            return
        }
        for (const item of entries) {
            if (item.name.startsWith(".")) continue
            const path = join(at, item.name)
            if (item.isDirectory()) {
                if (item.name !== "node_modules") walk(path)
            } else if (item.name.endsWith(".tilua") && !item.name.endsWith(".d.tilua")) {
                found.push(path)
            }
        }
    }
    walk(folder)
    return found.sort()
}

/** Is `file` outside `folder`? */
function isOutside(folder: string, file: string): boolean {
    const path = relative(folder, file)
    return path === "" || path.startsWith("..") || isAbsolute(path)
}

/** Statements that hand a file's line map — `map`, as Luau — to the bundle:
 *  under the file's own name, for an error's position to be read by, and under
 *  each of its modules, for a library's runtime in one of them. */
function mapRegistration(G: string, file: OutputFile, map: string): LuauStatement[] {
    // The file's name, a folder at a time and without its extension: what an
    // error's position is matched against, since the Lua running the file may
    // call it `C:\out\src\shop.luau`, `./shop` or `ReplicatedStorage.out.src.shop`.
    const extension = posix.extname(file.path)
    const parts = file.path.slice(0, file.path.length - extension.length).split(/[/.]/).filter(part => part !== "")
    const entry = `${G}.sources[#${G}.sources + 1]`
    return parseLuau([
        `${entry} = { { ${parts.map(luauString).join(", ")} }, ${map}, ${luauString(extension.slice(1))} }`,
        ...file.modules.map(module => `${G}.maps[${luauString(module.name)}] = ${G}.sources[#${G}.sources][2]`),
    ].join("\n")).body.statements
}

interface RuntimeOptions {
    /** The output is more than one file can be: `require` loads the file a
     *  module is in, and an error's position may be in any of them. */
    readonly several: boolean
    /** A file per module, each of which requires the runtime: a module's
     *  file is loaded by the function `require` is handed with its name. */
    readonly perFile?: boolean
    /** Another file is loaded with `require` by path, not `loadfile`. */
    readonly byPath: boolean
    /** What `load` is handed for each module outside the entry's file. */
    readonly files: ReadonlyMap<string, string>
    /** Some module writes `import()`. */
    readonly imports: boolean
    /** The bundle carries a line map, and what reads it. */
    readonly mapping: boolean
}

/** How the entry's file loads another of the output's files: `loadfile`,
 *  which every Lua has, or `require` by path where the libraries say their
 *  Lua reads one. Both read it from beside the entry's file, and both get
 *  back the function the file is. */
function loader(G: string, byPath: boolean): string {
    if (!byPath) {
        return `
        -- From beside this file, wherever that is: its own path says where.
        local folder = ""
        if debug ~= nil and debug.getinfo ~= nil then
            local at = debug.getinfo(${G}.load, "S").source
            if at:sub(1, 1) == "@" then
                folder = at:match("^@(.*[/\\\\])") or ""
            end
        end
        local chunk, problem = loadfile(folder .. file)
        if chunk == nil then
            error(problem, 0)
        end
        chunk()(${G})`
    }
    // \`require\` reads a path from the file that calls it: this one.
    return `
        require(file)(${G})`
}

/** The module table and its `require`, around the modules. */
function runtime(G: string, options: RuntimeOptions): string {
    const { several, mapping } = options
    const perFile = options.perFile ?? false
    const files =[...options.files].map(([name, file]) => `[${luauString(name)}] = ${luauString(file)}`).join(", ")
    return `
local ${G}
${G} = {
    modules = {},
    -- Every array the program made, so \`typeof\` can tell one from an object.
    -- The keys are held weakly: being written down keeps no array alive.
    arrays = setmetatable({}, { __mode = "k" }),${mapping ? `
    -- Filled in just before the entry runs: bundle line -> { file, line }.
    lines = nil,
    -- What an error nothing caught says, in the project's files: the bundle's
    -- own positions in the message are replaced by the places they came from,
    -- and a traceback of those places follows. A message that is not a string
    -- is left as it is, and a position that is not this bundle's (a library
    -- that raised its error with one already mapped) is left alone.
    --
    -- It is an \`xpcall\` handler, and a handler that fails loses the error
    -- altogether: Luau reports only "error in error handling". So the work is
    -- done under \`pcall\`, leaning on nothing it has not checked is there (an
    -- executor may lack \`debug.info\`, or refuse it), and an error it cannot
    -- map is still answered as Luau raised it, with why.
    fail = function(message)
        -- Taken first, before anything that can fail. Level 3 is the frame
        -- that raised: past \`pcall\` and this handler.
        local trace
        if debug ~= nil and debug.traceback ~= nil then
            local ok, text = pcall(debug.traceback, "", 3)
            if ok and type(text) == "string" then
                trace = text
            end
        end
        local ok, described = pcall(${G}.describe, message, trace)
        if ok then
            return described
        end
        if type(message) ~= "string" then
            return message
        end
        local why = type(described) == "string" and described or "unknown"
        return message .. "\\n(tilua could not map this error to the project's files: " .. why .. ")" .. (trace or "")
    end,
    -- \`fail\`'s work. \`trace\` is a traceback from where the error was
    -- raised, or nil when none could be taken.
    describe = function(message, trace)
        if type(message) ~= "string" then
            return message
        end
        local lines = ${G}.lines
        if lines == nil ${several ? `and #${G}.sources == 0 ` : ""}then
            return message .. (trace or "")
        end
        -- The bundle's name, as a position in a message spells it: where this
        -- function is, asked of the debug library by the function rather
        -- than by a level, which \`pcall\` would shift. Failing that, a message
        -- starts with the position it was raised at.
        local chunk
        if debug ~= nil and debug.info ~= nil then
            local found, source = pcall(debug.info, ${G}.describe, "s")
            if found and type(source) == "string" then
                chunk = source
            end
        end
        if chunk == nil and debug ~= nil and debug.getinfo ~= nil then
            local found, info = pcall(debug.getinfo, ${G}.describe, "S")
            if found and type(info) == "table" and type(info.short_src) == "string" then
                chunk = info.short_src
            end
        end
${several ? `
        -- A position in this file is read by this file's map. One in another
        -- of the bundle's files is read by that file's: the one whose name
        -- the position ends with, by the most folders where several do. A
        -- message says nothing about which file it starts in, so nothing is
        -- guessed from it here.
        local prefix = nil
        if chunk ~= nil then
            prefix = chunk:gsub("%p", "%%%0")
        end
        local function place(line)
            local origin = lines ~= nil and lines[tonumber(line)] or nil
            if origin == nil then
                return nil
            end
            return origin[1] .. ":" .. tostring(origin[2])
        end
        local function elsewhere(at, line)
            -- Already a place in the project.
            if at:sub(-6) == ".tilua" then
                return nil
            end
            local parts = {}
            for part in at:gmatch("[^/\\\\%.]+") do
                parts[#parts + 1] = part
            end
            local map, most, tied = nil, 0, false
            for _, source in ipairs(${G}.sources) do
                local names = source[1]
                local last = #parts
                if parts[last] == source[3] then
                    last = last - 1
                end
                local same = 0
                while same < #names and same < last and names[#names - same] == parts[last - same] do
                    same = same + 1
                end
                if same > most then
                    map, most, tied = source[2], same, false
                elseif same == most then
                    tied = true
                end
            end
            -- Two files it could as well be: a wrong place is worse than none.
            local origin = map ~= nil and not tied and map[tonumber(line)] or nil
            if origin == nil then
                return nil
            end
            return origin[1] .. ":" .. tostring(origin[2])
        end
        local mapped = message
        if prefix ~= nil then
            mapped = mapped:gsub(prefix .. ":(%d+)", function(line)
                return place(line)
            end)
        end
        mapped = mapped:gsub("(%S+):(%d+)", elsewhere)
        local frames = {}
        for frame in (trace or ""):gmatch("[^\\n]+") do
            local at = nil
            if prefix ~= nil then
                local line = frame:match(prefix .. ":(%d+)")
                if line ~= nil then
                    at = place(line)
                end
            end
            if at == nil then
                for source, line in frame:gmatch("(%S+):(%d+)") do
                    at = elsewhere(source, line)
                    if at ~= nil then
                        break
                    end
                end
            end
            if at ~= nil then` : `
        if chunk == nil then
            chunk = message:match("^(.-):%d+:")
        end
        if chunk == nil then
            return message .. (trace or "")
        end
        local prefix = chunk:gsub("%p", "%%%0")
        local function place(line)
            local origin = lines[tonumber(line)]
            if origin == nil then
                return nil
            end
            return origin[1] .. ":" .. tostring(origin[2])
        end
        local mapped = message:gsub(prefix .. ":(%d+)", function(line)
            return place(line)
        end)
        local frames = {}
        for frame in (trace or ""):gmatch("[^\\n]+") do
            local line = frame:match(prefix .. ":(%d+)")
            local at = line ~= nil and place(line) or nil
            if at ~= nil then`}
                -- Luau writes \`function name\`; Lua 5.1, \`function 'name'\`.
                local name = frame:match("function ([%w_.:]+)") or frame:match("function '([^']+)'")
                frames[#frames + 1] = "    at " .. at .. (name ~= nil and (" (" .. name .. ")") or "")
            end
        end
        if #frames == 0 then
            return mapped
        end
        return mapped .. "\\n" .. table.concat(frames, "\\n")
    end,
    -- A line map as it is written: the files it names, and base-64 VLQ
    -- numbers, three to a line — how far down the bundle, which file, how far
    -- down that file, each counted from the line before. It is read out the
    -- first time a line is looked up, which is when something went wrong.
    lineMap = function(files, data)
        local map = {}
        return setmetatable(map, { __index = function(_, key)
            setmetatable(map, nil)
            local digits = {}
            for i = 1, 64 do
                digits[("${VLQ_DIGITS}"):byte(i)] = i - 1
            end
            local at = 1
            local function read()
                local value, scale = 0, 1
                repeat
                    local digit = digits[data:byte(at)]
                    at = at + 1
                    value = value + digit % 32 * scale
                    scale = scale * 32
                until digit < 32
                if value % 2 == 1 then
                    return -math.floor(value / 2)
                end
                return math.floor(value / 2)
            end
            local line, file, source = 0, 0, 0
            while at <= #data do
                line = line + read()
                file = file + read()
                source = source + read()
                map[line] = { files[file], source }
            end
            return map[key]
        end })
    end,` : ""}
    records = {},${several && !perFile ? `
    -- The file each module outside this one is in, as \`load\` is handed it.
    files = { ${files} },
    loaded = {},` : ""}${several && mapping ? `
    -- Every file's line map: by the module, and by the file's name.
    maps = {},
    sources = {},` : ""}${several && !perFile ? `
    -- Another of the bundle's files: a function that adds its modules here.
    load = function(file)
        if ${G}.loaded[file] then
            return
        end
        ${G}.loaded[file] = true${loader(G, options.byPath)}
    end,` : ""}${perFile && mapping ? `
    -- What a file returns: its module's exports. The first file asked for
    -- runs under \`xpcall\`, so an error nothing caught is reported in the
    -- project's files; the files it requires in turn are inside that already.
    running = false,
    run = function(name)
        if ${G}.running then
            return ${G}.require(name)
        end
        ${G}.running = true
        local ok, result = xpcall(${G}.require, ${G}.fail, name)
        ${G}.running = false
        if not ok then
            error(result, 0)
        end
        return result
    end,` : ""}${options.imports ? `
    -- \`import("./x")\`: the module's exports, asked for where the code runs
    -- rather than before its module does. \`require\` does the rest — and
    -- loads the file the module is in, if it is not this one.
    import = function(name${perFile ? ", load" : ""})
        return ${G}.require(name${perFile ? ", load" : ""})
    end,` : ""}
    require = function(name${perFile ? ", load" : ""})
        local record = ${G}.records[name]
        if record ~= nil then
            return record.exports
        end
        local module = ${G}.modules[name]${perFile ? `
        -- Its file has not run: requiring it adds the module, and runs it.
        if module == nil and load ~= nil then
            load()
            record = ${G}.records[name]
            if record ~= nil then
                return record.exports
            end
            module = ${G}.modules[name]
        end
        if module == nil then
            error(("Cannot find module '%s': nothing has loaded the file it is in"):format(name), 2)
        end` : several ? `
        if module == nil then
            ${G}.load(${G}.files[name])
            module = ${G}.modules[name]
        end` : ""}
        local initialized = {}
        local exports = setmetatable({}, {
            __index = function(_, key)
                if initialized[key] then
                    return nil
                end
                if module.names ~= nil and module.names[key] then
                    error(("Cannot access '%s' before initialization: '%s' has not reached it yet"):format(tostring(key), name), 2)
                end
                local link = module.links ~= nil and module.links[key]
                if link then
                    local source = ${G}.require(link[1])
                    if link[2] == nil then
                        return source
                    end
                    return source[link[2]]
                end
                if module.stars ~= nil and key ~= "default" then
                    for _, star in ipairs(module.stars) do
                        local value = ${G}.require(star)[key]
                        if value ~= nil then
                            return value
                        end
                    end
                end
                return nil
            end,
            __newindex = function(target, key, value)
                initialized[key] = true
                rawset(target, key, value)
            end,
        })
        record = { loading = true, exports = exports }
        ${G}.records[name] = record
        module.load(exports)
        record.loading = false
        return exports
    end,
}
`
}

/** A file's size and when it was last written — what says whether anything
 *  remembered about it still holds. An unreadable file has no stamp, and
 *  nothing about it is kept. */
function stampOf(file: string): string | undefined {
    try {
        const at = statSync(file)
        return `${at.size}:${at.mtimeMs}`
    } catch {
        return undefined
    }
}

/** Files parsed in this process, by what they were when they were read. A
 *  build that runs again — a watch, or several entry points over one project
 *  — reads each file once. */
const parsedFiles = new Map<string, { stamp: string; program: Program; text: string; directives: Directives }>()

function parseFile(file: string, diagnostics: BundleDiagnostic[], directives: Map<string, Directives>): { program: Program; text: string } | undefined {
    const stamp = stampOf(file)
    const cached = stamp !== undefined ? parsedFiles.get(file) : undefined
    if (cached && cached.stamp === stamp) {
        directives.set(file, cached.directives)
        return { program: cached.program, text: cached.text }
    }
    let text: string
    try {
        text = readFileSync(file, "utf8")
    } catch {
        diagnostics.push({ file, message: "Cannot read file", line: 1, column: 1, category: "module" })
        return undefined
    }
    try {
        const program = parse(text)
        const found = directivesOf(text)
        directives.set(file, found)
        if (stamp !== undefined) parsedFiles.set(file, { stamp, program, text, directives: found })
        return { program, text }
    } catch (error) {
        if (error instanceof ParseError || error instanceof LexError) {
            const { line, column } = error as unknown as { line: number; column: number }
            diagnostics.push({ file, message: (error as Error).message, line, column, category: "syntax" })
            return undefined
        }
        throw error
    }
}

function importedSpecifiers(program: Program): string[] {
    return program.body.statements.flatMap(s =>
        s.type === "ImportStatement" || s.type === "ExportAllStatement" || (s.type === "ExportNamedStatement" && s.source)
            ? [(s as { source: { value: string } }).source.value]
            : [])
}

/** Definitions files, parsed once per process. A project's Roblox library is
 *  twenty thousand lines that every entry point would otherwise read again,
 *  and the tree is only read from — never changed by an analysis. The file's
 *  size and modification time say when it has to be read anew. */
const libraryCache = new Map<string, { stamp: string; program: Program }>()

function parsedLibrary(file: string): Program {
    let stamp: string
    try {
        const at = statSync(file)
        stamp = `${at.size}:${at.mtimeMs}`
    } catch {
        stamp = ""
    }
    const cached = libraryCache.get(file)
    if (cached && cached.stamp === stamp) return cached.program
    const program = parse(readFileSync(file, "utf8"))
    libraryCache.set(file, { stamp, program })
    return program
}

/** What each module's analysis was, and what it depended on. A second build in
 *  the same process — the next entry point, or a watch's next run — keeps the
 *  analysis of every module whose files are still what they were. */
const moduleAnalyses = new Map<string, {
    setting: string
    libs: readonly Program[]
    program: Program
    read: Map<string, string>
    result: ModuleAnalysis
}>()

/** A module's types and type errors, and the scopes its types are of. */
interface ModuleAnalysis {
    types: TypeAnalysis
    diagnostics: BundleDiagnostic[]
    scopes: ScopeAnalysis
}

/** Every module's types, and its type errors, against the config's type libraries. */
function analyzeModules(
    modules: SourceModule[],
    config: TiluaConfig | undefined,
): {
    types: Map<string, TypeAnalysis>
    diagnostics: BundleDiagnostic[]
    lowerings: TypeLibraries["lowerings"][number][]
    /** What a module of the project exports, as an importer sees it. */
    exportsOf: (file: string) => ModuleExports
} {
    const out: BundleDiagnostic[] = []
    const analyses = new Map<string, TypeAnalysis>()
    const libraries: TypeLibraries = config ? resolveTypeLibraries(config) : { files: [], lowerings: [], options: [], problems: [] }
    for (const p of libraries.problems) out.push({ file: p.file, message: p.message, line: p.line ?? 1, column: p.column ?? 1, category: "config" })

    const libs = libraries.files.map(parsedLibrary)
    const noLib = config?.noLib ?? false
    const checked = libs.length > 0 || !noLib
    const globals = libs.flatMap(lib => lib.body.statements.flatMap(s => (s.type === "DeclareStatement" ? [s.name] : [])))

    const byFile = new Map(modules.map(m => [m.file, m]))
    const exportsCache = new Map<string, ModuleExports>()
    const inProgress = new Set<string>()
    /** Each module is analyzed once, whether an import asked for it first or
     *  the loop below reached it: the analysis an import needs is the same one
     *  the module is compiled from, diagnostics and all. */
    const analyzed = new Map<string, ModuleAnalysis>()
    /** How often a cycle has handed out partial exports. An analysis that saw
     *  one is not kept: what it read was not the whole module. */
    let partials = 0
    /** What each module read while it was analyzed — itself and, through its
     *  imports, every module below it. An analysis holds only as long as all
     *  of them are the files they were. */
    const readWhile = new Map<string, Map<string, string>>()
    const settingFor = `${libraries.files.join("|")}#${config?.directory ?? ""}#${JSON.stringify(config?.paths ?? {})}`

    const analyzeModule = (file: string, program: Program): ModuleAnalysis => {
        const done = analyzed.get(file)
        if (done) return done
        const remembered = moduleAnalyses.get(file)
        if (remembered && remembered.setting === settingFor && libs.length === remembered.libs.length
            && remembered.libs.every((lib, i) => lib === libs[i])
            && remembered.program === program
            && [...remembered.read].every(([read, stamp]) => stampOf(read) === stamp)) {
            analyzed.set(file, remembered.result)
            readWhile.set(file, remembered.read)
            return remembered.result
        }
        // Lua's standard library is always there, so every name is checked —
        // unless the project left it out and named no library: then even
        // `print` is undeclared, and saying so would be noise.
        const scopes = analyzeScopes(program, { builtinGlobals: globals, reportUndeclared: checked, noLib })
        const said: BundleDiagnostic[] = []
        // A name nothing declares is reported, but builds: in Luau it is a
        // global that reads as nil, not a program that cannot be compiled.
        for (const d of scopes.diagnostics) {
            if (d.kind !== "undeclared") continue
            said.push({ file, message: d.message, line: d.node.line.start, column: d.node.column.start, category: "type" })
        }
        const before = partials
        const types = analyzeTypes(program, scopes, {
            libs,
            resolveModule: resolverFor(file),
            noLib,
            reportUnknownTypes: checked,
        })
        for (const d of types.diagnostics) {
            const at = d.node as { line: { start: number }; column: { start: number } }
            said.push({ file, message: d.message, line: at.line.start, column: at.column.start, category: "type", severity: d.severity })
        }
        const result = { types, diagnostics: said, scopes }
        if (partials === before) {
            analyzed.set(file, result)
            const read = readWhile.get(file) ?? new Map<string, string>()
            const own = stampOf(file)
            if (own !== undefined) read.set(file, own)
            readWhile.set(file, read)
            // Only a module whose every file was readable is worth keeping:
            // one that was not may become readable, and change the answer.
            if ([...read.values()].every(stamp => stamp !== undefined)) {
                moduleAnalyses.set(file, { setting: settingFor, libs: [...libs], program, read, result })
            }
        }
        return result
    }

    const resolverFor = (file: string) => (specifier: string): ModuleExports | undefined => {
        const target = resolveModulePath(file, specifier, config)
        if (!target) return undefined
        // What this module read, and what that module had read in turn: any of
        // them changing means this analysis has to happen again. Taken after
        // the import is resolved, so the one below is complete.
        const noteRead = (): void => {
            const read = readWhile.get(file) ?? new Map<string, string>()
            readWhile.set(file, read)
            const stamp = stampOf(target)
            if (stamp !== undefined) read.set(target, stamp)
            for (const [below, belowStamp] of readWhile.get(target) ?? []) read.set(below, belowStamp)
        }
        if (inProgress.has(target)) {
            partials++
            return { values: new Map(), types: new Map(), partial: true }
        }
        const cached = exportsCache.get(target)
        if (cached) {
            noteRead()
            return cached
        }
        let program = byFile.get(target)?.program
        if (!program) {
            try {
                program = parse(readFileSync(target, "utf8"))
            } catch {
                return undefined
            }
        }
        inProgress.add(target)
        try {
            const scopes = analyzeScopes(program, { builtinGlobals: globals, noLib })
            const types = byFile.has(target)
                ? analyzeModule(target, program).types
                : analyzeTypes(program, scopes, { libs, noLib, resolveModule: resolverFor(target), diagnostics: false })
            const exports = moduleExports(program, scopes, types, resolverFor(target))
            exportsCache.set(target, exports)
            noteRead()
            return exports
        } finally {
            inProgress.delete(target)
        }
    }

    for (const module of modules) {
        const { types, diagnostics } = analyzeModule(module.file, module.program)
        analyses.set(module.file, types)
        out.push(...diagnostics)
    }
    const exportsOf = (file: string): ModuleExports => {
        const cached = exportsCache.get(file)
        if (cached) return cached
        const module = byFile.get(file)!
        const { types, scopes } = analyzeModule(file, module.program)
        const exports = moduleExports(module.program, scopes, types, resolverFor(file))
        exportsCache.set(file, exports)
        return exports
    }
    return { types: analyses, diagnostics: out, lowerings: [...libraries.lowerings], exportsOf }
}

/** Every statement inside `statements`, nested ones included. */
function allStatements(statements: readonly LuauStatement[]): LuauStatement[] {
    const out: LuauStatement[] = []
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return
        if (Array.isArray(value)) return void value.forEach(visit)
        const record = value as Record<string, unknown>
        if (typeof record.type === "string" && record.type.endsWith("Statement")) {
            out.push(value as LuauStatement)
        }
        for (const [key, child] of Object.entries(record)) {
            if (key !== "line" && key !== "column") visit(child)
        }
    }
    visit(statements)
    return out
}
