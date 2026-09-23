/**
 * tilua AST -> Luau AST.
 *
 * Everything tilua adds over Luau is rewritten into plain Luau here; the
 * result is an ordinary luau-parser tree, printed by luau-parser's printer.
 *
 *   const { a, b } = value          local a, b = value.a, value.b
 *   const [x, y] = list             local x, y = list[1], list[2]
 *   { name: "n", count }            { name = "n", count = count }
 *   [...xs, 1]                      concat(xs, { 1 })
 *   `${a} any`                      ("%s any"):format(tostring(a))
 *   function f(n = 1) ... end       function f(n) if n == nil then n = 1 end ... end
 *   x as T / x satisfies T          x
 *
 * Types have no runtime meaning, so every annotation, alias and `declare` is
 * dropped: the output is untyped Luau.
 *
 * ## Modules
 *
 * In a bundle each file becomes a function that fills in its `exports` table
 * (see `bundle.ts`), and modules behave the way ES modules do:
 *
 *   - **Live bindings.** An exported binding lives on `exports` itself, so
 *     every read and write of it goes through `exports.name`. An imported name
 *     is read through the imported module's table (`util.clamp`), never
 *     copied — a value the other module sets later is still seen.
 *   - **Hoisting.** Every top-level name is declared before any code runs, and
 *     every top-level function is defined then too, ahead of the imports. In a
 *     cycle — `a` imports `b`, which imports `a` while `a` is still loading —
 *     `b` receives `a`'s partly filled table, and can already call its
 *     functions.
 */
import type * as T from "@tilua/parser"
import type { Binding, BindingId, BuildTarget, ScopeAnalysis, Type, TypeAnalysis } from "@tilua/parser"
import { formatType } from "@tilua/parser"
import type * as L from "luau-parser"
import { parse as parseLuau, parseExpressionFromSource } from "luau-parser"
import * as luau from "./luau.js"
import { Names } from "./names.js"
import type { ArgumentInfo, CallSite, LoadedLowering } from "./lowering.js"
import { languageLowering } from "./language.js"

/** What lowering a file as a module of a bundle needs. */
export interface ModuleContext {
    /** The bundle's name for this module. */
    readonly name: string
    /** The bundle's name for the module `specifier` imports, or `undefined`
     *  when there is no such module (reported). */
    resolve(specifier: string): string | undefined
    /** The bundle's `require`: an expression that, called with a module's
     *  name, returns its exports table. */
    readonly require: L.Expression
    /** Luau reaching the bundle's line map — what a library's runtime reads,
     *  as `__LINES__`, to name the file a frame was written in. */
    readonly lines?: string
    /** Luau reaching the bundle's error reporter — what a library's runtime
     *  reads, as `__FAIL__`, to report an error from a callback the way an
     *  error that reached the entry is reported. */
    readonly fail?: string
}

export interface LowerOptions {
    /** Lower the file as a module of a bundle. Without it, `import` and
     *  `export` are errors. */
    readonly module?: ModuleContext
    /** Names already taken beyond the file's own — a bundle's. */
    readonly names?: Names
    /** The file's types. They decide what `for x in t` means: over a table
     *  it yields the values, which in Luau needs a key variable before `x`.
     *  They also say what a method call is called on, which decides whether
     *  `methods` claims it. */
    readonly types?: TypeAnalysis
    /** What the project's type libraries lower, already loaded (see
     *  `loadLowerings`). The compiler lowers the language; a call written
     *  against a library's types is the library's to explain. */
    readonly lowerings?: readonly LoadedLowering[]
    /** The file's own text, so a library can be told the code an argument was
     *  written as (`console:log` shows a function that way). */
    readonly source?: string
    /** The file as a library's runtime names it — `src/shop/buy.tilua` —
     *  in the call sites it is handed. */
    readonly file?: string
    /** Which Lua the output has to run on. Default `"luau"`. `"lua51"` also
     *  lowers what Luau adds to Lua and 5.1 has no syntax for — `a += b`,
     *  `continue`, `if c then a else b` as an expression, `//`. */
    readonly target?: Target
}

/** `"luau"` is Roblox's Lua. `"lua51"` is stock Lua 5.1, which has none of
 *  Luau's additions — and no `goto` either, so `continue` has to be built out
 *  of the loops 5.1 does have. */
export type Target = BuildTarget

export interface LowerDiagnostic {
    readonly message: string
    readonly line: number
    readonly column: number
}

export interface LowerResult {
    readonly statements: L.Statement[]
    /** In a module: the parameter the statements fill in with the exports. */
    readonly exportsName: string
    /** In a module: what the bundle's `require` needs to know about it. */
    readonly module: ModuleInfo
    readonly diagnostics: LowerDiagnostic[]
    /** The line of the *source* file each emitted statement came from. With the
     *  file it was lowered from, this is what turns a line of the bundle back
     *  into a place someone can open. */
    readonly origins: WeakMap<L.Statement, number>
    /** The file reads `scriptArgs`: whatever runs it has to set it up, from
     *  the chunk's own `...` — this file, compiled alone, does it itself. */
    readonly usesScriptArgs: boolean
}

/** How a module's exports behave at runtime, beyond what its code assigns. */
export interface ModuleInfo {
    /** Names the module itself exports. Reading one before the module has
     *  initialized it is an error, as in ES modules. */
    readonly names: string[]
    /** Names re-exported from another module — `export { x as y } from` —
     *  read from that module on every access, so they stay live.
     *  `imported` is `undefined` for the whole module (`import * as M; export { M }`). */
    readonly links: { name: string; module: string; imported?: string }[]
    /** `export * from` modules, consulted live for any other name. */
    readonly stars: string[]
    /** Whether the module exports anything. */
    exports: boolean
}

export function lower(program: T.Program, scopes: ScopeAnalysis, options: LowerOptions = {}): LowerResult {
    return new Lowerer(program, scopes, options).run()
}

/** A runtime helper the output needs, emitted once at the top of the file.
 *  `assign` and `concat` are the language's own (spreads); a `lowering` is a
 *  table a type library asked for, by the key it gave it. */
type Helper = "assign" | "concat" | { lowering: number; runtime: string }

type Mode = "declare" | "assign"

class Lowerer {
    private readonly names: Names
    private readonly diagnostics: LowerDiagnostic[] = []
    private readonly helpers = new Map<Helper, string>()
    /** The binding each declaration node creates. */
    private readonly bindingByDeclaration = new Map<object, Binding>()
    /** tilua names that are Luau keywords, and what they are called instead. */
    private readonly renamed = new Map<string, string>()
    /** Bindings read through something else: an export through `exports.x`,
     *  an import through its module's table. */
    private readonly rewrites = new Map<BindingId, () => L.Expression>()
    private readonly exportsName: string
    /** Globals generated code calls, renamed where the source shadows them. */
    private readonly builtins = new Map<string, string>()
    /** Whether the output has to be plain Lua 5.1 rather than Luau. */
    private readonly lua51: boolean
    /** The source line each emitted statement came from. */
    readonly origins = new WeakMap<L.Statement, number>()

    constructor(
        private readonly source: T.Program,
        private readonly scopes: ScopeAnalysis,
        private readonly options: LowerOptions,
    ) {
        this.lua51 = options.target === "lua51"
        this.names = options.names ? options.names.fork() : Names.from(source)
        this.exportsName = this.names.fresh("exports")
        for (const binding of scopes.bindings.values()) {
            if (binding.declarationNode) this.bindingByDeclaration.set(binding.declarationNode, binding)
        }
    }

    run(): LowerResult {
        const body = this.options.module
            ? this.module(this.options.module)
            : this.topLevel(this.source.body.statements)
        const helpers = this.helperDefinitions()
        // Captured before any of the file's code runs — before its own `table`.
        const captured = [...this.builtins].map(([global, local]) => luau.local([local], [luau.identifier(global)]))
        // A file compiled on its own is the chunk: its `...` is what it was
        // started with. A bundle sets this up once, for every module.
        const scriptArgs = this.usesScriptArgs && !this.options.module
            ? [luau.local(["scriptArgs"], [luau.table([{ type: "TableFieldPositional", value: vararg() }])])]
            : []
        return {
            statements: [...scriptArgs, ...captured, ...helpers, ...this.classRuntimeStatements(), ...body],
            exportsName: this.exportsName,
            module: this.info,
            diagnostics: this.diagnostics,
            origins: this.origins,
            usesScriptArgs: this.usesScriptArgs,
        }
    }

    /** Whether the file reads `scriptArgs`, the language's own global. */
    private usesScriptArgs = false

    private report(node: T.BaseNode, message: string): void {
        this.diagnostics.push({ message, line: node.line.start, column: node.column.start })
    }

    // --------------------------------------------------------
    // Names
    // --------------------------------------------------------

    /** A tilua name as Luau can write it: `local` is a keyword there. */
    private name(name: string): string {
        if (!luau.LUAU_KEYWORDS.has(name)) return name
        let renamed = this.renamed.get(name)
        if (!renamed) {
            renamed = this.names.fresh(`${name}_`)
            this.renamed.set(name, renamed)
        }
        return renamed
    }

    private bindingIdOf(node: object): BindingId | undefined {
        return this.scopes.bindingOf.get(node as T.Identifier) ?? this.bindingByDeclaration.get(node)?.id
    }

    /** How Luau refers to a name: its own local, or what it was rewritten to. */
    private reference(node: T.Identifier | T.IdentifierPattern): L.Expression {
        const id = this.bindingIdOf(node)
        const rewrite = id === undefined ? undefined : this.rewrites.get(id)
        return rewrite ? rewrite() : luau.identifier(this.name(node.name))
    }

    /** A global the generated code calls — `pairs`, `table`, ... — under a name
     *  the source cannot have shadowed. */
    private builtin(global: string): L.Identifier {
        let local = this.builtins.get(global)
        if (!local) {
            const shadowed = [...this.scopes.bindings.values()].some(b => b.name === global && b.kind !== "global")
            if (!shadowed) return luau.identifier(global)
            local = this.names.fresh(`tilua_${global}`)
            this.builtins.set(global, local)
        }
        return luau.identifier(local)
    }

    private helper(kind: "assign" | "concat"): L.Identifier {
        let name = this.helpers.get(kind)
        if (!name) {
            name = this.names.fresh(`tilua_${kind}`)
            this.helpers.set(kind, name)
        }
        return luau.identifier(name)
    }

    /** The local a library's runtime table gets in this file, emitting it the
     *  first time something asks. Keyed by library and by the key the library
     *  itself chose, so two libraries' tables never collide. */
    private loweringRuntime(index: number, runtime: string): string {
        const key = `${index}:${runtime}`
        let name = this.loweringNames.get(key)
        if (!name) {
            name = this.names.fresh(`tilua_${runtime.replace(/[^A-Za-z0-9_]/g, "_")}`)
            this.loweringNames.set(key, name)
            this.loweringUsed.push({ index, runtime, name })
        }
        return name
    }

    private readonly loweringNames = new Map<string, string>()
    private readonly loweringUsed: { index: number; runtime: string; name: string }[] = []

