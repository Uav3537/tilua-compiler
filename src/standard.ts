/**
 * The standard library's lowering: how tilua runs what Lua's standard library
 * declares (@tilua/parser's `standardLibrary`) where Lua's own would not do —
 * the console, `error` with the place it was raised, and the globals whose Lua
 * answer is several values where tilua's is one.
 *
 * The standard library is there in every file, as TypeScript has JavaScript's,
 * so this is the compiler's own rather than a type library's — asked after the
 * language's lowering and before every library's. A project with
 * `"noLib": true` has neither.
 *
 * `use("console")` hands back the local name the output gave
 * `runtime.console`, emitting that table the first time a call needs it.
 */
import { readFileSync } from "node:fs"
import { isFunctionType, luauString, type ArgumentInfo, type CallSite, type LoweringPlugin } from "@tilua/parser"
import type { LoadedLowering } from "./lowering"

/** A runtime file, shipped beside `dist` (and `src`). */
const read = (name: string): string => readFileSync(new URL(`../runtime/${name}`, import.meta.url), "utf8")

const console = read("console.luau")
const result = read("result.luau")

/** The call site as an error names it — `src/shop/buy.tilua:12` — the way
 *  Lua positions an error message. `line 12` for a source compiled on its
 *  own, which has no file name. */
const place = (at: CallSite): string => luauString(at.file === undefined ? `line ${at.line}` : `${at.file}:${at.line}`)

/** The call site as a line of output starts: `[src/shop/buy:12]:`, the file
 *  without its extension. */
const tag = (at: CallSite): string =>
    luauString(`[${at.file === undefined ? `line ${at.line}` : `${at.file.replace(/\.tilua$/, "")}:${at.line}`}]:`)

/** What the compiler knew about `console:log`'s arguments and the runtime
 *  cannot: for each function, the type it was inferred as and the code it was
 *  written as. Keyed by position, so an argument that needs nothing costs
 *  nothing, and `nil` when no argument needs anything — most calls. */
function consoleMeta(args: readonly ArgumentInfo[]): string {
    const fields: string[] = []
    args.forEach((argument, index) => {
        if (argument.spread || argument.typeText === undefined || !isFunctionType(argument.type)) return
        const written = argument.declaration ?? argument.source
        fields.push(`[${index + 1}] = { ${luauString(argument.typeText)}, ${luauString(written)} }`)
    })
    return fields.length ? `{ ${fields.join(", ")} }` : "nil"
}

const CONSOLE_METHODS = new Set(["log", "warn", "error"])

/** Globals whose Luau answer is several values, and the function in
 *  runtime/result.luau that answers as tilua types them — one value, an array
 *  or an object. Calls and reads of the global both get it. */
const REPLACED = new Map([
    ["pcall", "pcall"],
    ["xpcall", "xpcall"],
    ["ypcall", "pcall"],
    ["coroutine.resume", "resume"],
    ["string.find", "find"],
    ["string.match", "match"],
    ["string.gsub", "gsub"],
    ["string.byte", "byte"],
    ["math.modf", "modf"],
    ["math.frexp", "frexp"],
    ["next", "next"],
    ["select", "select"],
    ["unpack", "unpack"],
    ["table.unpack", "unpack"],
    ["loadstring", "loadstring"],
    ["pairs", "pairs"],
    ["ipairs", "ipairs"],
    ["string.gmatch", "gmatch"],
])

const plugin: LoweringPlugin = {
    runtime: { console, result },

    methodCall({ method, receiverGlobal, at, arguments: args, use }) {
        // `console:log(a, f)` becomes `console.log("[src/a:3]:", meta, a, f)`.
        // `console` itself is never passed: it holds nothing.
        if (receiverGlobal === "console" && CONSOLE_METHODS.has(method)) {
            return {
                callee: `${use("console")}.${method}`,
                prepend: [tag(at), consoleMeta(args)],
                passReceiver: false,
            }
        }
        return undefined
    },

    // `print(x)` and `warn(x)` are left exactly as written: the place a line
    // came from is what `console:log` / `console:warn` are for. `error` has to
    // put the place inside the message it raises, so it goes through the
    // runtime.
    globalCall({ name, at, use }) {
        if (name === "error") return { callee: `${use("console")}.raise`, prepend: [place(at)] }
        const replaced = REPLACED.get(name)
        if (replaced) return { callee: `${use("result")}.${replaced}` }
        return undefined
    },

    // Read as a value there is no call site to write down; the runtime finds
    // one on the stack.
    globalValue({ name, use }) {
        if (name === "error") return `${use("console")}.raiseValue`
        const replaced = REPLACED.get(name)
        if (replaced) return `${use("result")}.${replaced}`
        return undefined
    },
}

export const standardLowering: LoadedLowering = { plugin, from: "tilua (standard library)" }
