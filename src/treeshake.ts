/**
 * Tree shaking: what of a project the entry never reaches is left out of the
 * bundle (the config's `"treeShaking": true`).
 *
 * A module's top-level statement is kept when it does something as the module
 * runs — a call, an assignment, a loop — or when something kept reads what it
 * declares. An export is read when a module that is kept imports it, and the
 * entry's exports always are. What is left over is a declaration nobody reads
 * whose value costs nothing to leave unmade — a function, a class, a `const`
 * of a literal — and it goes. A module none of whose exports are read, and
 * that does nothing as it runs, is not required at all, and is not bundled.
 *
 * Reading is followed across modules until nothing more is found to be read:
 * `import { a }` reads `a`, `M.a` reads `a` of `import * as M`, and anything
 * else done with a namespace — passing it on, `import("./x")` — reads every
 * export. `export { a } from` and `export * from` pass a read on.
 *
 * Luau's own runtime tables are shaken too, member by member, once the
 * modules are lowered (`SharedRuntime.shake`).
 */
import type * as T from "@tilua/parser"
import type { BindingId, ScopeAnalysis } from "@tilua/parser"

export interface ShakeModule {
    readonly file: string
    readonly program: T.Program
    readonly scopes: ScopeAnalysis
    /** The module an import names, if it is one of the bundle's. */
    resolve(specifier: string): string | undefined
}

/** What lowering a module is told. */
export interface ShakenModule {
    /** Top-level statements left out. */
    readonly removed: ReadonlySet<object>
    /** References that sit in what was left out: they read nothing. */
    readonly dead: ReadonlySet<object>
}

export interface Shaken {
    readonly modules: ReadonlyMap<string, ShakenModule>
    /** Modules that do something as they run: one imported for nothing it
     *  exports still runs, as an ES module does. */
    readonly sideEffects: ReadonlySet<string>
    /** Modules the bundle needs at all. */
    readonly required: ReadonlySet<string>
}

type Node = { type?: string; [key: string]: unknown }

/** Every node under `node`, `skip` deciding which subtrees are not entered. */
function walk(node: unknown, visit: (node: Node, parent: Node | undefined) => boolean | void, parent?: Node): void {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) {
        for (const item of node) walk(item, visit, parent)
        return
    }
    const n = node as Node
    if (typeof n.type === "string" && visit(n, parent) === false) return
    for (const [key, child] of Object.entries(n)) {
        if (key === "line" || key === "column") continue
        walk(child, visit, typeof n.type === "string" ? n : parent)
    }
}

/** Does making this value run anything? A call does, and so may building a
 *  class whose statics are calls; reading a name, writing a literal or
 *  making a function does not. A function's body runs when it is called,
 *  not here. */
function pure(expression: unknown): boolean {
    let ok = true
    walk(expression, node => {
        if (!ok) return false
        switch (node.type) {
            case "CallExpression":
            case "MethodCallExpression":
            case "ImportExpression":
            case "SuperExpression":
                ok = false
                return false
            case "FunctionExpression":
            case "FunctionBody":
            case "ClassMethod":
            case "ClassAccessor":
            case "ClassConstructor":
                return false
            case "ClassField":
                // An instance's field is made with the instance.
                if (!node.isStatic) return false
        }
    })
    return ok
}

/** The statement a top-level `export` wraps, or the statement itself. */
function declarationOf(statement: T.Statement): T.Statement {
    return statement.type === "ExportStatement" ? statement.declaration as T.Statement : statement
}

/** Can this top-level statement be left out when nothing reads it? */
function removable(statement: T.Statement): boolean {
    const declaration = declarationOf(statement)
    switch (declaration.type) {
        case "FunctionDeclaration":
            return true
        case "ClassDeclaration":
            return pure(declaration)
        case "VariableDeclaration":
            return declaration.init === undefined || pure(declaration.init)
        case "ExportDefaultStatement":
            return pure(declaration.declaration)
        default:
            return false
    }
}

/** Is this top-level statement only there for the types, or for linking —
 *  run by nothing, kept by nothing? */
function structural(statement: T.Statement): boolean {
    switch (statement.type) {
        case "TypeAliasStatement":
        case "ExportTypeAliasStatement":
        case "DeclareStatement":
        case "DeclareClassStatement":
        case "DeclareMetatableStatement":
        case "ImportStatement":
        case "ExportNamedStatement":
        case "ExportAllStatement":
            return true
        default:
            return false
    }
}