    /** What a name was declared as: the value of `const f = ...`, or the whole
     *  `function f() { ... }`. Built once, on the first call a library asks
     *  about — most files have none. */
    private declarationOf(argument: T.Expression): T.BaseNode | undefined {
        if (argument.type !== "Identifier") return undefined
        if (!this.declarations) {
            this.declarations = new Map()
            for (const node of allNodes(this.source.body)) {
                const statement = node as T.Statement
                if (statement.type === "VariableDeclaration") {
                    const target = statement.name
                    if (target.type !== "IdentifierPattern" || !statement.init) continue
                    const binding = this.bindingByDeclaration.get(target)
                    if (binding) this.declarations.set(binding.id, statement.init)
                } else if (statement.type === "FunctionDeclaration") {
                    const binding = this.bindingByDeclaration.get(statement.name)
                    if (binding) this.declarations!.set(binding.id, statement)
                }
            }
        }
        const id = this.scopes.bindingOf.get(argument)
        return id === undefined ? undefined : this.declarations.get(id)
    }

    private declarations?: Map<BindingId, T.BaseNode>

    /** The source `node` was written as, read straight out of the file. */
    private writtenSource(node: T.BaseNode): string {
        const source = this.options.source
        if (source === undefined) return ""
        const lines = source.split(/\r?\n/)
        if (node.line.start === node.line.end) {
            return (lines[node.line.start - 1] ?? "").slice(node.column.start - 1, node.column.end - 1)
        }
        const first = (lines[node.line.start - 1] ?? "").slice(node.column.start - 1)
        const middle = lines.slice(node.line.start, node.line.end - 1)
        const last = (lines[node.line.end - 1] ?? "").slice(0, node.column.end - 1)
        // Re-indented to the opening line, so a body printed into a log reads
        // as it does in the file rather than drifting right.
        const indent = /^\s*/.exec(lines[node.line.start - 1] ?? "")![0]
        const trim = (line: string): string => (line.startsWith(indent) ? line.slice(indent.length) : line)
        return [first, ...middle.map(trim), trim(last)].join("\n")
    }

    /** Where `node` was written, as a library is told it. */
    private callSite(node: T.BaseNode): CallSite {
        return { file: this.options.file, line: node.line.start, column: node.column.start }
    }

    /** What the compiler knows about each argument and the runtime cannot:
     *  its type, and the code it — or what it names — was written as. Built
     *  only if a library reads it. */
    private argumentInfo(args: readonly T.Expression[]): ArgumentInfo[] {
        return args.map(argument => {
            const declaration = this.declarationOf(argument)
            const type = this.options.types?.typeOf.get(argument)
            return {
                type,
                typeText: type ? formatType(type) : undefined,
                source: this.writtenSource(argument),
                declaration: declaration ? this.writtenSource(declaration) : undefined,
                spread: argument.type === "SpreadElement",
            }
        })
    }

    /** The name a global is read by at `node`, or `undefined` when `node` is
     *  not a global — a local of the same name is the author's. */
    private globalName(node: T.Expression): string | undefined {
        // `coroutine.resume`: a member of a global table is named by its path.
        if (node.type === "MemberExpression" && !node.optional) {
            const base = this.globalName(node.object)
            return base === undefined ? undefined : `${base}.${node.property.name}`
        }
        if (node.type !== "Identifier") return undefined
        const id = this.scopes.bindingOf.get(node)
        if (id === undefined) return node.name
        return this.scopes.bindings.get(id)?.kind === "global" ? node.name : undefined
    }

    /** The language's own lowering, then each library's, in load order. A
     *  runtime is named by its lowering's place here (`loweringRuntime`). */
    private get lowerings(): readonly LoadedLowering[] {
        return (this.allLowerings ??= [languageLowering, ...(this.options.lowerings ?? [])])
    }

    private allLowerings: readonly LoadedLowering[] | undefined

    /** What `receiver:method(...)` becomes, when Luau alone would not run it.
     *
     *  A method the receiver's metatable gave it — the analyzer says so, and
     *  whose metatable it was (`methodSources`) — is asked of whoever declared
     *  that metatable, and only them: the language lowers its own
     *  (`names:filter(f)` becomes a call into its runtime), a library its own,
     *  and one the program declared is taken at its word. Any other method is
     *  a member of the receiver's own, which a library may still claim
     *  (`console:log`), the last library loaded first. No answer leaves an
     *  ordinary Luau method call: `text:upper()` reaches Lua's own. */
    private loweredMethodCall(node: T.MethodCallExpression): { callee: string; prepend: L.Expression[]; passReceiver: boolean } | undefined {
        const lowerings = this.lowerings
        const source = this.options.types?.methodSources.get(node)
        const asked = source?.origin === "language" ? [0]
            : source?.origin === "library" ? lowerings.flatMap((l, i) => (l.library === source.library ? [i] : []))
            : source?.origin === "program" ? []
            : lowerings.map((_, i) => i).slice(1).reverse()
        if (!asked.some(i => lowerings[i].plugin.methodCall)) return undefined
        const receiver = this.options.types?.typeOf.get(node.object)
        const receiverGlobal = this.globalName(node.object)
        const info = this.lazyArguments(node.arguments)
        for (const i of asked) {
            const plugin = lowerings[i].plugin
            if (!plugin.methodCall) continue
            const answer = plugin.methodCall({
                method: node.method.name,
                receiver,
                receiverGlobal,
                argumentCount: node.arguments.length,
                at: this.callSite(node.method),
                get arguments() { return info() },
                use: runtime => this.loweringRuntime(i, runtime),
            })
            if (answer) {
                return {
                    callee: answer.callee,
                    prepend: this.prepended(answer.prepend, i, node),
                    passReceiver: answer.passReceiver !== false,
                }
            }
        }
        return undefined
    }

    /** What a library says a call to a global — `print(x)` — is. */
    private loweredGlobalCall(node: T.CallExpression): { callee: string; prepend: L.Expression[] } | undefined {
        const lowerings = this.lowerings
        if (!lowerings?.some(l => l.plugin.globalCall)) return undefined
        const name = this.globalName(node.callee)
        if (name === undefined) return undefined
        const info = this.lazyArguments(node.arguments)
        for (let i = lowerings.length - 1; i >= 0; i--) {
            const plugin = lowerings[i].plugin
            if (!plugin.globalCall) continue
            const answer = plugin.globalCall({
                name,
                at: this.callSite(node.callee),
                get arguments() { return info() },
                use: runtime => this.loweringRuntime(i, runtime),
            })
            if (answer) return { callee: answer.callee, prepend: this.prepended(answer.prepend, i, node) }
        }
        return undefined
    }

    /** What a library says a global read as a value — `local p = print` — is. */
    private loweredGlobalValue(node: T.Identifier | T.MemberExpression): L.Expression | undefined {
        const lowerings = this.lowerings
        if (!lowerings?.some(l => l.plugin.globalValue)) return undefined
        const name = this.globalName(node)
        if (name === undefined) return undefined
        for (let i = lowerings.length - 1; i >= 0; i--) {
            const answer = lowerings[i].plugin.globalValue?.({
                name,
                at: this.callSite(node),
                use: runtime => this.loweringRuntime(i, runtime),
            })
            if (answer !== undefined) return this.libraryExpression(answer, i, node)
        }
        return undefined
    }

    private lazyArguments(args: readonly T.Expression[]): () => ArgumentInfo[] {
        let info: ArgumentInfo[] | undefined
        return () => (info ??= this.argumentInfo(args))
    }

    private prepended(sources: readonly string[] | undefined, index: number, node: T.BaseNode): L.Expression[] {
        return (sources ?? []).flatMap(source => {
            const expression = this.libraryExpression(source, index, node)
            return expression ? [expression] : []
        })
    }

    /** Luau a library wrote as an expression. One that does not parse is the
     *  library's mistake, reported at the call it was written for. */
    private libraryExpression(source: string, index: number, node: T.BaseNode): L.Expression | undefined {
        try {
            return parseExpressionFromSource(source)
        } catch (error) {
            this.report(node, `'${this.lowerings[index].from}' lowered this to Luau that does not parse: `
                + `${JSON.stringify(source)} (${(error as Error).message})`)
            return undefined
        }
    }

    private helperDefinitions(): L.Statement[] {
        const out: L.Statement[] = []
        const assign = this.helpers.get("assign")
        if (assign) {
            // assign(target, ...sources): copy each source's keys into target, in order.
            out.push(luau.localFunction(assign, luau.functionBody(["target"], [
                luau.numericFor("i", luau.number(1), selectCount(this.builtin("select")), [
                    luau.local(["source"], [luau.call(this.builtin("select"), [luau.identifier("i"), vararg()])]),
                    luau.ifThen(luau.binary("~=", luau.identifier("source"), luau.nil()), [
                        luau.genericFor(["key", "value"], [luau.call(this.builtin("pairs"), [luau.identifier("source")])], [
                            luau.assign([luau.index(luau.identifier("target"), luau.identifier("key"))], [luau.identifier("value")]),
                        ]),
                    ]),
                ]),
                luau.returns([luau.identifier("target")]),
            ], true)))
        }
        for (const { index, runtime, name } of this.loweringUsed) {
            const { plugin, from } = this.lowerings[index]
            const source = plugin.runtime?.[runtime]
            if (source === undefined) {
                this.diagnostics.push({
                    message: `'${from}' asked for a runtime it does not have: '${runtime}'`,
                    line: 1, column: 1,
                })
                continue
            }
            // The map lives on the bundle's own table, so the expression that
            // reaches it comes from the bundler. Compiled as a single file
            // there is no bundle and no map: positions stay Luau's own.
            const lines = this.options.module?.lines ?? "nil"
            const fail = this.options.module?.fail ?? "nil"
            out.push(...parseLuau(source
                .replace(/__NAME__/g, name)
                .replace(/__LINES__/g, lines)
                .replace(/__FAIL__/g, fail)).body.statements)
        }
        const concat = this.helpers.get("concat")
        if (concat) {
            // concat(...parts): one array holding every part's elements, in order.
            out.push(luau.localFunction(concat, luau.functionBody([], [
                luau.local(["result"], [luau.table([])]),
                luau.numericFor("i", luau.number(1), selectCount(this.builtin("select")), [
                    luau.local(["part"], [luau.call(this.builtin("select"), [luau.identifier("i"), vararg()])]),
                    luau.callStatement(luau.call(luau.member(this.builtin("table"), "move"), [
                        luau.identifier("part"), luau.number(1), luau.unary("#", luau.identifier("part")),
                        luau.binary("+", luau.unary("#", luau.identifier("result")), luau.number(1)),
                        luau.identifier("result"),
                    ])),
                ]),
                luau.returns([luau.identifier("result")]),
            ], true)))
        }
        return out
    }

    // --------------------------------------------------------
    // Modules
    // --------------------------------------------------------

    private readonly info: ModuleInfo = { names: [], links: [], stars: [], exports: false }

