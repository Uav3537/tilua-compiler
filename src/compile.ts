/**
 * One tilua file -> Luau, on its own: no imports, no exports. A project goes
 * through `bundle` instead.
 *
 * A `config` — a `tilua.config.json` path, or the same JSON inline — brings
 * the project's type libraries: their definitions type the file, and what
 * they lower (`names:filter(f)`) is lowered. Without one the file is compiled
 * against nothing, and a call a library would have explained stays a plain
 * Luau method call.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse, analyzeScopes, analyzeTypes, resolveTypeLibraries, ParseError, LexError } from "@tilua/parser"
import { print } from "luau-parser"
import { lower } from "./lower.js"
import { loadLowerings } from "./lowering.js"
import { resolveConfig, type ConfigInput } from "./config.js"
import * as luau from "./luau.js"

export interface Diagnostic {
    readonly message: string
    readonly line: number
    readonly column: number
}

export interface CompileResult {
    /** The Luau source, or `undefined` when the file has errors. */
    readonly code?: string
    readonly diagnostics: Diagnostic[]
}

export async function compile(source: string, config?: ConfigInput): Promise<CompileResult> {
    let program
    try {
        program = parse(source)
    } catch (error) {
        if (error instanceof ParseError || error instanceof LexError) {
            const { line, column } = error as unknown as { line: number; column: number }
            return { diagnostics: [{ message: (error as Error).message, line, column }] }
        }
        throw error
    }

    // Reassigning a `const` is an error in tilua; Luau would run it anyway.
    const scopes = analyzeScopes(program)
    const diagnostics: Diagnostic[] = scopes.diagnostics.map(d => ({
        message: d.message, line: d.node.line.start, column: d.node.column.start,
    }))

    const { config: resolved, problems } = resolveConfig(config, resolve("main.tilua"))
    const libraries = resolved ? resolveTypeLibraries(resolved) : { files: [], lowerings: [], problems: [] }
    const { lowerings, problems: loweringProblems } = await loadLowerings(libraries.lowerings)
    for (const p of [...problems, ...libraries.problems]) {
        diagnostics.push({ message: p.message, line: p.line ?? 1, column: p.column ?? 1 })
    }
    for (const p of loweringProblems) diagnostics.push({ message: p.message, line: 1, column: 1 })

    const libs = libraries.files.map(file => parse(readFileSync(file, "utf8")))
    const lowered = lower(program, scopes, {
        types: analyzeTypes(program, scopes, { libs, diagnostics: false }),
        lowerings,
        target: resolved?.target,
        source,
    })
    diagnostics.push(...lowered.diagnostics)
    if (diagnostics.length) return { diagnostics }
    return { code: print(luau.program(lowered.statements)) + "\n", diagnostics }
}