/** The names a top-level statement exports. */
function exportedNames(statement: T.Statement): string[] {
    switch (statement.type) {
        case "ExportStatement": {
            const declaration = statement.declaration
            if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") return [declaration.name.name]
            const names: string[] = []
            walk(declaration.name, node => { if (node.type === "IdentifierPattern") names.push(node.name as string) })
            return names
        }
        case "ExportDefaultStatement":
            return ["default"]
        default:
            return []
    }
}

interface ModuleFacts {
    readonly module: ShakeModule
    readonly tops: readonly T.Statement[]
    /** The top-level statement each top-level binding is declared by. */
    readonly declaredBy: Map<BindingId, T.Statement>
    /** What each imported binding is: a module, and the export it names —
     *  `*` for the whole namespace. */
    readonly imported: Map<BindingId, { target: string; name: string }>
    readonly parents: WeakMap<object, Node>
    readonly sideEffects: boolean
}

function factsOf(module: ShakeModule): ModuleFacts {
    const tops = module.program.body.statements
    const byNode = new Map<object, BindingId>()
    for (const binding of module.scopes.bindings.values()) {
        if (binding.declarationNode) byNode.set(binding.declarationNode, binding.id)
    }
    const declaredBy = new Map<BindingId, T.Statement>()
    const imported = new Map<BindingId, { target: string; name: string }>()
    for (const statement of tops) {
        const declaration = declarationOf(statement)
        const declare = (node: object | undefined): void => {
            const id = node && byNode.get(node)
            if (id !== undefined) declaredBy.set(id, statement)
        }
        if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") declare(declaration.name)
        else if (declaration.type === "VariableDeclaration") {
            walk(declaration.name, node => { if (node.type === "IdentifierPattern") declare(node) })
        } else if (declaration.type === "ImportStatement" && !declaration.isTypeOnly) {
            const target = module.resolve(declaration.source.value)
            if (target === undefined) continue
            const add = (node: object | undefined, name: string): void => {
                const id = node && byNode.get(node)
                if (id !== undefined) imported.set(id, { target, name })
            }
            if (declaration.defaultImport) add(declaration.defaultImport, "default")
            if (declaration.namespaceImport) add(declaration.namespaceImport, "*")
            for (const s of declaration.specifiers) add(s.local, s.imported.name)
        }
    }
    const parents = new WeakMap<object, Node>()
    walk(module.program.body, (node, parent) => { if (parent) parents.set(node, parent) })
    const sideEffects = tops.some(s => !structural(s) && !removable(s))
    return { module, tops, declaredBy, imported, parents, sideEffects }
}