    /** The module body, in the order an ES module runs:
     *
     *    local a, b, util          -- every top-level name, declared first
     *    function exports.f() ...  -- every top-level function, hoisted
     *    util = require("util")    -- the imports
     *    ...                       -- the rest, in source order */
    private module(context: ModuleContext): L.Statement[] {
        const statements = this.source.body.statements
        const exportsTable = (): L.Identifier => luau.identifier(this.exportsName)
        const { names, links, stars } = this.info
        const locals: string[] = []
        const requires: L.Statement[] = []
        /** Required modules, one local each however many statements import them. */
        const moduleLocals = new Map<string, string>()
        /** Where each imported binding comes from, for re-exporting it live. */
        const importedFrom = new Map<BindingId, { module: string; imported?: string }>()

        const resolve = (source: T.StringLiteral): string | undefined => {
            const key = context.resolve(source.value)
            if (key === undefined) this.report(source, `Cannot find module '${source.value}'`)
            return key
        }
        /** A local holding the module's exports, required where imports run. */
        const moduleLocal = (key: string): string => {
            let local = moduleLocals.get(key)
            if (!local) {
                local = this.names.fresh(moduleName(key))
                moduleLocals.set(key, local)
                locals.push(local)
                requires.push(luau.assign([luau.identifier(local)], [luau.call(context.require, [luau.string(key)])]))
            }
            return local
        }
        /** Loaded for its place in the order only: its exports are linked, not read here. */
        const load = (key: string): void => {
            if (!moduleLocals.has(key)) requires.push(luau.callStatement(luau.call(context.require, [luau.string(key)])))
        }

        const exportBinding = (node: object | undefined, exported: string): void => {
            const binding = node && this.bindingByDeclaration.get(node)
            if (!binding) return
            const existing = this.rewrites.get(binding.id)
            if (existing) {
                // Exported again under another name: the same value, read live.
                const first = memberChain(existing())
                links.push({ name: exported, module: context.name, imported: first?.[first.length - 1] })
                return
            }
            names.push(exported)
            this.rewrites.set(binding.id, () => luau.member(exportsTable(), exported))
        }

        // Imports first: an export may name an imported binding.
        for (const statement of statements) {
            // `import type` exists for the type checker alone: no module is
            // required for it, whatever it names.
            if (statement.type !== "ImportStatement" || statement.isTypeOnly) continue
            const specifiers = [
                ...(statement.defaultImport ? [{ local: statement.defaultImport, imported: "default" as string | undefined }] : []),
                ...(statement.namespaceImport ? [{ local: statement.namespaceImport, imported: undefined }] : []),
                ...statement.specifiers.map(s => ({ local: s.local, imported: s.imported.name as string | undefined })),
            ]
            // A binding read nowhere — say, a type — needs no module.
            const used = specifiers.filter(s => (this.bindingByDeclaration.get(s.local)?.references.length ?? 0) > 0)
            if (!used.length) continue
            const key = resolve(statement.source)
            if (key === undefined) continue
            const local = moduleLocal(key)
            for (const s of used) {
                const binding = this.bindingByDeclaration.get(s.local)!
                importedFrom.set(binding.id, { module: key, imported: s.imported })
                const imported = s.imported
                this.rewrites.set(binding.id, imported === undefined
                    ? () => luau.identifier(local)
                    : () => luau.member(luau.identifier(local), imported))
            }
        }

        // Then what the module exports.
        for (const statement of statements) {
            switch (statement.type) {
                case "ExportStatement": {
                    const declaration = statement.declaration
                    if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
                        exportBinding(declaration.name, declaration.name.name)
                    } else for (const pattern of identifierPatterns(declaration.name)) exportBinding(pattern, pattern.name)
                    break
                }
                case "ExportDefaultStatement":
                    names.push("default")
                    break
                case "ExportNamedStatement": {
                    if (statement.source) {
                        const key = resolve(statement.source)
                        if (key === undefined) break
                        load(key)
                        for (const s of statement.specifiers) links.push({ name: s.exported.name, module: key, imported: s.local.name })
                        break
                    }
                    for (const s of statement.specifiers) {
                        const declaration = topLevelDeclaration(statements, s.local.name)
                        const binding = declaration && this.bindingByDeclaration.get(declaration.node)
                        const from = binding && importedFrom.get(binding.id)
                        if (from) links.push({ name: s.exported.name, ...from })
                        else if (declaration?.type === "Declaration") exportBinding(declaration.node, s.exported.name)
                        // Otherwise it names a type: nothing exists at runtime.
                    }
                    break
                }
                case "ExportAllStatement": {
                    const key = resolve(statement.source)
                    if (key === undefined) break
                    load(key)
                    stars.push(key)
                    break
                }
            }
        }
        this.info.exports = names.length > 0 || links.length > 0 || stars.length > 0

