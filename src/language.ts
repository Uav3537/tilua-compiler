/**
 * The language's own lowering: what a method a string, an array or a table
 * answers to becomes.
 *
 * Their metatables are the language's (declared in @tilua/parser's prelude),
 * so running them is the compiler's, not a library's. A string's Lua methods
 * (`upper`, `sub`) are Lua's own and stay plain method calls; the rest no Lua
 * value really has, and each call becomes a call of a function in the runtime
 * here (runtime/*.luau) — nothing is attached to a table or to the string
 * metatable, so they work on any array, one a Lua library made included.
 *
 * It is a `LoweringPlugin` like a library's, asked only about a method the
 * analyzer read from one of the language's metatables (`MethodSource`).
 */
import { readFileSync } from "node:fs"
import { luauString, type LoweringPlugin, type Type } from "@tilua/parser"
import type { LoadedLowering } from "./lowering"

/** A runtime file, shipped beside `dist` (and `src`). */
const read = (name: string): string => readFileSync(new URL(`../runtime/${name}`, import.meta.url), "utf8")

/** The functions a runtime defines, taken from the Luau itself so the two
 *  cannot drift apart. */
const implemented = (source: string): Set<string> =>
    new Set([...source.matchAll(/function __NAME__\.(\w+)/g)].map(m => m[1]))

const array = read("array.luau")
const string = read("string.luau")
const object = read("object.luau")
const arrayMethods = implemented(array)
const stringMethods = implemented(string)
const objectMethods = implemented(object)

/** Is every member of `type` (bar a `nil`, which is the analyzer's to
 *  report) one `is` accepts? A type parameter is what its constraint is. */
function every(type: Type | undefined, is: (type: Type) => boolean, seen = new Set<Type>()): boolean {
    if (!type || seen.has(type)) return false
    seen.add(type)
    if (type.kind === "union") {
        return type.types.filter(m => !(m.kind === "primitive" && m.name === "nil")).every(m => every(m, is, seen))
    }
    if (type.kind === "typeParam") return every(type.constraint, is, seen)
    return is(type)
}

const isArray = (type: Type | undefined): boolean => every(type, t => t.kind === "array" || t.kind === "tuple")
const isString = (type: Type | undefined): boolean => every(type, t =>
    (t.kind === "primitive" && t.name === "string") || (t.kind === "literal" && t.base === "string") || t.kind === "templateLiteral")

/** What `table:keys()` tells the runtime about the table's keys: the keys in
 *  the order its type wrote them, as Luau source, and whether an indexer's
 *  keys follow them. The runtime answers in that order, which is what makes
 *  the tuple the analyzer typed the call as true. A union whose members list
 *  different keys has no one order, and hands over `nil`: every key, as
 *  `pairs` walks them. */
function objectKeys(type: Type | undefined): { known: string; open: string } {
    const members = type?.kind === "union" ? type.types : type ? [type] : []
    const orders: string[][] = []
    let open = false
    for (const member of members) {
        const keys: string[] = []
        for (const part of member.kind === "intersection" ? member.types : [member]) {
            if (part.kind !== "object") continue
            for (const key of part.properties.keys()) if (!keys.includes(key)) keys.push(key)
            if (part.indexer) open = true
        }
        orders.push(keys)
    }
    const order = JSON.stringify(orders[0] ?? [])
    const known = orders.length && orders.every(keys => JSON.stringify(keys) === order)
        ? `{ ${orders[0].map(key => luauString(key)).join(", ")} }`
        : "nil"
    return { known, open: String(open) }
}

const plugin: LoweringPlugin = {
    runtime: { array, string, object },

    methodCall({ method, receiver, use }) {
        if (isString(receiver)) {
            // Lua's own `upper`, `sub`, ...: the string already answers to them.
            return stringMethods.has(method) ? { callee: `${use("string")}.${method}` } : undefined
        }
        if (isArray(receiver)) {
            return arrayMethods.has(method) ? { callee: `${use("array")}.${method}` } : undefined
        }
        if (objectMethods.has(method)) {
            const keys = objectKeys(receiver)
            return { callee: `${use("object")}.${method}`, prepend: [keys.known, keys.open] }
        }
        return undefined
    },
}

export const languageLowering: LoadedLowering = { plugin, from: "tilua" }