export function treeShake(modules: readonly ShakeModule[], entry: string): Shaken {
    const facts = new Map(modules.map(m => [m.file, factsOf(m)]))
    /** What of each module is read: export names, or `"all"`. */
    const used = new Map<string, Set<string> | "all">()
    const live = new Map<string, Set<T.Statement>>()
    const required = new Set<string>()
    let changed = true

    const require = (file: string): void => {
        if (required.has(file) || !facts.has(file)) return
        required.add(file)
        changed = true
    }
    const read = (file: string, name: string): void => {
        if (!facts.has(file)) return
        require(file)
        const now = used.get(file)
        if (now === "all") return
        if (name === "*") {
            used.set(file, "all")
            changed = true
            return
        }
        const names = now ?? new Set<string>()
        if (!names.has(name)) {
            names.add(name)
            used.set(file, names)
            changed = true
        }
    }
    const isRead = (file: string, name: string): boolean => {
        const now = used.get(file)
        return now === "all" || (now?.has(name) ?? false)
    }

    require(entry)
    used.set(entry, "all")
    while (changed) {
        changed = false
        for (const file of [...required]) {
            const f = facts.get(file)!
            const kept = live.get(file) ?? new Set<T.Statement>()
            live.set(file, kept)
            const queue: T.Statement[] = []
            const keep = (statement: T.Statement | undefined): void => {
                if (!statement || kept.has(statement)) return
                kept.add(statement)
                queue.push(statement)
                changed = true
            }
            for (const statement of f.tops) {
                if (!structural(statement) && !removable(statement)) keep(statement)
                if (exportedNames(statement).some(name => isRead(file, name))) keep(statement)
                const declaration = declarationOf(statement)
                if (declaration.type === "ImportStatement" && !declaration.isTypeOnly
                    && !declaration.defaultImport && !declaration.namespaceImport && !declaration.specifiers.length) {
                    // `import "./setup"`: run for what it does.
                    const target = f.module.resolve(declaration.source.value)
                    if (target !== undefined) require(target)
                }
                if (declaration.type === "ExportNamedStatement" && !declaration.typeOnly) {
                    const target = declaration.source ? f.module.resolve(declaration.source.value) : undefined
                    for (const s of declaration.specifiers) {
                        if (!isRead(file, s.exported.name)) continue
                        if (declaration.source) {
                            if (target !== undefined) read(target, s.local.name)
                            continue
                        }
                        // `export { a as b }`: what declares `a`, or the import it is.
                        const id = f.module.scopes.bindingOf.get(s.local as T.Identifier)
                        const own = [...f.declaredBy].find(([bid, st]) =>
                            (id !== undefined ? bid === id : false) || exportedLocal(st, s.local.name))
                        if (own) keep(own[1])
                        const from = id !== undefined ? f.imported.get(id) : undefined
                        if (from) read(from.target, from.name)
                    }
                }
                if (declaration.type === "ExportAllStatement") {
                    const target = f.module.resolve(declaration.source.value)
                    if (target === undefined) continue
                    const mine = used.get(file)
                    if (mine === "all") read(target, "*")
                    else for (const name of mine ?? []) if (!ownExport(f, name)) read(target, name)
                }
            }
            // What a kept statement reads is kept too, here and in the
            // modules it imports from.
            for (const statement of [...kept]) queue.push(statement)
            while (queue.length) {
                const statement = queue.pop()!
                walk(statement, node => {
                    if (node.type === "ImportExpression") {
                        const source = node.source as Node
                        const target = source?.type === "StringLiteral" ? f.module.resolve(source.value as string) : undefined
                        if (target !== undefined) read(target, "*")
                        return
                    }
                    if (node.type !== "Identifier") return
                    const id = f.module.scopes.bindingOf.get(node as unknown as T.Identifier)
                    if (id === undefined) return
                    const declaring = f.declaredBy.get(id)
                    if (declaring && declaring !== statement) keep(declaring)
                    const from = f.imported.get(id)
                    if (!from) return
                    if (from.name !== "*") return read(from.target, from.name)
                    // `M.a` reads `a`; anything else done with `M` reads it all.
                    const parent = f.parents.get(node)
                    if (parent?.type === "MemberExpression" && parent.object === node) read(from.target, (parent.property as Node).name as string)
                    else read(from.target, "*")
                })
            }
            // A module imported for nothing it exports still runs, if it
            // does anything as it runs.
            for (const statement of f.tops) {
                if (statement.type !== "ImportStatement" || statement.isTypeOnly) continue
                const target = f.module.resolve(statement.source.value)
                if (target !== undefined && facts.get(target)?.sideEffects) require(target)
            }
        }
    }

    const shaken = new Map<string, ShakenModule>()
    for (const [file, f] of facts) {
        const kept = live.get(file) ?? new Set()
        const removed = new Set<object>(f.tops.filter(s => !kept.has(s) && removable(s)))
        const dead = new Set<object>()
        for (const statement of removed) walk(statement, node => { if (node.type === "Identifier") dead.add(node) })
        shaken.set(file, { removed, dead })
    }
    return {
        modules: shaken,
        sideEffects: new Set([...facts].filter(([, f]) => f.sideEffects).map(([file]) => file)),
        required,
    }
}

/** Does `statement` declare `name` at the top level? */
function exportedLocal(statement: T.Statement, name: string): boolean {
    const declaration = declarationOf(statement)
    if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") return declaration.name.name === name
    if (declaration.type !== "VariableDeclaration") return false
    let found = false
    walk(declaration.name, node => { if (node.type === "IdentifierPattern" && node.name === name) found = true })
    return found
}

/** Does the module export `name` itself, rather than through `export *`? */
function ownExport(f: ModuleFacts, name: string): boolean {
    return f.tops.some(statement => exportedNames(statement).includes(name)
        || (statement.type === "ExportNamedStatement" && statement.specifiers.some(s => s.exported.name === name)))
}