        // Every other top-level name is a local of the module function,
        // declared up front so hoisted functions can see it.
        for (const statement of statements) {
            const declaration = statement.type === "ExportStatement" ? statement.declaration : statement
            if (declaration.type === "VariableDeclaration") {
                for (const pattern of identifierPatterns(declaration.name)) {
                    if (!this.isRewritten(pattern)) locals.push(this.name(pattern.name))
                }
            } else if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
                !this.isRewritten(declaration.name)) {
                locals.push(this.name(declaration.name.name))
            }
        }

        const hoisted: L.Statement[] = []
        const body: L.Statement[] = []
        for (const statement of statements) {
            const declaration = statement.type === "ExportStatement" ? statement.declaration : statement
            if (declaration.type === "FunctionDeclaration") {
                // `function exports.f()` / `function f()`: assigns the export, or
                // the local declared above, and keeps attributes such as `@native`.
                hoisted.push(this.from(this.functionStatement(this.reference(declaration.name), declaration,
                    this.functionBody(declaration.func), false), declaration))
                continue
            }
            if (declaration.type === "ClassDeclaration") {
                // The class table is built where it is written — its
                // initializers and its base class have to have run — but the
                // name is already declared, so anything above it can reach it.
                body.push(...this.classDeclaration(declaration, "assign"))
                continue
            }
            switch (declaration.type) {
                case "VariableDeclaration":
                    body.push(...this.variableDeclaration(declaration, "assign"))
                    break
                case "ExportDefaultStatement": {
                    // `export default class Name ... end` builds the class
                    // under its name, then exports that.
                    const exported = declaration.declaration
                    if (exported.type === "ClassDeclaration") {
                        body.push(...this.classDeclaration(exported, "assign"))
                        body.push(luau.assign([luau.member(exportsTable(), "default")], [this.reference(exported.name)]))
                    } else {
                        body.push(luau.assign([luau.member(exportsTable(), "default")], [this.expression(exported)]))
                    }
                    break
                }
                case "ReturnStatement":
                    // An early `return` stops the module; a value has nowhere to go.
                    if (declaration.argument) this.report(declaration, "A module cannot return a value; export it instead")
                    body.push(luau.returns([]))
                    break
                case "ImportStatement":
                case "ExportNamedStatement":
                case "ExportAllStatement":
                    break
                default:
                    body.push(...this.statement(declaration))
            }
        }

        const declarations: L.Statement[] = []
        for (let i = 0; i < locals.length; i += 100) declarations.push(luau.local(locals.slice(i, i + 100), []))
        return [...declarations, ...hoisted, ...requires, ...body]
    }

    private isRewritten(node: object): boolean {
        const binding = this.bindingByDeclaration.get(node)
        return binding !== undefined && this.rewrites.has(binding.id)
    }

    // --------------------------------------------------------
    // Statements
    // --------------------------------------------------------

    private block(block: T.Block, prelude: L.Statement[] = []): L.Block {
        return luau.block([...prelude, ...this.blockStatements(block.statements)])
    }

    // --------------------------------------------------------
    // Hoisting
    // --------------------------------------------------------
    //
    // A function declaration is visible to its whole block. Luau's
    // `local function f` is not, so a function something above it refers to is
    // declared as a local at the top of the block and assigned where it is
    // written: another function's body can call it once the block has run
    // that far. (Calling it straight away, above its declaration, is an error
    // scope analysis reports.) A bundle's module and a file's top level hoist
    // the whole function instead.

    /** Declarations in `statements` that something before them reads: a
     *  function called above it, or a value a closure in its own initializer
     *  reads (`local t = { f = function() return t end }`). Lua's `local`
     *  starts after its statement, so those names are declared at the top of
     *  the block and assigned where they are written. */
    private referencedAhead(statements: readonly T.Statement[]): {
        functions: Set<T.FunctionDeclaration>
        classes: Set<T.ClassDeclaration>
        variables: Set<T.VariableDeclaration>
        names: string[]
    } {
        const functions = new Set<T.FunctionDeclaration>()
        const classes = new Set<T.ClassDeclaration>()
        const variables = new Set<T.VariableDeclaration>()
        const names: string[] = []
        const before = (node: T.BaseNode, line: number, column: number): boolean =>
            line < node.line.start || (line === node.line.start && column < node.column.start)
        for (const statement of statements) {
            if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
                const binding = this.bindingByDeclaration.get(statement.name)
                if (binding?.references.some(r => before(statement.name, r.line.start, r.column.start))) {
                    if (statement.type === "ClassDeclaration") classes.add(statement)
                    else functions.add(statement)
                    names.push(this.name(statement.name.name))
                }
                continue
            }
            if (statement.type !== "VariableDeclaration") continue
            const patterns = identifierPatterns(statement.name)
            // A read from inside the statement's own value counts: it runs
            // later, when the name is there.
            const end = { line: { start: statement.line.end }, column: { start: statement.column.end } } as T.BaseNode
            const needed = patterns.some(pattern => {
                const binding = this.bindingByDeclaration.get(pattern)
                return binding?.references.some(r => before(end, r.line.start, r.column.start))
            })
            if (!needed) continue
            variables.add(statement)
            for (const pattern of patterns) names.push(this.name(pattern.name))
        }
        return { functions, classes, variables, names }
    }

    private blockStatements(statements: readonly T.Statement[]): L.Statement[] {
        const ahead = this.referencedAhead(statements)
        if (!ahead.names.length) return statements.flatMap(s => this.statement(s))
        return [
            luau.local(ahead.names, []),
            ...statements.flatMap(s => {
                if (s.type === "FunctionDeclaration" && ahead.functions.has(s)) {
                    return [this.functionStatement(this.reference(s.name), s, this.functionBody(s.func), false)]
                }
                if (s.type === "VariableDeclaration" && ahead.variables.has(s)) {
                    return this.variableDeclaration(s, "assign")
                }
                if (s.type === "ClassDeclaration" && ahead.classes.has(s)) {
                    return this.classDeclaration(s, "assign")
                }
                return this.statement(s)
            }),
        ]
    }

    /** A file's statements outside a bundle. A function used above its
     *  declaration is hoisted whole, as in a module: every top-level name is
     *  declared first, then the functions are defined, then the rest runs. */
    private topLevel(statements: readonly T.Statement[]): L.Statement[] {
        if (!this.referencedAhead(statements).names.length) return statements.flatMap(s => this.statement(s))
        const locals: string[] = []
        const hoisted: L.Statement[] = []
        const body: L.Statement[] = []
        for (const statement of statements) {
            if (statement.type === "VariableDeclaration") {
                for (const pattern of identifierPatterns(statement.name)) locals.push(this.name(pattern.name))
                body.push(...this.variableDeclaration(statement, "assign"))
            } else if (statement.type === "FunctionDeclaration") {
                locals.push(this.name(statement.name.name))
                hoisted.push(this.from(this.functionStatement(this.reference(statement.name), statement,
                    this.functionBody(statement.func), false), statement))
            } else if (statement.type === "ClassDeclaration") {
                // The name is declared up front; the table itself is built
                // where the class is written, once its base class exists.
                locals.push(this.name(statement.name.name))
                body.push(...this.classDeclaration(statement, "assign"))
            } else {
                body.push(...this.statement(statement))
            }
        }
        const declarations: L.Statement[] = []
        for (let i = 0; i < locals.length; i += 100) declarations.push(luau.local(locals.slice(i, i + 100), []))
        return [...declarations, ...hoisted, ...body]
    }

    /** Where each emitted statement came from. A bundle is one Luau file, so
     *  a line in it says nothing about which of the project's files wrote it;
     *  this is what lets a traceback be read back into the source. Statements
     *  are the unit because lines are: an expression shares its statement's.
     *
     *  Only statements built without a span of their own are stamped — the few
     *  that carry one already kept a more exact position. */
    private statement(node: T.Statement): L.Statement[] {
        const emitted = this.statementOf(node)
        for (const s of emitted) {
            if (!s.line.start) {
                s.line = { ...node.line }
                s.column = { ...node.column }
            }
            if (!this.origins.has(s)) this.origins.set(s, node.line.start)
        }
        return emitted
    }

    /** Stamps a statement built outside `statement` — a hoisted function, an
     *  assignment the module wrapper makes — with where it was written. */
    private from<S extends L.Statement>(statement: S, node: T.BaseNode): S {
        if (!statement.line.start) {
            statement.line = { ...node.line }
            statement.column = { ...node.column }
        }
        if (!this.origins.has(statement)) this.origins.set(statement, node.line.start)
        return statement
    }

    private statementOf(node: T.Statement): L.Statement[] {
        switch (node.type) {
            // Types, and what exists only for them.
            case "TypeAliasStatement":
            case "ExportTypeAliasStatement":
            case "DeclareStatement":
            case "DeclareClassStatement":
            case "DeclareMetatableStatement":
            case "ErrorStatement":
                return []

            case "VariableDeclaration":
                return this.variableDeclaration(node, "declare")

            case "FunctionDeclaration":
                return [{ ...luau.localFunction(this.name(node.name.name), this.functionBody(node.func)), attributes: node.attributes }]

            case "FunctionDeclarationStatement":
                return [this.functionDeclarationStatement(node)]

            case "ClassDeclaration":
                return this.classDeclaration(node, "declare")

            case "AssignmentStatement":
                return this.assignment(node)

            case "CompoundAssignmentStatement":
                if (this.lua51) return this.compoundAssignment51(node)
                return [{
                    type: "CompoundAssignmentStatement",
                    operator: node.operator,
                    target: this.expression(node.target),
                    value: this.expression(node.value),
                    ...spanOf(node),
                }]

            case "CallStatement": {
                const chain = optionalChain(node.expression)
                if (chain) return [this.optionalCallStatement(chain)]
                const expression = this.callValues(node.expression)
                if (expression.type !== "CallExpression" && expression.type !== "MethodCallExpression") {
                    this.report(node, "A statement must be a call")
                    return []
                }
                return [luau.callStatement(expression)]
            }

            // `value` on a line of its own: written to ask the editor about a
            // name, and worth nothing once the file is compiled. It cannot be
            // kept — Lua has no expression statement — and it cannot run
            // anything, since a call is a `CallStatement` instead, so dropping
            // it changes nothing but the noise.
            case "ExpressionStatement":
                return []

            case "DoStatement":
                return [{ type: "DoStatement", body: this.block(node.body), ...spanOf(node) }]

            case "WhileStatement":
                return [{ type: "WhileStatement", condition: this.expression(node.condition), body: this.loopBody51(this.block(node.body)), ...spanOf(node) }]

            case "RepeatStatement": {
                const body = this.block(node.body)
                const condition = this.expression(node.condition)
                // A `repeat`'s condition can read the locals its body declares.
                // Standing in for `continue` puts the body inside a second
                // `repeat`, which would shut those locals away from the
                // condition — and it would read a nil global instead, quietly.
                // Say so rather than compile something that does not mean what
                // it says.
                if (this.lua51 && hasOwnJump(body.statements, "ContinueStatement")) {
                    const hidden = declaredNames(body.statements).filter(name => mentions(condition, name))
                    if (hidden.length) {
                        this.report(node, `'continue' in a 'repeat' whose 'until' reads ${hidden.map(n => `'${n}'`).join(", ")} ` +
                            "cannot be compiled for Lua 5.1, which has no 'continue' to lower it to. " +
                            "Move what the condition reads out of the loop body, or use a 'while' loop.")
                    }
                }
                return [{ type: "RepeatStatement", body: this.loopBody51(body), condition, ...spanOf(node) }]
            }

            case "IfStatement":
                return [{
                    type: "IfStatement",
                    clauses: node.clauses.map(c => ({
                        type: "IfClause", condition: this.expression(c.condition), body: this.block(c.body), ...spanOf(c),
                    })),
                    alternate: node.alternate && this.block(node.alternate),
                    ...spanOf(node),
                }]

            case "NumericForStatement":
                return [{
                    type: "NumericForStatement",
                    variable: { type: "TypedIdentifier", name: this.name(node.variable.name), ...spanOf(node.variable) },
                    start: this.expression(node.start),
                    end: this.expression(node.end),
                    step: node.step && this.expression(node.step),
                    body: this.loopBody51(this.block(node.body)),
                    ...spanOf(node),
                }]

            case "GenericForStatement": {
                // `for (const [a, b] in pairs(t))`: one value each time, which
                // a pattern takes apart at the top of the body.
                const prelude: L.Statement[] = []
                const variable = declared(node.variable)
                let item: string
                if (variable.type === "IdentifierPattern") {
                    item = this.name(variable.name)
                } else {
                    item = this.names.fresh("item")
                    prelude.push(...this.destructure(variable, luau.identifier(item), "declare"))
                }
                // How the source is walked is the type analysis's call — it
                // binds the item's type from the same choice, so the name and
                // its type cannot drift apart.
                const form = this.options.types?.loops.get(node) ?? { walks: "values" as const, viaIter: false }
                let source = this.expression(node.iterator)
                // An object that says how to walk itself hands over its
                // iterator, or its iteration, from `__iter`.
                if (form.viaIter) source = luau.methodCall(source, "__iter", [])
                const variables = form.walks === "values" ? [this.names.fresh("_"), item] : [item]
                // An iteration is `[step, state, first]`: the three Luau loops
                // with, taken out of the array they are.
                const iterators = form.walks === "iteration"
                    ? [luau.call(this.builtin("unpack"), [source, luau.number(1), luau.number(3)])]
                    : [source]
                return [luau.genericFor(variables, iterators,
                    this.loopBody51(this.block(node.body, prelude)).statements)]
            }

            case "ReturnStatement":
                // One value — several are an array, and that is a table.
                return [luau.returns(node.argument ? [this.keptToOne(this.expression(node.argument))] : [])]

            case "BreakStatement":
                return [{ type: "BreakStatement", ...spanOf(node) }]

            case "ContinueStatement":
                return [{ type: "ContinueStatement", ...spanOf(node) }]

            case "ImportStatement":
                // Types only: erased like every other type.
                if (node.isTypeOnly) return []
                this.report(node, this.options.module
                    ? "Imports and exports belong at the top level of a module"
                    : "Imports and exports need a bundle: build the project with @tilua/compiler")
                return []
            case "ExportStatement":
            case "ExportDefaultStatement":
            case "ExportNamedStatement":
            case "ExportAllStatement":
                this.report(node, this.options.module
                    ? "Imports and exports belong at the top level of a module"
                    : "Imports and exports need a bundle: build the project with @tilua/compiler")
                return []
        }
    }

    private functionDeclarationStatement(node: T.FunctionDeclarationStatement): L.FunctionDeclarationStatement {
        // `function util.helper()` where `util` is rewritten to `exports.util`:
        // the base becomes `exports`, and the rest of the path follows.
        const statement = this.functionStatement(this.reference(node.target.base), node, this.functionBody(node.func), node.isMethod, node.target.path.map(p => p.name))
        if (!node.target.method) return statement
        return { ...statement, target: { ...statement.target, method: luau.identifier(node.target.method.name) } }
    }

    /** `function a.b.c()`, for a target written as an expression. */
    // ============================================================
    // `class ... end`
    // ------------------------------------------------------------
    // The shape is Lua's own, and the memory model the language
    // promises: one table per class holding its methods and its
    // statics, and one table per instance whose metatable points at
    // it. An instance reaches its class directly — nothing is copied
    // per instance, and there is no prototype chain of its own.
    //
    //     local Dog = __class(Animal)
    //     function Dog.__init(this, name)
    //         Animal.__init(this, name)      -- super(name)
    //         this.breed = "corgi"           -- a field initializer
    //     end
    //     function Dog.new(...)
    //         local this = setmetatable({}, Dog)
    //         Dog.__init(this, ...)
    //         return this
    //     end
    //     function Dog.speak(this) ... end
    //
    // `Dog.new(x)` builds one, `dog:speak()` passes the instance
    // as `this`, and `super.speak()` is `Animal.speak(this)` — the
    // base's own function, run on this instance.
    // ============================================================

    /** The locals the file's classes are built with, named once. */
    private classHelpers?: { build: string; accessors: string }

    private classRuntime(): { build: string; accessors: string } {
        return (this.classHelpers ??= {
            build: this.names.fresh("tilua_class"),
            accessors: this.names.fresh("tilua_accessors"),
        })
    }

    /** The helpers, as Luau — emitted only in a file that declares a class.
     *  `__getters`/`__setters` chain to the base's, so a derived class sees
     *  the accessors it inherits; `__index` only becomes a function for a
     *  class that has some, which leaves every other class on the plain
     *  `__index = class` fast path.
     *
     *  `ClassObject` and `ParentClass` are the links the memory model
     *  promises: an instance reads `ClassObject` through its metatable and
     *  lands on its own class, and a class reads `ParentClass` and lands on
     *  the one it extends. Both live on the class table, so an instance
     *  carries neither. */
    private classRuntimeStatements(): L.Statement[] {
        if (!this.classHelpers) return []
        const { build, accessors } = this.classHelpers
        // Luau finds a metamethod with `rawget` on the metatable — the class
        // table — never through its `__index`. So what a class inherits
        // through `__index` it does not inherit as an operator: the base's
        // are copied in when the class is made, and one the class writes
        // itself then replaces the copy.
        const metamethods = `{ ${CLASS_METAMETHODS.map(name => `"${name}"`).join(", ")} }`
        return parseLuau(`
local function ${build}(base)
    local class = { __getters = {}, __setters = {} }
    class.__index = class
    class.ClassObject = class
    class.ParentClass = base
    if base ~= nil then
        setmetatable(class, { __index = base })
        setmetatable(class.__getters, { __index = base.__getters })
        setmetatable(class.__setters, { __index = base.__setters })
        for _, key in ipairs(${metamethods}) do
            class[key] = base[key]
        end
    end
    return class
end
local function ${accessors}(class)
    if not class.__dynamic and next(class.__getters) == nil and next(class.__setters) == nil then
        return
    end
    class.__dynamic = true
    class.__index = function(this, key)
        local getter = class.__getters[key]
        if getter ~= nil then
            return getter(this)
        end
        return class[key]
    end
    class.__newindex = function(this, key, value)
        local setter = class.__setters[key]
        if setter ~= nil then
            setter(this, value)
            return
        end
        rawset(this, key, value)
    end
end
`).body.statements
    }

    /** The class being lowered, so `super` knows what to name. */
    private classContext?: T.ClassLike

    /** A class written where a value goes. Building it takes statements, and
     *  an expression has no room for them, so they go in a function that runs
     *  where the class is written and hands the class table back. */
    private classExpression(node: T.ClassExpression): L.Expression {
        const local = this.names.fresh(node.name ? this.name(node.name.name) : "class")
        const statements = this.classStatements(node, luau.identifier(local), local)
        return luau.call(luau.parenthesized(luau.functionExpression(
            luau.functionBody([], [...statements, luau.returns([luau.identifier(local)])]))), [])
    }

    private classDeclaration(node: T.ClassDeclaration, mode: Mode): L.Statement[] {
        const name = this.name(node.name.name)
        return mode === "declare"
            ? this.classStatements(node, luau.identifier(name), name)
            : this.classStatements(node, this.reference(node.name))
    }

    /** `declare` names the local the class table goes in; without it the
     *  table is assigned to `self`, which a module has already declared. */
    private classStatements(node: T.ClassLike, self: L.Expression, declare?: string): L.Statement[] {
        const { build, accessors } = this.classRuntime()
        const create = luau.call(luau.identifier(build), [node.superclass ? this.reference(node.superclass) : luau.nil()])
        const out: L.Statement[] = [declare !== undefined
            ? luau.local([declare], [create])
            : luau.assign([self], [create])]

        const previous = this.classContext
        this.classContext = node
        try {
            for (const member of node.members) {
                switch (member.type) {
                    case "ClassField":
                        // Only a static holds a value here; an instance field
                        // is assigned per instance, in `__init`.
                        if (member.isStatic) {
                            out.push(luau.assign([luau.member(self, member.name.name)],
                                [member.init ? this.expression(member.init) : luau.nil()]))
                        }
                        break
                    case "ClassMethod":
                        // An abstract method is a promise, not a function.
                        if (member.isAbstract) break
                        out.push(this.functionStatement(luau.member(self, member.name.name), member,
                            this.classFunctionBody(member.func), false))
                        break
                    case "ClassAccessor":
                        out.push(luau.assign(
                            [luau.index(luau.member(self, member.kind === "get" ? "__getters" : "__setters"),
                                luau.string(member.name.name))],
                            [luau.functionExpression(this.classFunctionBody(member.func))]))
                        break
                    case "ClassConstructor":
                        break
                }
            }
            out.push(this.classInit(node, self))
            // An abstract class is only ever built as part of one extending it,
            // through its `__init`; it has no `new` of its own.
            if (!node.isAbstract) out.push(this.classNew(node, self))
            out.push(luau.callStatement(luau.call(luau.identifier(accessors), [self])))
        } finally {
            this.classContext = previous
        }
        return out
    }

    /** `Class.__init(this, ...)` — what every instance of the class runs.
     *  Kept apart from `new` so `super(...)` can run the base's on the
     *  instance already being built rather than making a second one. */
    private classInit(node: T.ClassLike, self: L.Expression): L.Statement {
        const instance = this.thisName()
        const initializers = node.members
            .filter((m): m is T.ClassField => m.type === "ClassField" && !m.isStatic && m.init !== undefined)
            .map(field => luau.assign(
                [luau.member(luau.identifier(instance), field.name.name)], [this.expression(field.init!)]))

        const constructor = node.members.find((m): m is T.ClassConstructor => m.type === "ClassConstructor")
        if (!constructor) {
            // No constructor of its own: take what the base takes, pass it on.
            const body = luau.functionBody([instance], [
                ...(node.superclass
                    ? [luau.callStatement(luau.call(luau.member(this.reference(node.superclass), "__init"),
                        [luau.identifier(instance), vararg()]))]
                    : []),
                ...initializers,
            ], true)
            return this.functionStatement(luau.member(self, "__init"), node, body, false)
        }

        const body = this.classFunctionBody(constructor.func)
        // The fields go in after `super(...)`, which is what fills in
        // everything the base contributes, and before the constructor can use
        // them. With no base there is nothing to wait for.
        const statements = body.body.statements
        const afterSuper = node.superclass ? statements.findIndex(isSuperInit) + 1 : 0
        statements.splice(Math.max(afterSuper, 0), 0, ...initializers)
        return this.functionStatement(luau.member(self, "__init"), constructor, body, false)
    }

    /** `Class.new(...)`: the instance, its metatable, its constructor. */
    private classNew(node: T.ClassLike, self: L.Expression): L.Statement {
        const instance = this.thisName()
        const body = luau.functionBody([], [
            luau.local([instance], [luau.call(this.builtin("setmetatable"), [luau.table([]), self])]),
            luau.callStatement(luau.call(luau.member(self, "__init"), [luau.identifier(instance), vararg()])),
            luau.returns([luau.identifier(instance)]),
        ], true)
        return this.functionStatement(luau.member(self, "new"), node, body, false)
    }

    /** What `this` is called in emitted code. */
    private thisName(): string {
        return this.name("this")
    }

    /** A class method keeps its receiver as a written parameter: `:` supplies
     *  it at the call site, but the declaration spells it out so `super` and
     *  `new` can pass it by hand. */
    private classFunctionBody(func: T.FunctionBody): L.FunctionBody {
        return this.functionBody(func.isMethod ? { ...func, isMethod: false } : func)
    }

    /** `super(...)` / `super.m(...)` — the base class, by the name this file
     *  knows it under. */
    private superClassReference(node: T.BaseNode): L.Expression {
        const superclass = this.classContext?.superclass
        if (!superclass) {
            this.report(node, "'super' is only available inside a class that extends another")
            return luau.nil()
        }
        return this.reference(superclass)
    }

    private functionStatement(
        target: L.Expression,
        node: T.BaseNode & { attributes?: string[] },
        func: L.FunctionBody,
        isMethod: boolean,
        path: string[] = [],
    ): L.FunctionDeclarationStatement {
        const chain = memberChain(target)
        if (!chain) this.report(node, "This function name cannot be written in Luau")
        const [root, ...prefix] = chain ?? ["_"]
        return {
            type: "FunctionDeclarationStatement",
            target: {
                type: "FunctionName",
                base: luau.identifier(root),
                path: [...prefix, ...path].map(luau.identifier),
                ...spanOf(node),
            },
            isMethod,
            func,
            attributes: node.attributes,
            ...spanOf(node),
        }
    }

    /** `const a = x`, `const { a, b } = x`. In "assign" mode — a module's top
     *  level, where every name is declared up front — nothing is declared,
     *  only assigned. */
    private variableDeclaration(node: T.VariableDeclaration, mode: Mode): L.Statement[] {
        const target = declared(node.name)
        if (!node.init) {
            const names = identifierPatterns(target)
            if (mode === "declare") return [luau.local(names.map(p => this.name(p.name)), [])]
            // `export let x`: the export exists from here on, holding nil.
            const exported = names.filter(p => this.isRewritten(p))
            return exported.length ? [luau.assign(exported.map(p => this.reference(p)), exported.map(() => luau.nil()))] : []
        }
        const value = this.expression(node.init)
        if (target.type === "IdentifierPattern") {
            return mode === "declare"
                ? [luau.local([this.name(target.name)], [value])]
                : [luau.assign([this.reference(target)], [value])]
        }
        // `const { a, b } = value` reads straight from `value` when it is a plain
        // name; anything else is evaluated once, into a local.
        if (value.type === "Identifier") return this.destructure(target, value, mode)
        const temp = this.names.fresh("ref")
        return [luau.local([temp], [value]), ...this.destructure(target, luau.identifier(temp), mode)]
    }

    private assignment(node: T.AssignmentStatement): L.Statement[] {
        const target = node.target
        const value = this.expression(node.value)
        if (target.type !== "ObjectPattern" && target.type !== "ArrayPattern") {
            return [luau.assign([this.expression(target)], [value])]
        }
        if (value.type === "Identifier") {
            const statements = this.destructure(target, value, "assign")
            return statements.some(s => s.type === "LocalStatement") ? [luau.doBlock(statements)] : statements
        }
        // The value is read once, into a local, before any target takes its
        // part: `[a, b] = [b, a]` swaps.
        const temp = this.names.fresh("ref")
        return [luau.doBlock([luau.local([temp], [value]), ...this.destructure(target, luau.identifier(temp), "assign")])]
    }

    // --------------------------------------------------------
    // Destructuring
    // --------------------------------------------------------

    /** Bind (or assign) every name in `pattern` from `source`, which must be a
     *  plain name so that reading it repeatedly has no side effects.
     *
     *  The reads share one statement, in the pattern's order —
     *  `local a, b = source.a, source.b` — with a temporary standing in for a
     *  nested pattern. Defaults, nested patterns and rest follow it. */
    private destructure(pattern: T.ObjectPattern | T.ArrayPattern, source: L.Identifier, mode: Mode): L.Statement[] {
        /** Computed keys, evaluated before anything is read. */
        const keys: { name: string; value: L.Expression }[] = []
        const reads: { name: string; target: L.Expression; value: L.Expression; temp: boolean }[] = []
        const after: L.Statement[] = []

        const bind = (target: T.BindingTarget, value: L.Expression, fallback: T.Expression | undefined): void => {
            if (target.type === "MemberExpression" || target.type === "IndexExpression") {
                // Only an assignment's: `[t[i], t[j]] = [t[j], t[i]]`.
                const reference = this.expression(target)
                reads.push({ name: "", target: reference, value, temp: false })
                if (fallback) after.push(this.defaultValue(reference, fallback))
                return
            }
            if (target.type === "IdentifierPattern") {
                const name = this.name(target.name)
                const reference = mode === "declare" ? luau.identifier(name) : this.reference(target)
                reads.push({ name, target: reference, value, temp: false })
                if (fallback) after.push(this.defaultValue(reference, fallback))
                return
            }
            const name = this.names.fresh("ref")
            reads.push({ name, target: luau.identifier(name), value, temp: true })
            if (fallback) after.push(this.defaultValue(luau.identifier(name), fallback))
            after.push(...this.destructure(target, luau.identifier(name), mode))
        }

        if (pattern.type === "ObjectPattern") {
            const taken: L.Expression[] = []
            for (const property of pattern.properties) {
                let key: L.Expression
                if (!property.computed && (property.key.type === "Identifier" || property.key.type === "StringLiteral")) {
                    const name = property.key.type === "Identifier" ? property.key.name : property.key.value
                    key = luau.string(name)
                    bind(property.value, luau.member(source, name), property.default)
                } else {
                    // A computed key is evaluated once; rest needs it again.
                    const name = this.names.fresh("key")
                    keys.push({ name, value: this.expression(property.key as T.Expression) })
                    key = luau.identifier(name)
                    bind(property.value, luau.index(source, key), property.default)
                }
                taken.push(key)
            }
            if (pattern.rest) {
                // `...rest`: a new table of every key the pattern did not name.
                const rest = this.restTarget(pattern.rest, luau.table([]), mode, after)
                const key = this.names.fresh("key")
                const value = this.names.fresh("value")
                const kept = taken.reduce<L.Expression | undefined>((condition, k) => {
                    const differs = luau.binary("~=", luau.identifier(key), k)
                    return condition ? luau.binary("and", condition, differs) : differs
                }, undefined)
                const copy = luau.assign([luau.index(rest.target, luau.identifier(key))], [luau.identifier(value)])
                after.push(luau.genericFor([key, value], [luau.call(this.builtin("pairs"), [source])], kept ? [luau.ifThen(kept, [copy])] : [copy]))
                after.push(...rest.then)
            }
        } else {
            pattern.elements.forEach((element, i) => {
                if (element) bind(element.value, luau.index(source, luau.number(i + 1)), element.default)
            })
            if (pattern.rest) {
                // `...rest`: a new array of the elements after the named ones.
                const elements = luau.call(luau.member(this.builtin("table"), "move"), [
                    source, luau.number(pattern.elements.length + 1), luau.unary("#", source), luau.number(1), luau.table([]),
                ])
                const rest = this.restTarget(pattern.rest, elements, mode, after)
                after.push(...rest.then)
            }
        }

        const out: L.Statement[] = []
        if (keys.length) out.push(luau.local(keys.map(k => k.name), keys.map(k => k.value)))
        if (mode === "declare") {
            if (reads.length) out.push(luau.local(reads.map(r => r.name), reads.map(r => r.value)))
        } else {
            // Assigning: the temporaries are still new locals.
            const temps = reads.filter(r => r.temp)
            const targets = reads.filter(r => !r.temp)
            if (temps.length) out.push(luau.local(temps.map(r => r.name), temps.map(r => r.value)))
            if (targets.length) out.push(luau.assign(targets.map(r => r.target), targets.map(r => r.value)))
        }
        return [...out, ...after]
    }

    /** Where a rest element's new table goes: straight into its name, or into
     *  a temporary that a nested pattern then destructures (`then`). The
     *  statement creating it is pushed onto `after`. */
    private restTarget(
        target: T.BindingTarget,
        initial: L.Expression,
        mode: Mode,
        after: L.Statement[],
    ): { target: L.Expression; then: L.Statement[] } {
        if (target.type === "MemberExpression" || target.type === "IndexExpression") {
            const reference = this.expression(target)
            after.push(luau.assign([reference], [initial]))
            return { target: reference, then: [] }
        }
        if (target.type === "IdentifierPattern") {
            if (mode === "declare") {
                const name = this.name(target.name)
                after.push(luau.local([name], [initial]))
                return { target: luau.identifier(name), then: [] }
            }
            const reference = this.reference(target)
            after.push(luau.assign([reference], [initial]))
            return { target: reference, then: [] }
        }
        const name = this.names.fresh("rest")
        after.push(luau.local([name], [initial]))
        return { target: luau.identifier(name), then: this.destructure(target, luau.identifier(name), mode) }
    }

    /** `if target == nil then target = fallback end` */
    private defaultValue(target: L.Expression, fallback: T.Expression): L.Statement {
        return luau.ifThen(luau.binary("==", target, luau.nil()), [luau.assign([target], [this.expression(fallback)])])
    }

    // --------------------------------------------------------
    // Functions
    // --------------------------------------------------------

    private functionBody(func: T.FunctionBody): L.FunctionBody {
        // `function T:m()` has an injected `self`; Luau's `:` supplies it.
        const params = func.isMethod ? func.params.slice(1) : func.params
        const prelude: L.Statement[] = []
        const names: string[] = []
        for (const p of params) {
            // `...rest: T[]` is Lua's own `{...}`: the function still takes
            // `...`, and the array of it is a local the body reads by name.
            if (p.rest) {
                prelude.push(luau.local([this.name(p.name)], [luau.table([{ type: "TableFieldPositional", value: vararg() }])]))
                continue
            }
            const name = p.pattern ? this.names.fresh("arg") : this.name(p.name)
            if (p.default) prelude.push(this.defaultValue(luau.identifier(name), p.default))
            if (p.pattern) prelude.push(...this.destructure(p.pattern, luau.identifier(name), "declare"))
            names.push(name)
        }
        return { ...luau.functionBody(names, [], func.hasVarargs), body: this.block(func.body, prelude) }
    }

    // --------------------------------------------------------
    // Expressions
    // --------------------------------------------------------

    private expression(node: T.Expression): L.Expression {
        // `super` is the base class table, and what is read through it is
        // run on this instance: `super(a)` is `Base.__init(this, a)` and
        // `super.m(a)` is `Base.m(this, a)`. Handled before the chain cases,
        // which would otherwise take `super` for an ordinary object.
        if (node.type === "CallExpression") {
            const callee = node.callee
            const through = callee.type === "SuperExpression" ? "__init"
                : callee.type === "MemberExpression" && callee.object.type === "SuperExpression" ? callee.property.name
                : undefined
            if (through !== undefined) {
                return luau.call(luau.member(this.superClassReference(node), through), [
                    luau.identifier(this.thisName()),
                    ...this.arguments(node.arguments),
                ])
            }
        }
        switch (node.type) {
            case "Identifier":
                if (node.name === "scriptArgs" && this.isLanguageGlobal(node)) {
                    this.usesScriptArgs = true
                    return luau.identifier("scriptArgs")
                }
                return this.loweredGlobalValue(node) ?? this.reference(node)
            case "NilLiteral": return luau.nil()
            case "BooleanLiteral": return luau.boolean(node.value)
            case "NumberLiteral": return luau.number(node.value, this.numberRaw(node))
            case "StringLiteral": return luau.string(node.value)
            // Only a recovering parse makes one, and a syntax error stops the build.
            case "ErrorExpression":
                this.report(node, "Syntax error")
                return luau.nil()
            case "InterpolatedStringExpression": return this.interpolatedString(node)

            case "FunctionExpression":
                return luau.functionExpression(this.functionBody(node.func))

            case "TableExpression": return this.tableExpression(node)
            case "ArrayExpression": return this.arrayExpression(node)

            case "BinaryExpression": {
                const left = this.expression(node.left)
                const right = this.expression(node.right)
                // Lua 5.1 has no `//`.
                if (this.lua51 && node.operator === "//") return this.floorDivide(left, right)
                return luau.binary(node.operator, left, right)
            }

            case "UnaryExpression":
                return luau.unary(node.operator, this.expression(node.argument))

            case "SuperExpression":
                return this.superClassReference(node)

            case "SpreadElement":
                // Only an argument list and an array literal accept one, and
                // both lower it themselves; the parser produces none elsewhere.
                this.report(node, "'...' can only spread into a call's arguments or an array")
                return luau.nil()

            case "ClassExpression":
                return this.classExpression(node)

            case "CallExpression":
            case "MethodCallExpression":
                return this.callValues(node)

            case "MemberExpression":
            case "IndexExpression": {
                const chain = optionalChain(node)
                if (chain) return this.optionalChainExpression(chain)
                // `string.find` read as a value is whatever the library says
                // `string.find` is — the same function its calls get.
                const global = node.type === "MemberExpression" ? this.loweredGlobalValue(node) : undefined
                if (global) return global
                return this.link(node, this.expression(linkObject(node)))
            }

            case "ParenthesizedExpression":
                return luau.parenthesized(this.expression(node.expression))

            // Types only: the value is the expression itself.
            case "TypeAssertionExpression":
            case "SatisfiesExpression":
            case "AsConstExpression":
                return this.expression(node.expression)

            case "IfElseExpression":
                if (this.lua51) return this.ifElse51(node)
                return {
                    type: "IfElseExpression",
                    clauses: node.clauses.map(c => ({ condition: this.expression(c.condition), body: this.expression(c.body) })),
                    alternate: this.expression(node.alternate),
                    ...spanOf(node),
                }
        }
    }

    /** A call. */
    private callValues(node: T.CallExpression | T.MethodCallExpression): L.Expression {
        const chain = optionalChain(node)
        if (chain) return this.optionalChainExpression(chain)
        // A name that is called is not read as a value: `print(x)` is
        // `globalCall`'s to answer, and asking `globalValue` about the
        // `print` in it would emit a runtime nothing then uses.
        const object = linkObject(node)
        if (node.type === "CallExpression" && object.type === "Identifier") {
            return this.link(node, this.reference(object))
        }
        return this.link(node, this.expression(object))
    }

    /** A call is one value in tilua, and Luau would hand on every value one
     *  returns in the last place of an argument list or a `return`: it is
     *  kept to one there, `f((g()))`. Every value is taken only where the
     *  program asks for them, as an array's last element: `[g()]`. */
    private keptToOne(value: L.Expression): L.Expression {
        return expandsToMany(value) ? luau.parenthesized(value) : value
    }

    /** Is this `scriptArgs` the language's own, not a name the file declared? */
    private isLanguageGlobal(node: T.Identifier): boolean {
        const id = this.bindingIdOf(node)
        return id === undefined || this.scopes.bindings.get(id)?.kind === "global"
    }

    /** A call's arguments. `f(a, ...xs)` is Lua's own last-value expansion,
     *  `f(a, table.unpack(xs))`; a spread anywhere else cannot be, since only
     *  the last value of a list expands, so the whole list is built as an
     *  array first and that is what expands. A call written last is one
     *  value — see `keptToOne`. */
    private arguments(written: readonly T.Expression[]): L.Expression[] {
        const { items: list, many } = packs(written)
        const spreads = list.filter(a => a.type === "SpreadElement")
        if (!spreads.length) {
            const lowered = list.map(a => this.expression(a))
            const last = list.length - 1
            return lowered.length && !many.has(list[last])
                ? [...lowered.slice(0, -1), this.keptToOne(lowered[last])]
                : lowered
        }
        const unpack = (value: L.Expression): L.Expression =>
            luau.call(luau.member(this.builtin("table"), "unpack"), [value])
        const last = list[list.length - 1]
        if (spreads.length === 1 && last.type === "SpreadElement") {
            return [...list.slice(0, -1).map(a => this.expression(a)), unpack(this.expression(last.argument))]
        }
        return [unpack(this.arrayExpression({
            type: "ArrayExpression", elements: [...list], ...spanOf(list[0]),
        } as T.ArrayExpression))]
    }

    /** One link of an access chain, read from `object`. */
    private link(node: Link, object: L.Expression): L.Expression {
        switch (node.type) {
            case "MemberExpression":
                return luau.member(object, node.property.name)
            case "IndexExpression":
                return luau.index(object, this.expression(node.index))
            case "CallExpression": {
                const lowered = this.loweredGlobalCall(node)
                const args = this.arguments(node.arguments)
                if (!lowered) return luau.call(object, args)
                return luau.call(calleePath(lowered.callee), [...lowered.prepend, ...args])
            }
            case "MethodCallExpression": {
                const lowered = this.loweredMethodCall(node)
                const args = this.arguments(node.arguments)
                if (lowered) {
                    return luau.call(calleePath(lowered.callee), [
                        ...lowered.prepend,
                        ...(lowered.passReceiver ? [object] : []),
                        ...args,
                    ])
                }
                if (!luau.isLuauName(node.method.name)) {
                    this.report(node.method, `'${node.method.name}' is a Luau keyword and cannot be called with ':'`)
                }
                return luau.methodCall(object, node.method.name, args)
            }
        }
    }

    // --------------------------------------------------------
    // Optional chains
    // --------------------------------------------------------
    //
    // `a?.b.c` is nil when `a` is, and then neither `.b` nor `.c` runs. Each
    // `?.` tests what the chain holds so far, once: the value is kept in a
    // local rather than read again.

    /** The links of a chain from `?.` onwards, split into segments that each
     *  start at a `?.` / `?:`. */
    private segments(chain: Chain): Link[][] {
        const out: Link[][] = []
        for (const link of chain.links) {
            if ((link as { optional?: boolean }).optional || !out.length) out.push([link])
            else out[out.length - 1].push(link)
        }
        return out
    }

    private applySegment(segment: Link[], object: L.Expression): L.Expression {
        return segment.reduce((value, link) => this.link(link, value), object)
    }

    /** `a?.b:m()` as a statement:
     *  `do local ref = a if ref ~= nil then ref.b:m() end end` */
    private optionalCallStatement(chain: Chain): L.Statement {
        const segments = this.segments(chain)
        const base = this.expression(chain.base)
        // A name is only read, so a single test can use it as it is.
        const ref = base.type === "Identifier" && segments.length === 1 ? base.name : this.names.fresh("ref")
        const at = luau.identifier(ref)

        const nest = (i: number): L.Statement[] => {
            const value = this.applySegment(segments[i], at)
            if (i === segments.length - 1) {
                return [luau.callStatement(value as L.CallExpression | L.MethodCallExpression)]
            }
            return [luau.assign([at], [value]), luau.ifThen(luau.binary("~=", at, luau.nil()), nest(i + 1))]
        }
        const test = luau.ifThen(luau.binary("~=", at, luau.nil()), nest(0))
        if (base.type === "Identifier" && base.name === ref) return test
        return luau.doBlock([luau.local([ref], [base]), test])
    }

    /** `a?.b` as a value. The one-test form on a name is an `if` expression;
     *  anything else runs in a function, so every link is evaluated at most
     *  once and in order. */
    private optionalChainExpression(chain: Chain): L.Expression {
        const segments = this.segments(chain)
        const base = this.expression(chain.base)
        const last = chain.links[chain.links.length - 1]
        // An `if` expression gives one value; a call may give more, as it
        // would without the `?`.
        if (base.type === "Identifier" && segments.length === 1 && last.type !== "CallExpression" && last.type !== "MethodCallExpression") {
            return {
                type: "IfElseExpression",
                clauses: [{ condition: luau.binary("==", base, luau.nil()), body: luau.nil() }],
                alternate: this.applySegment(segments[0], base),
                line: base.line,
                column: base.column,
            }
        }

        const ref = this.names.fresh("ref")
        const at = luau.identifier(ref)
        const statements: L.Statement[] = [luau.local([ref], [base])]
        segments.forEach((segment, i) => {
            statements.push(luau.ifThen(luau.binary("==", at, luau.nil()), [luau.returns([luau.nil()])]))
            const value = this.applySegment(segment, at)
            statements.push(i === segments.length - 1 ? luau.returns([value]) : luau.assign([at], [value]))
        })
        const passesVarargs = statements.some(usesVararg)
        const func = luau.functionExpression(luau.functionBody([], statements, passesVarargs))
        return luau.call(luau.parenthesized(func), passesVarargs ? [vararg()] : [])
    }

    /** `` `${a} any` `` -> `("%s any"):format(tostring(a))` */
    private interpolatedString(node: T.InterpolatedStringExpression): L.Expression {
        let format = ""
        let text = ""
        const args: L.Expression[] = []
        for (const part of node.parts) {
            if (part.kind === "string") {
                format += part.value.replace(/%/g, "%%")
                text += part.value
            } else {
                format += "%s"
                args.push(luau.call(this.builtin("tostring"), [this.expression(part.expression)]))
            }
        }
        if (!args.length) return luau.string(text)
        return luau.methodCall(luau.parenthesized(luau.string(format)), "format", args)
    }

    /** `a += b` for Lua 5.1, which has no compound assignment: `a = a + b`.
     *
     *  The target has to be read and written, and writing it out twice would
     *  evaluate whatever addresses it twice — `t[next()] += 1` would advance
     *  twice and add to the wrong slot. So anything but a plain name has its
     *  object and key taken into locals first, and both halves use those. */
    private compoundAssignment51(node: T.CompoundAssignmentStatement): L.Statement[] {
        // `..=` is `..`, `+=` is `+`: the operator without its `=`.
        const operator = node.operator.slice(0, -1)
        const before: L.Statement[] = []

        // The target, as an expression that may be read and written freely.
        let target: L.Expression
        if (node.target.type === "MemberExpression" || node.target.type === "IndexExpression") {
            const object = this.expression(node.target.object)
            const objectName = this.names.fresh("target")
            before.push(luau.local([objectName], [object]))
            if (node.target.type === "MemberExpression") {
                target = luau.member(luau.identifier(objectName), node.target.property.name)
            } else {
                const keyName = this.names.fresh("key")
                before.push(luau.local([keyName], [this.expression(node.target.index)]))
                target = luau.index(luau.identifier(objectName), luau.identifier(keyName))
            }
        } else {
            target = this.expression(node.target)
        }

        const value = this.expression(node.value)
        const combined = operator === "//"
            ? this.floorDivide(target, value)
            : luau.binary(operator as L.BinaryExpression["operator"], target, luau.parenthesized(value))
        const statement = luau.assign([target], [combined])
        return before.length ? [luau.doBlock([...before, statement])] : [statement]
    }

    /** A loop body for Lua 5.1, which has neither `continue` nor the `goto`
     *  every other Lua lowers it to.
     *
     *  `repeat ... until true` runs its body exactly once, so a `break` inside
     *  it abandons the rest of the body and lands back in the enclosing loop —
     *  which is what `continue` means. The catch is that a *real* `break` in
     *  the same body would now leave only that inner `repeat`, so when the
     *  body has one it sets a flag that the loop checks once the `repeat` is
     *  done, and breaks for real there. A body with no `continue` is left
     *  exactly as it was. */
    private loopBody51(body: L.Block): L.Block {
        if (!this.lua51 || !hasOwnJump(body.statements, "ContinueStatement")) return body
        const flag = hasOwnJump(body.statements, "BreakStatement") ? this.names.fresh("broke") : undefined
        const once = luau.repeatUntil(rewriteOwnJumps(body.statements, flag), luau.boolean(true))
        if (!flag) return luau.block([once])
        return luau.block([
            luau.local([flag], [luau.boolean(false)]),
            once,
            luau.ifThen(luau.identifier(flag), [luau.breakStatement()]),
        ])
    }

    /** `if c then a else b` as an expression, for Lua 5.1, which has none.
     *
     *  `c and a or b` is the usual stand-in, but it is wrong whenever `a` can
     *  be `false` or `nil`: it then yields `b` even though `c` held. So it is
     *  only used where every branch is written as a value that can be neither,
     *  and anything else becomes a call — one closure, but always the branch
     *  that was written. */
    private ifElse51(node: T.IfElseExpression): L.Expression {
        const clauses = node.clauses.map(c => ({
            condition: this.expression(c.condition),
            body: this.expression(c.body),
        }))
        const alternate = this.expression(node.alternate)

        if (clauses.every(c => alwaysTruthy(c.body))) {
            // Right to left, so `a ? b : c ? d : e` nests as it reads.
            let result = alternate
            for (let i = clauses.length - 1; i >= 0; i--) {
                const { condition, body } = clauses[i]
                result = luau.binary("or", luau.binary("and", condition, body), result)
            }
            return luau.parenthesized(result)
        }

        const statement: L.IfStatement = {
            type: "IfStatement",
            clauses: clauses.map(c => ({
                type: "IfClause" as const,
                condition: c.condition,
                body: luau.block([luau.returns([c.body])]),
                ...spanOf(node),
            })),
            alternate: luau.block([luau.returns([alternate])]),
            ...spanOf(node),
        }
        return luau.call(
            luau.parenthesized(luau.functionExpression(luau.functionBody([], [statement]))),
            [],
        )
    }

    /** How a number is written out. Luau takes what was written; Lua 5.1 has
     *  neither digit separators nor binary literals, so `1_000_000` loses its
     *  underscores and `0b1010` becomes the decimal it means. A hex literal
     *  keeps its base — 5.1 reads those. */
    private numberRaw(node: T.NumberLiteral): string {
        if (!this.lua51) return node.raw
        if (/^0[bB]/.test(node.raw)) return String(node.value)
        return node.raw.replace(/_/g, "")
    }

    /** `a // b` for Lua 5.1, which has no floor-division operator. */
    private floorDivide(left: L.Expression, right: L.Expression): L.Expression {
        return luau.call(
            luau.member(this.builtin("math"), "floor"),
            [luau.binary("/", left, luau.parenthesized(right))],
        )
    }

    /** `{ a: 1, b, [k]: v }`. A spread splits the literal into parts that
     *  `assign` copies into one table in order, so a later key still wins. */
    private tableExpression(node: T.TableExpression): L.Expression {
        const parts: L.Expression[] = []
        let current: L.TableField[] = []
        for (const f of node.fields) {
            switch (f.type) {
                case "TableFieldNamed": {
                    const key = f.key.type === "Identifier" ? f.key.name : f.key.value
                    current.push(luau.field(key, this.expression(f.value)))
                    break
                }
                case "TableFieldShorthand":
                    current.push(luau.field(f.name.name, this.reference(f.name)))
                    break
                case "TableFieldComputed":
                    current.push({ type: "TableFieldComputed", key: this.expression(f.key), value: this.expression(f.value) })
                    break
                case "TableFieldSpread":
                    if (current.length) parts.push(luau.table(current))
                    current = []
                    parts.push(this.expression(f.argument))
                    break
            }
        }
        if (parts.length === 0) return luau.table(current)
        if (current.length) parts.push(luau.table(current))
        return luau.call(this.helper("assign"), [luau.table([]), ...parts])
    }

    /** `[1, ...xs, 2]`. Without a spread it is a Luau sequence; with one, the
     *  runs of plain elements and the spread arrays are joined by `concat`. */
    private arrayExpression(node: T.ArrayExpression): L.Expression {
        const elements = packs(node.elements).items
        // A call written last takes every value it returns: `[require(m)]`
        // is how a program asks for all of them. A Luau sequence does that
        // itself for its last element.
        if (!elements.some(e => e.type === "SpreadElement")) {
            return luau.table(elements.map(e => ({ type: "TableFieldPositional", value: this.expression(e as T.Expression) })))
        }
        const parts: L.Expression[] = []
        let current: T.Expression[] = []
        const flush = (last: boolean): void => {
            if (!current.length) return
            // Only a sequence's last value expands to several; in a run that
            // a spread follows, a call is kept to one value.
            parts.push(luau.table(current.map((e, i) => {
                const value = this.expression(e)
                return { type: "TableFieldPositional", value: last || i < current.length - 1 ? value : this.keptToOne(value) }
            })))
            current = []
        }
        for (const element of elements) {
            if (element.type === "SpreadElement") {
                flush(false)
                parts.push(this.expression(element.argument))
            } else {
                current.push(element)
            }
        }
        flush(true)
        return luau.call(this.helper("concat"), parts)
    }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

