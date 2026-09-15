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
 */
import { readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import {
    parse, analyzeScopes, analyzeTypes, moduleExports, resolveModulePath, resolveTypeLibraries,
    directivesOf, applyDirectives, UNUSED_EXPECT_ERROR, ParseError, LexError,
    type ModuleExports, type Program, type ScopeAnalysis, type TiluaConfig, type TypeAnalysis, type Directives,
} from "@tilua/parser"
import { parse as parseLuau, parseExpressionFromSource, print, type Statement as LuauStatement, type TableExpression, type TableField } from "luau-parser"
import { resolveConfig, type ConfigInput } from "./config.js"
import { lower, type ModuleInfo, type Target } from "./lower.js"
import { buildLineMap, lineMapSource, type Origin } from "./linemap.js"
import { loadLowerings } from "./lowering.js"
import * as luau from "./luau.js"
import { Names } from "./names.js"

export interface BundleOptions {
    /** The file the bundle runs. */
    readonly entry: string
    /** A `tilua.config.json` path or contents. Default: the nearest config above the entry. */
    readonly config?: ConfigInput
    /** The project folder. Modules are named by their path from it, and an
     *  inline config's relative paths resolve from it. Default: the config
     *  file's folder, or else the entry's. */
    readonly root?: string
    /** Check types against the config's `types` too. Default: true. */
    readonly typeCheck?: boolean
    /** Which Lua the output must run on. Overrides the config's `target`. */
    readonly target?: Target
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
}

export interface BundleResult {
    /** The bundle, or `undefined` when a module could not be compiled. Type
     *  errors are reported but do not stop it. */
    readonly code?: string
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
    const entry = resolve(options.entry)
    const diagnostics: BundleDiagnostic[] = []
    const inline = options.config !== undefined && typeof options.config !== "string"
    const { config, problems } = resolveConfig(options.config, entry, options.root ?? (inline ? dirname(entry) : process.cwd()))
    for (const p of problems) diagnostics.push({ file: p.file, message: p.message, line: p.line ?? 1, column: p.column ?? 1, category: "config" })

    const root = resolve(options.root ?? config?.directory ?? dirname(entry))
    const nameOf = (file: string): string => relative(root, file).replace(/\\/g, "/").replace(/\.tilua$/, "")

    // Every module the entry reaches through an import, types included.
    const sources = new Map<string, SourceModule>()
    const directives = new Map<string, Directives>()
    const queue = [entry]
    while (queue.length) {
        const file = queue.shift()!
        if (sources.has(file)) continue
        const parsed = parseFile(file, diagnostics, directives)
        if (!parsed) return { modules: [], diagnostics }
        const { program, text } = parsed
        const scopes = analyzeScopes(program)
        for (const d of scopes.diagnostics) {
            diagnostics.push({ file, message: d.message, line: d.node.line.start, column: d.node.column.start, category: "scope" })
        }
        sources.set(file, { file, name: nameOf(file), text, program, scopes })
        for (const specifier of importedSpecifiers(program)) {
            const target = resolveModulePath(file, specifier, config)
            if (target && !target.endsWith(".d.tilua")) queue.push(target)
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
    const modules = new Map<string, { name: string; statements: LuauStatement[]; exportsName: string; info: ModuleInfo }>()
    // Where every emitted statement was written, across all the modules. The
    // bundle is one file, so this is the only way back to the project.
    const origins = new WeakMap<LuauStatement, Origin>()
    const pending = [entry]
    while (pending.length) {
        const file = pending.shift()!
        if (modules.has(file)) continue
        const source = sources.get(file)!
        const lowered = lower(source.program, source.scopes, {
            names,
            types: analysis.types.get(file),
            lowerings,
            target: options.target ?? config?.target,
            source: source.text,
            module: {
                name: source.name,
                require: requireExpression,
                lines: `${G}.lines`,
                resolve: specifier => {
                    const target = resolveModulePath(file, specifier, config)
                    if (!target || target.endsWith(".d.tilua") || !sources.has(target)) return undefined
                    pending.push(target)
                    return sources.get(target)!.name
                },
            },
        })
        for (const d of lowered.diagnostics) diagnostics.push({ file, ...d, category: "module" })
        const shown = relative(root, file).replace(/\\/g, "/")
        for (const statement of allStatements(lowered.statements)) {
            const line = lowered.origins.get(statement)
            if (line !== undefined) origins.set(statement, { file: shown, line })
        }
        modules.set(file, {
            name: source.name,
            statements: lowered.statements,
            exportsName: lowered.exportsName,
            info: lowered.module,
        })
    }

    // `--@tilua-nocheck`, `--@tilua-ignore` and `--@tilua-expect-error` apply
    // to scope and type errors, file by file.
    for (const [file, fileDirectives] of directives) {
        const semantic = diagnostics.filter(d => d.file === file && (d.category === "scope" || d.category === "type"))
        const { kept, unusedExpectErrors } = applyDirectives(fileDirectives, semantic, d => d.line)
        const suppressed = new Set(semantic.filter(d => !kept.includes(d)))
        const remaining = diagnostics.filter(d => !suppressed.has(d))
        diagnostics.length = 0
        diagnostics.push(...remaining)
        // Without type checking there is nothing an expect-error could expect.
        if (options.typeCheck === false) continue
        for (const d of unusedExpectErrors) {
            diagnostics.push({ file, message: UNUSED_EXPECT_ERROR, line: d.line, column: d.column, category: "type" })
        }
    }

    // The type checker reports a missing module too; say it once.
    const moduleProblems = new Set(diagnostics.filter(d => d.category === "module").map(d => `${d.file}:${d.line}:${d.column}:${d.message}`))
    const reported = diagnostics.filter(d => d.category !== "type" || !moduleProblems.has(`${d.file}:${d.line}:${d.column}:${d.message}`))
    diagnostics.length = 0
    diagnostics.push(...reported)

    const moduleNames = [...modules.values()].map(m => m.name)
    if (diagnostics.some(d => d.category === "syntax" || d.category === "scope" || d.category === "module")) {
        return { modules: moduleNames, diagnostics }
    }

    const program = parseLuau(runtime(G))
    const assignment = program.body.statements[1]
    const modulesTable = assignment.type === "AssignmentStatement" && assignment.values[0].type === "TableExpression"
        ? (assignment.values[0].fields.find(f => f.type === "TableFieldNamed" && f.name.name === "modules") as { value: TableExpression } | undefined)?.value
        : undefined
    if (!modulesTable) throw new Error("@tilua/compiler: the bundle runtime has no modules table")
    for (const module of modules.values()) {
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
        modulesTable.fields.push({ type: "TableFieldComputed", key: luau.string(module.name), value: luau.table(fields) })
    }
    const start = luau.call(requireExpression, [luau.string(sources.get(entry)!.name)])
    program.body.statements.push(modules.get(entry)!.info.exports ? luau.returns([start]) : luau.callStatement(start))

    // The map is read off the printed text, so it can only be built once that
    // text exists. Its own assignment then goes in immediately before the entry
    // call — after every module body, so nothing the map describes moves.
    const map = buildLineMap(program, parseLuau(print(program)), origins)
    if (map.size) {
        program.body.statements.splice(program.body.statements.length - 1, 0, luau.assign(
            [luau.member(luau.identifier(G), "lines")],
            [parseExpressionFromSource(lineMapSource(map))],
        ))
    }

    return { code: print(program) + "\n", modules: moduleNames, diagnostics }
}

/** The module table and its `require`, around the modules. */
function runtime(G: string): string {
    return `
local ${G}
${G} = {
    modules = {},
    records = {},
    require = function(name)
        local record = ${G}.records[name]
        if record ~= nil then
            return record.exports
        end
        local module = ${G}.modules[name]
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
                    for _, star in module.stars do
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

function parseFile(file: string, diagnostics: BundleDiagnostic[], directives: Map<string, Directives>): { program: Program; text: string } | undefined {
    let text: string
    try {
        text = readFileSync(file, "utf8")
    } catch {
        diagnostics.push({ file, message: "Cannot read file", line: 1, column: 1, category: "module" })
        return undefined
    }
    try {
        const program = parse(text)
        directives.set(file, directivesOf(text))
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

/** Every module's types, and its type errors, against the config's type libraries. */
function analyzeModules(
    modules: SourceModule[],
    config: TiluaConfig | undefined,
): {
    types: Map<string, TypeAnalysis>
    diagnostics: BundleDiagnostic[]
    lowerings: { file: string; from: string }[]
} {
    const out: BundleDiagnostic[] = []
    const analyses = new Map<string, TypeAnalysis>()
    const libraries = config ? resolveTypeLibraries(config) : { files: [], lowerings: [], problems: [] }
    for (const p of libraries.problems) out.push({ file: p.file, message: p.message, line: p.line ?? 1, column: p.column ?? 1, category: "config" })

    const libs = libraries.files.map(file => parse(readFileSync(file, "utf8")))
    const globals = libs.flatMap(lib => lib.body.statements.flatMap(s => (s.type === "DeclareStatement" ? [s.name] : [])))

    const byFile = new Map(modules.map(m => [m.file, m]))
    const exportsCache = new Map<string, ModuleExports>()
    const inProgress = new Set<string>()
    const resolverFor = (file: string) => (specifier: string): ModuleExports | undefined => {
        const target = resolveModulePath(file, specifier, config)
        if (!target) return undefined
        if (inProgress.has(target)) return { values: new Map(), types: new Map(), partial: true }
        const cached = exportsCache.get(target)
        if (cached) return cached
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
            const scopes = analyzeScopes(program, { builtinGlobals: globals })
            const types = analyzeTypes(program, scopes, { libs, resolveModule: resolverFor(target), diagnostics: false })
            const exports = moduleExports(program, scopes, types, resolverFor(target))
            exportsCache.set(target, exports)
            return exports
        } finally {
            inProgress.delete(target)
        }
    }

    for (const module of modules) {
        // Without a type library even `print` is undeclared: only check names
        // against libraries that are there.
        const scopes = analyzeScopes(module.program, { builtinGlobals: globals, reportUndeclared: libs.length > 0 })
        // A name nothing declares is reported, but builds: in Luau it is a
        // global that reads as nil, not a program that cannot be compiled.
        for (const d of scopes.diagnostics) {
            if (d.kind !== "undeclared") continue
            out.push({ file: module.file, message: d.message, line: d.node.line.start, column: d.node.column.start, category: "type" })
        }
        const types = analyzeTypes(module.program, scopes, {
            libs,
            resolveModule: resolverFor(module.file),
            reportUnknownTypes: libs.length > 0,
        })
        analyses.set(module.file, types)
        for (const d of types.diagnostics) {
            const at = d.node as { line: { start: number }; column: { start: number } }
            out.push({ file: module.file, message: d.message, line: at.line.start, column: at.column.start, category: "type" })
        }
    }
    return { types: analyses, diagnostics: out, lowerings: [...libraries.lowerings] }
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
