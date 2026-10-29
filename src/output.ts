/**
 * Writing the output out: in which Lua, and how it is laid out.
 *
 * The output is Lua 5.1, which every Lua and LuaJIT and Luau read, unless a
 * library in `types` says its Lua writes more (`"luau"` does). The printer is
 * told so, and refuses a node that has no Lua 5.1 spelling instead of writing
 * it: a `+=` or a `continue` lowering let through, or a library runtime written
 * in Luau, is an error at build time rather than at runtime on a Lua that
 * cannot read it.
 */
import { print, PrintError, type Node, type PrintOptions } from "luau-parser"
import type { LuaSyntax } from "@tilua/parser"

/** The syntax a library may declare that is written differently, not only
 *  run differently: with any of it the output is printed as Luau. `iteration`
 *  and `requireByPath` are spelled as Lua 5.1 spells them. */
const WRITTEN: ReadonlySet<LuaSyntax> = new Set<LuaSyntax>([
    "compoundAssignment", "continue", "ifExpression", "floorDivision", "attributes", "numberLiterals",
])

export interface OutputFormat {
    /** Indentation a block level at a time; none unless given. */
    readonly indent?: "\t" | number
    /** One line, and as few `;` as it can take. */
    readonly minify?: boolean
}

/** What the printer is told, for a project whose libraries declare `syntax`. */
export function printOptions(syntax: ReadonlySet<LuaSyntax>, format: OutputFormat = {}): PrintOptions {
    // A key given as `undefined` replaces the printer's own default, so one
    // left unset is left out.
    return {
        syntax: [...syntax].some(s => WRITTEN.has(s)) ? "luau" : "lua51",
        compact: format.minify ?? false,
        ...(format.indent !== undefined && { indent: format.indent }),
    }
}

/** `node` as text, or why it cannot be written in the project's Lua. */
export function printOutput(node: Node, options: PrintOptions): { code: string } | { problem: string } {
    try {
        return { code: print(node, options) }
    } catch (error) {
        if (!(error instanceof PrintError)) throw error
        return {
            problem: `The output cannot be written as Lua 5.1: ${(error as Error).message.replace(/ \(\d+:\d+\)$/, "")}. `
                + "Nothing in 'types' says the project's Lua has it — \"luau\" does, and \"roblox\" brings \"luau\"",
        }
    }
}