type Link = T.MemberExpression | T.IndexExpression | T.CallExpression | T.MethodCallExpression

/** `...[a, b]` is the Luau pack `a, b`: a spread array literal is written out
 *  as its values, not built and unpacked. A call last in the literal takes
 *  every value it answers, as it would in the array; Luau only does that for
 *  the last value of a list, so that call is in `many` when it ends up last,
 *  and stays a spread of its own one-element array anywhere else. */
function packs(list: readonly T.Expression[]): { items: T.Expression[]; many: Set<T.Expression> } {
    const items: T.Expression[] = []
    const many = new Set<T.Expression>()
    const add = (elements: readonly T.Expression[]): void => {
        for (const element of elements) {
            if (element.type === "SpreadElement" && element.argument.type === "ArrayExpression") {
                const inner = element.argument.elements
                add(inner)
                const last = inner[inner.length - 1]
                if (last && (last.type === "CallExpression" || last.type === "MethodCallExpression")) many.add(last)
            } else {
                items.push(element)
            }
        }
    }
    add(list)
    items.forEach((item, i) => {
        if (!many.has(item) || i === items.length - 1) return
        many.delete(item)
        items[i] = { type: "SpreadElement", argument: { type: "ArrayExpression", elements: [item], ...spanOf(item) }, ...spanOf(item) } as T.SpreadElement
    })
    return { items, many }
}

