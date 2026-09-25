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
import { readFileSync, statSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import {
    parse, analyzeScopes, analyzeTypes, moduleExports, resolveModulePath, resolveTypeLibraries,
    directivesOf, applyDirectives, UNUSED_EXPECT_ERROR, ParseError, LexError, luauString,
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
    const modules = new Map<string, {
        name: string
        statements: LuauStatement[]
        exportsName: string
        info: ModuleInfo
        usesScriptArgs: boolean
    }>()
    // Where every emitted statement was written, across all the modules. The
    // bundle is one file, so this is the only way back to the project.
    const origins = new WeakMap<LuauStatement, Origin>()
    const pending = [entry]
    while (pending.length) {
        const file = pending.shift()!
        if (modules.has(file)) continue
        const source = sources.get(file)!
        const shown = relative(root, file).replace(/\\/g, "/")
        const lowered = lower(source.program, source.scopes, {
            names,
            types: analysis.types.get(file),
            lowerings,
            target: options.target ?? config?.target,
            source: source.text,
            file: shown,
            module: {
                name: source.name,
                require: requireExpression,
                lines: `${G}.lines`,
                fail: `${G}.fail`,
                resolve: specifier => {
                    const target = resolveModulePath(file, specifier, config)
                    if (!target || target.endsWith(".d.tilua") || !sources.has(target)) return undefined
                    pending.push(target)
                    return sources.get(target)!.name
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
    // `scriptArgs` is what the bundle was started with — the chunk's own
    // `...` — and every module reaches it, so it comes before them all.
    if ([...modules.values()].some(m => m.usesScriptArgs)) {
        program.body.statements.unshift(luau.local(["scriptArgs"], [luau.table([{ type: "TableFieldPositional", value: { type: "VarargExpression" } as never }])]))
    }
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
    // The entry runs under `xpcall`, so an error nothing caught — `nil.x`, an
    // `error` of the author's — is reported in the project's files rather than
    // as a line of this bundle, and only then raised.
    const ok = names.fresh("ok")
    const result = names.fresh("result")
    const entryStatements = parseLuau(`
local ${ok}, ${result} = xpcall(function()
    return ${G}.require(${luauString(sources.get(entry)!.name)})
end, ${G}.fail)
if not ${ok} then
    error(${result}, 0)
end
${modules.get(entry)!.info.exports ? `return ${result}` : ""}
`).body.statements
    program.body.statements.push(...entryStatements)

    // The map is read off the printed text, so it can only be built once that
    // text exists. Its own assignment then goes in immediately before the entry
    // runs — after every module body, so nothing the map describes moves.
    const map = buildLineMap(program, parseLuau(print(program)), origins)
    if (map.size) {
        program.body.statements.splice(program.body.statements.length - entryStatements.length, 0, luau.assign(
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
        if lines == nil then
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
            if at ~= nil then
                local name = frame:match("function ([%w_.:]+)")
                frames[#frames + 1] = "    at " .. at .. (name ~= nil and (" (" .. name .. ")") or "")
            end
        end
        if #frames == 0 then
            return mapped
        end
        return mapped .. "\\n" .. table.concat(frames, "\\n")
    end,
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
    result: { types: TypeAnalysis; diagnostics: BundleDiagnostic[] }
}>()

/** Every module's types, and its type errors, against the config's type libraries. */
function analyzeModules(
    modules: SourceModule[],
    config: TiluaConfig | undefined,
): {
    types: Map<string, TypeAnalysis>
    diagnostics: BundleDiagnostic[]
    lowerings: { file: string; from: string; library: number }[]
} {
    const out: BundleDiagnostic[] = []
    const analyses = new Map<string, TypeAnalysis>()
    const libraries = config ? resolveTypeLibraries(config) : { files: [], lowerings: [], problems: [] }
    for (const p of libraries.problems) out.push({ file: p.file, message: p.message, line: p.line ?? 1, column: p.column ?? 1, category: "config" })

    const libs = libraries.files.map(parsedLibrary)
    const globals = libs.flatMap(lib => lib.body.statements.flatMap(s => (s.type === "DeclareStatement" ? [s.name] : [])))

    const byFile = new Map(modules.map(m => [m.file, m]))
    const exportsCache = new Map<string, ModuleExports>()
    const inProgress = new Set<string>()
    /** Each module is analyzed once, whether an import asked for it first or
     *  the loop below reached it: the analysis an import needs is the same one
     *  the module is compiled from, diagnostics and all. */
    const analyzed = new Map<string, { types: TypeAnalysis; diagnostics: BundleDiagnostic[] }>()
    /** How often a cycle has handed out partial exports. An analysis that saw
     *  one is not kept: what it read was not the whole module. */
    let partials = 0
    /** What each module read while it was analyzed — itself and, through its
     *  imports, every module below it. An analysis holds only as long as all
     *  of them are the files they were. */
    const readWhile = new Map<string, Map<string, string>>()
    const settingFor = `${libraries.files.join("|")}#${config?.directory ?? ""}#${JSON.stringify(config?.paths ?? {})}`

    const analyzeModule = (file: string, program: Program): { types: TypeAnalysis; diagnostics: BundleDiagnostic[] } => {
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
        // Without a type library even `print` is undeclared: only check names
        // against libraries that are there.
        const scopes = analyzeScopes(program, { builtinGlobals: globals, reportUndeclared: libs.length > 0 })
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
            reportUnknownTypes: libs.length > 0,
        })
        for (const d of types.diagnostics) {
            const at = d.node as { line: { start: number }; column: { start: number } }
            said.push({ file, message: d.message, line: at.line.start, column: at.column.start, category: "type" })
        }
        const result = { types, diagnostics: said }
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
            const scopes = analyzeScopes(program, { builtinGlobals: globals })
            const types = byFile.has(target)
                ? analyzeModule(target, program).types
                : analyzeTypes(program, scopes, { libs, resolveModule: resolverFor(target), diagnostics: false })
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