/** An optional chain: the expression under its first `?.` / `?:`, and the
 *  links read from it, innermost first. */
interface Chain {
    base: T.Expression
    links: Link[]
}

function isLink(node: T.Expression): node is Link {
    return node.type === "MemberExpression" || node.type === "IndexExpression"
        || node.type === "CallExpression" || node.type === "MethodCallExpression"
}

function linkObject(node: Link): T.Expression {
    return node.type === "CallExpression" ? node.callee : node.object
}

/** The chain `node` ends, when a `?.` or `?:` is in it. Parentheses end a
 *  chain: `(a?.b).c` reads `.c` from whatever `(a?.b)` gave. */
function optionalChain(node: T.Expression): Chain | undefined {
    const spine: Link[] = []
    for (let e: T.Expression = node; isLink(e); e = linkObject(e)) spine.unshift(e)
    const first = spine.findIndex(link => (link as { optional?: boolean }).optional)
    if (first < 0) return undefined
    return { base: linkObject(spine[first]), links: spine.slice(first) }
}

/** Does `node` read `...` outside any function of its own? */
function usesVararg(node: unknown): boolean {
    if (Array.isArray(node)) return node.some(usesVararg)
    if (!node || typeof node !== "object") return false
    const record = node as Record<string, unknown>
    if (record.type === "VarargExpression") return true
    if (record.type === "FunctionExpression" || record.type === "LocalFunctionStatement" || record.type === "FunctionStatement") return false
    return Object.values(record).some(usesVararg)
}

/** `tilua_array.filter` as an expression: a name, then a member per dot. */
function calleePath(path: string): L.Expression {
    const [head, ...rest] = path.split(".")
    return rest.reduce<L.Expression>((value, name) => luau.member(value, name), luau.identifier(head))
}

function spanOf(node: T.BaseNode): L.BaseNode {
    return { line: node.line, column: node.column }
}

function vararg(): L.VarargExpression {
    return { type: "VarargExpression", line: { start: 0, end: 0 }, column: { start: 0, end: 0 } }
}

/** `select("#", ...)` */
function selectCount(select: L.Expression): L.Expression {
    return luau.call(select, [luau.string("#"), vararg()])
}


function expandsToMany(e: L.Expression): boolean {
    return e.type === "CallExpression" || e.type === "MethodCallExpression" || e.type === "VarargExpression"
}

/** `a.b.c` as `["a", "b", "c"]`, or `undefined` for anything else. */
/** A lowered `super(...)`: the one thing that calls a base class's `__init`. */
function isSuperInit(statement: L.Statement): boolean {
    return statement.type === "CallStatement" &&
        statement.expression.type === "CallExpression" &&
        statement.expression.callee.type === "MemberExpression" &&
        statement.expression.callee.property.name === "__init"
}

function memberChain(e: L.Expression): string[] | undefined {
    if (e.type === "Identifier") return [e.name]
    if (e.type === "MemberExpression") {
        const base = memberChain(e.object)
        return base && [...base, e.property.name]
    }
    return undefined
}

/** A declaration's target. A member or an index is a leaf only of a
 *  destructuring assignment, never of a declaration. */
function declared(target: T.BindingTarget): T.IdentifierPattern | T.ObjectPattern | T.ArrayPattern {
    if (target.type === "MemberExpression" || target.type === "IndexExpression") {
        throw new Error("a declaration binds names, not a member or an index")
    }
    return target
}

/** Every name a binding target introduces, as its pattern node. */
function identifierPatterns(target: T.BindingTarget): T.IdentifierPattern[] {
    switch (target.type) {
        case "IdentifierPattern": return [target]
        case "MemberExpression":
        case "IndexExpression": return []
        case "ObjectPattern":
            return [...target.properties.flatMap(p => identifierPatterns(p.value)), ...(target.rest ? identifierPatterns(target.rest) : [])]
        case "ArrayPattern":
            return [
                ...target.elements.flatMap(e => (e ? identifierPatterns(e.value) : [])),
                ...(target.rest ? identifierPatterns(target.rest) : []),
            ]
    }
}

/** Where the top level declares the value `name`, as the node its binding records. */
function topLevelDeclaration(
    statements: readonly T.Statement[],
    name: string,
): { type: "ImportStatement" | "Declaration"; node: object } | undefined {
    for (const statement of statements) {
        const declaration = statement.type === "ExportStatement" ? statement.declaration : statement
        if (declaration.type === "VariableDeclaration") {
            const pattern = identifierPatterns(declaration.name).find(p => p.name === name)
            if (pattern) return { type: "Declaration", node: pattern }
        } else if (declaration.type === "FunctionDeclaration" && declaration.name.name === name) {
            return { type: "Declaration", node: declaration.name }
        } else if (declaration.type === "ImportStatement") {
            const local = declaration.defaultImport?.name === name
                ? declaration.defaultImport
                : declaration.specifiers.find(s => s.local.name === name)?.local
            if (local) return { type: "ImportStatement", node: local }
        }
    }
    return undefined
}

/** A readable local name for a required module: `src/shared/util` -> `util`. */
function moduleName(key: string): string {
    const last = key.split("/").filter(Boolean).pop() ?? "module"
    const cleaned = last.replace(/[^A-Za-z0-9_]/g, "_")
    return /^[A-Za-z_]/.test(cleaned) && !luau.LUAU_KEYWORDS.has(cleaned) ? cleaned : `module_${cleaned}`
}

/** Is this value certainly neither `false` nor `nil` — the only two things Lua
 *  treats as false? `0` and `""` are true in Lua, so a literal of any kind but
 *  `false` and `nil` qualifies. Used to tell when `c and a or b` is safe. */
function alwaysTruthy(value: L.Expression): boolean {
    switch (value.type) {
        case "NumberLiteral":
        case "StringLiteral":
        case "InterpolatedStringExpression":
        case "TableExpression":
        case "FunctionExpression":
            return true
        case "BooleanLiteral":
            return value.value
        case "ParenthesizedExpression":
            return alwaysTruthy(value.expression)
        default:
            return false
    }
}

/** The blocks a loop's own `break` and `continue` can stand in: its body, and
 *  any `do` or `if` nested in it. A loop inside it owns its own jumps, and so
 *  does a function, so neither is looked into. */
function ownBlocks(statement: L.Statement): L.Block[] {
    switch (statement.type) {
        case "DoStatement":
            return [statement.body]
        case "IfStatement":
            return [...statement.clauses.map(c => c.body), ...(statement.alternate ? [statement.alternate] : [])]
        default:
            return []
    }
}

/** Does this loop body contain a `break` / `continue` of its own? */
function hasOwnJump(statements: readonly L.Statement[], type: "BreakStatement" | "ContinueStatement"): boolean {
    return statements.some(statement =>
        statement.type === type || ownBlocks(statement).some(b => hasOwnJump(b.statements, type)))
}

/** This loop body with its own jumps rewritten for a `repeat ... until true`
 *  standing in for `continue`: `continue` becomes the `break` that ends that
 *  `repeat`, and a real `break` raises `flag` first so the loop can break once
 *  the `repeat` has been left. */
function rewriteOwnJumps(statements: readonly L.Statement[], flag: string | undefined): L.Statement[] {
    return statements.flatMap((statement): L.Statement[] => {
        if (statement.type === "ContinueStatement") return [luau.breakStatement()]
        if (statement.type === "BreakStatement") {
            return flag
                ? [luau.assign([luau.identifier(flag)], [luau.boolean(true)]), luau.breakStatement()]
                : [statement]
        }
        if (statement.type === "DoStatement") {
            return [luau.doBlock(rewriteOwnJumps(statement.body.statements, flag))]
        }
        if (statement.type === "IfStatement") {
            return [{
                ...statement,
                clauses: statement.clauses.map(c => ({
                    ...c,
                    body: luau.block(rewriteOwnJumps(c.body.statements, flag)),
                })),
                alternate: statement.alternate && luau.block(rewriteOwnJumps(statement.alternate.statements, flag)),
            }]
        }
        return [statement]
    })
}

/** The locals a loop body declares directly in it — the ones a `repeat`'s
 *  `until` can still see. A local inside a nested block goes out of scope with
 *  that block, so the condition could not have read it either way. */
function declaredNames(statements: readonly L.Statement[]): string[] {
    const names: string[] = []
    for (const statement of statements) {
        if (statement.type === "LocalStatement") names.push(...statement.names.map(n => n.name))
        else if (statement.type === "LocalFunctionStatement") names.push(statement.name.name)
    }
    return names
}

/** Does `expression` read `name` anywhere in it? */
function mentions(expression: L.Expression, name: string): boolean {
    let found = false
    const walk = (value: unknown): void => {
        if (found || !value || typeof value !== "object") return
        if (Array.isArray(value)) { for (const item of value) walk(item) ; return }
        const node = value as { type?: unknown; name?: unknown }
        if (node.type === "Identifier" && node.name === name) { found = true; return }
        for (const [key, child] of Object.entries(value)) {
            if (key !== "line" && key !== "column") walk(child)
        }
    }
    walk(expression)
    return found
}

/** Is this a callable — one signature, or an overload set of them? */
function isFunctionType(type: Type): boolean {
    if (type.kind === "function") return true
    return type.kind === "intersection" && type.types.some(t => t.kind === "function")
}

/** Every node under `root`, the root included. */
function allNodes(root: unknown): object[] {
    const out: object[] = []
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return
        if (Array.isArray(value)) return void value.forEach(visit)
        const record = value as Record<string, unknown>
        if (typeof record.type === "string") out.push(value as object)
        for (const [key, child] of Object.entries(record)) {
            if (key !== "line" && key !== "column") visit(child)
        }
    }
    visit(root)
    return out
}

/** The metamethods a class can write, copied from the class it extends. */
const CLASS_METAMETHODS = [
    "__add", "__sub", "__mul", "__div", "__idiv", "__mod", "__pow", "__unm", "__concat",
    "__len", "__eq", "__lt", "__le", "__call", "__tostring", "__iter",
]
