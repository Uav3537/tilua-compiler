/**
 * @tilua/compiler tests.
 *
 * Lowering cases compile a fragment and compare the Lua it prints, with the
 * printer's line breaks folded into spaces so a case reads on one line. Every
 * output is parsed back with luau-parser: whatever lowering builds must be
 * valid Luau — and, without a library that says its Lua has more, valid Lua
 * 5.1 too. Luau's own syntax is tested with a library that says so, built
 * here (`LUAU`), as `@tilua-types/luau` is.
 *
 * Bundle cases build a small project on disk. When a Luau interpreter is
 * available — `luau` on the PATH, or the `LUAU` environment variable naming
 * one — each bundle is also run, and what it prints is compared: that is the
 * only way to know a cycle really behaves like ES modules.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { parse as parseLuau, print as printLuau } from "luau-parser"
import { parse as parseTilua, analyzeScopes as analyzeScopesTilua, analyzeTypes as analyzeTypesTilua } from "@tilua/parser"
import { bundle, compile, type BundleResult } from "../src/index.js"
import { lower } from "../src/lower.js"
import type { LoadedLowering, LoweringPlugin, LuaSyntax } from "../src/lowering.js"
import * as luau from "../src/luau.js"
import { VLQ_DIGITS } from "../src/linemap.js"

let passed = 0
let skipped = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a === b) { passed++; return }
    failures.push(`${name}\n    expected ${b}\n    actual   ${a}`)
}

const flat = (code: string): string => code.trim().split("\n").join(" ")

/** The record of arrays `typeof` reads, as a single file sets it up. */
const ARRAYS = "local tilua_arrays = setmetatable({}, { __mode = \"k\" }); "
    + "local function tilua_asArray(t) tilua_arrays[t] = true; return t; end;"

/** `code` without the bookkeeping every array costs — the record above, and
 *  `tilua_asArray(...)` around each new one — so that a case reads as what it
 *  is about. The cases under "typeof" look at the bookkeeping itself. */
function unmarked(code: string): string {
    let out = code.replace(ARRAYS + " ", "").replace(ARRAYS, "")
    for (;;) {
        const at = out.indexOf("tilua_asArray(")
        if (at < 0) return out
        const open = at + "tilua_asArray".length
        let depth = 0
        let close = open
        for (; close < out.length; close++) {
            if (out[close] === "(") depth++
            else if (out[close] === ")" && --depth === 0) break
        }
        out = out.slice(0, at) + out.slice(open + 1, close) + out.slice(close + 1)
    }
}

function validLuau(name: string, code: string): void {
    try {
        parseLuau(code)
    } catch (error) {
        failures.push(`${name}\n    output is not valid Luau: ${(error as Error).message}\n${code}`)
    }
}

/** Every Luau-only thing, as the node it parses to. Parsing the output with
 *  luau-parser only proves it is valid *Luau* — and Luau is a superset, so a
 *  `+=` left in by mistake would sail through. Without a Lua 5.1 interpreter to
 *  hand, walking the tree for what 5.1 has no syntax for is the next best
 *  thing, and it says exactly which construct survived. */
const LUAU_ONLY: Record<string, (node: Record<string, unknown>) => boolean> = {
    CompoundAssignmentStatement: () => true,
    ContinueStatement: () => true,
    IfElseExpression: () => true,
    BinaryExpression: node => node.operator === "//",
    NumberLiteral: node => typeof node.raw === "string" && (node.raw.includes("_") || /^0[bB]/.test(node.raw)),
    FunctionDeclarationStatement: node => Array.isArray(node.attributes) && node.attributes.length > 0,
    LocalFunctionStatement: node => Array.isArray(node.attributes) && node.attributes.length > 0,
}

function validLua51(name: string, code: string): void {
    const found = new Set<string>()
    const walk = (value: unknown): void => {
        if (!value || typeof value !== "object") return
        if (Array.isArray(value)) return void value.forEach(walk)
        const node = value as Record<string, unknown>
        const rejects = typeof node.type === "string" ? LUAU_ONLY[node.type] : undefined
        if (rejects?.(node)) found.add(String(node.type) + (node.operator ? ` '${node.operator}'` : ""))
        for (const [key, child] of Object.entries(node)) {
            if (key !== "line" && key !== "column") walk(child)
        }
    }
    try {
        walk(parseLuau(code))
    } catch {
        return // validLuau reports the parse failure itself
    }
    if (found.size) {
        failures.push(`${name}\n    Lua 5.1 output still has: ${[...found].join(", ")}\n${code}`)
    }
}

/** Compile `source` and check its output, on one line. */
async function lowers(name: string, source: string, expected: string): Promise<void> {
    const result = await compile(source)
    if (result.code === undefined) {
        failures.push(`${name}\n    did not compile: ${result.diagnostics.map(d => `${d.line}:${d.column} ${d.message}`).join("; ")}`)
        return
    }
    validLuau(name, result.code)
    validLua51(name, result.code)
    check(name, unmarked(flat(result.code)), expected)
}

/** As `lowers`, with the arrays' bookkeeping left in. */
async function lowersMarked(name: string, source: string, expected: string): Promise<void> {
    const result = await compile(source)
    if (result.code === undefined) {
        failures.push(`${name}\n    did not compile: ${result.diagnostics.map(d => `${d.line}:${d.column} ${d.message}`).join("; ")}`)
        return
    }
    validLuau(name, result.code)
    check(name, flat(result.code), expected)
}

/** Everything Luau writes beyond Lua 5.1, as `@tilua-types/luau` says it. */
const LUAU_SYNTAX: LuaSyntax[] = [
    "compoundAssignment", "continue", "ifExpression", "floorDivision", "iteration", "attributes", "numberLiterals", "requireByPath",
]
const LUAU_LOWERING: LoadedLowering = { plugin: { syntax: LUAU_SYNTAX }, from: "luau" }

/** A type library like `@tilua-types/luau`: no types, and the syntax. A
 *  config names it by its path — `{ types: [LUAU] }`. */
const LUAU = (() => {
    const folder = mkdtempSync(join(tmpdir(), "tilua-luau-"))
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "luau-syntax", tilua: { types: "index.d.tilua", lowering: "lowering.mjs" } }))
    writeFileSync(join(folder, "index.d.tilua"), "")
    writeFileSync(join(folder, "lowering.mjs"), `export default { syntax: ${JSON.stringify(LUAU_SYNTAX)} }\n`)
    return folder
})()

/** As `lowers`, for Luau: with a library that says its Lua has Luau's syntax. */
async function lowersLuau(name: string, source: string, expected: string): Promise<void> {
    const result = await compile(source, { types: [LUAU] })
    if (result.code === undefined) {
        failures.push(`${name}\n    did not compile: ${result.diagnostics.map(d => `${d.line}:${d.column} ${d.message}`).join("; ")}`)
        return
    }
    validLuau(name, result.code)
    check(name, unmarked(flat(result.code)), expected)
}

/** Lower `source` and check its output, on one line — as `lowers`, and the
 *  output must also be Lua 5.1, which it is without a library saying more. */
function lowers51(name: string, source: string, expected: string): void {
    const program = parseTilua(source)
    const scopes = analyzeScopesTilua(program)
    const result = lower(program, scopes, { types: analyzeTypesTilua(program, scopes, { diagnostics: false }) })
    if (result.diagnostics.length) {
        failures.push(`${name}\n    did not lower: ${result.diagnostics.map(d => d.message).join("; ")}`)
        return
    }
    const code = printLuau(luau.program(result.statements))
    validLuau(name, code)
    validLua51(name, code)
    check(name, unmarked(flat(code)), expected)
}

/** Lowering refuses `source`, saying `reason`. */
function refuses51(name: string, source: string, reason: string): void {
    const program = parseTilua(source)
    const result = lower(program, analyzeScopesTilua(program), {})
    check(name, result.diagnostics.map(d => d.message.includes(reason)), [true])
}

// --- declarations ---------------------------------------------------------------
await lowers("const and let are local", "const a = 1\nlet b = 2", "local a = 1; local b = 2;")
await lowers("a declaration without a value", "let x", "local x;")
await lowers("types are dropped", "type P = { x: number }\ndeclare game: unknown\nconst n: number = 1 as number", "local n = 1;")
await lowers("satisfies and as const are dropped", "const t = { a: 1 } satisfies { a: number }\nconst u = [1] as const", "local t = { a = 1 }; local u = { 1 };")
// --- Lua 5.1's syntax, the default ---------------------------------------------
// What the compiler writes runs on Lua 5.1 to 5.4, LuaJIT and Luau: 5.1 has
// none of Luau's additions, and no `goto` to lower `continue` to.
{
    lowers51("lua51: compound assignment expands", "let a = 1\na += 2", "local a = 1; a = a + (2);")
    lowers51("lua51: concat assignment expands", "let s = \"a\"\ns += \"b\"", "local s = \"a\"; s = s .. (\"b\");")
    // `t[next()] += 1` must not advance twice: object and key are read once.
    lowers51("lua51: a compound assignment reads its target once",
        "const t = [1]\nlet i = 1\nt[i] += 2",
        "local t = { 1 }; local i = 1; do local target = t; local key = i; target[key] = target[key] + (2); end;")
    lowers51("lua51: floor division becomes math.floor", "const q = 7 // 2", "local q = math.floor(7 / (2));")
    // `c and a or b` is only right where the branch cannot be false or nil.
    lowers51("lua51: an if-else expression with literal arms is and/or",
        "const c = true\nconst v = c ? 1 : 2", "local c = true; local v = (c and 1 or 2);")
    lowers51("lua51: an if-else expression that could yield false becomes a call",
        "declare c: boolean\ndeclare a: boolean\ndeclare b: boolean\nconst v = c ? a : b",
        "local v = (function() if c then return a; else return b; end; end)();")
    lowers51("lua51: separators and binary literals are rewritten",
        "const big = 1_000_000\nconst bin = 0b1010", "local big = 1000000; local bin = 10;")
    // `repeat ... until true` runs once, so breaking out of it is `continue`.
    lowers51("lua51: continue becomes a break out of a one-pass repeat",
        "for (i = 1, 3) {\n  if (i == 1) { continue }\n  print(i)\n}",
        "for i = 1, 3 do repeat if i == 1 then break; end; print(i); until true; end;")
    // A real `break` would now leave only that repeat, so it raises a flag.
    lowers51("lua51: a break alongside a continue breaks the loop for real",
        "for (i = 1, 3) {\n  if (i == 1) { continue }\n  if (i == 2) { break }\n  print(i)\n}",
        "for i = 1, 3 do local broke = false; repeat if i == 1 then break; end; " +
        "if i == 2 then broke = true; break; end; print(i); until true; if broke then break; end; end;")
    lowers51("lua51: a loop with no continue is left alone",
        "for (i = 1, 3) {\n  if (i == 2) { break }\n  print(i)\n}",
        "for i = 1, 3 do if i == 2 then break; end; print(i); end;")
    // A `repeat`'s condition reads the body's locals; the inner repeat would
    // hide them, so that one combination is refused rather than miscompiled.
    refuses51("lua51: a repeat whose condition reads a body local is refused",
        "let n = 0\nrepeat {\n  const step = 1\n  n += step\n  if (n == 1) { continue }\n} until (n >= 3 and step == 1)",
        "cannot be compiled to Lua")
    lowers51("lua51: a repeat whose condition reads nothing from the body is fine",
        "let n = 0\nrepeat {\n  n += 1\n  if (n == 1) { continue }\n} until (n >= 3)",
        "local n = 0; repeat repeat n = n + (1); if n == 1 then break; end; until true; until n >= 3;")
}

// A name on a line of its own is written to ask the editor about it. Lua has
// no expression statement and it can run nothing, so it leaves no trace.
await lowers("a bare expression statement is dropped",
    "const value = 1\nvalue\nvalue + 1\nprint(value)",
    "local value = 1; print(value);")

// --- object destructuring --------------------------------------------------------
await lowers("reads straight from a name", "const { a, b } = value", "local a, b = value.a, value.b;")
await lowers("renames", "const { a: x, b: y } = value", "local x, y = value.a, value.b;")
await lowers("anything but a name is evaluated once",
    "const { a, b } = load()", "local ref = load(); local a, b = ref.a, ref.b;")
await lowers("defaults apply to nil",
    "const { a = 1 } = value", "local a = value.a; if a == nil then a = 1; end;")
await lowers("nested patterns keep their place in the read",
    "const { a, b: { c }, d } = value", "local a, ref, d = value.a, value.b, value.d; local c = ref.c;")
await lowers("a string key that is not a name",
    `const { "has-dash": dash } = value`, `local dash = value["has-dash"];`)
await lowers("a computed key is evaluated first",
    "const { [key()]: v } = value", "local key2 = key(); local v = value[key2];")
await lowers("rest takes the other keys",
    "const { a, ...others } = value",
    `local a = value.a; local others = {}; for key, value2 in pairs(value) do if key ~= "a" then others[key] = value2; end; end;`)
await lowers("destructuring what a call returns reads it once",
    "const { y } = f()", "local ref = f(); local y = ref.y;")

// --- array destructuring ---------------------------------------------------------
await lowers("arrays read by index", "const [first, second] = list", "local first, second = list[1], list[2];")
await lowers("holes are skipped", "const [, second] = list", "local second = list[2];")
// A method the value's metatable gives it is called with `.`, the value its
// `self`, and `.length` counts as `#` did.
await lowers("methods read with `.`, and length",
    "const s = \"abc\"\nprint(s.upper(s), s.length, \"ab\".length)",
    "local s = \"abc\"; print(s.upper(s), #s, #\"ab\");")
await lowers("a function a table holds is called as it is",
    "const t = { f: (n: number) => n }\nprint(t.f(1))",
    "local t = { f = function(n) return n; end }; print((t.f(1)));")
await lowers("array rest", "const [head, ...tail] = list", "local tilua_move = table.move or function(from, first, last, at, to) for i = first, last do to[at + i - first] = from[i]; end; return to; end; local head = list[1]; local tail = tilua_move(list, 2, #list, 1, {});")

// --- destructuring assignment ----------------------------------------------------
await lowers("assigns straight from a name", "let a = 1\nlet b = 2\n{ a, b } = value", "local a = 1; local b = 2; a, b = value.a, value.b;")
await lowers("assignment from anything else is scoped",
    "let a = 1\nlet b = 2\n{ a, b } = { a: b, b: a }", "local a = 1; local b = 2; do local ref = { a = b, b = a }; a, b = ref.a, ref.b; end;")
await lowers("an assignment's pattern takes indexes and members",
    "const t = [1, 2]\nconst o = { a: 0 }\nlet i = 1\nlet j = 2\n[t[i], t[j]] = [t[j], t[i]]\n{ a: o.a } = { a: 3 }",
    "local t = { 1, 2 }; local o = { a = 0 }; local i = 1; local j = 2; do local ref = { t[j], t[i] }; t[i], t[j] = ref[1], ref[2]; end; do local ref2 = { a = 3 }; o.a = ref2.a; end;")

// --- tables, arrays and strings --------------------------------------------------
await lowers("object literals", `const t = { a: 1, "b-c": 2, [k]: 3, d }`, `local t = { a = 1, ["b-c"] = 2, [k] = 3, d = d };`)
await lowers("array literals are tables", "const xs = [1, 2, 3]", "local xs = { 1, 2, 3 };")
await lowers("object spread copies in order",
    "const t = { a: 1, ...base, b: 2 }",
    `local function tilua_assign(target, ...) for i = 1, select("#", ...) do local source = (select(i, ...)); if source ~= nil then for key, value in pairs(source) do target[key] = value; end; local meta = type(source) == "table" and getmetatable(source) or nil; local getters = type(meta) == "table" and rawget(meta, "__tiluaGetters") or nil; if getters ~= nil then for key, get in pairs(getters) do target[key] = get(source); end; end; end; end; return target; end; local t = tilua_assign({}, { a = 1 }, base, { b = 2 });`)
await lowers("array spread joins the runs",
    "const xs = [f(), ...ys, g()]",
    `local tilua_move = table.move or function(from, first, last, at, to) for i = first, last do to[at + i - first] = from[i]; end; return to; end; local function tilua_concat(...) local result = {}; for i = 1, select("#", ...) do local part = select(i, ...); tilua_move(part, 1, #part, #result + 1, result); end; return result; end; local xs = tilua_concat({ (f()) }, ys, { g() });`)
// Luau only calls a method on a string in parentheses; tilua lets it go bare.
await lowers("a method call on a bare string gets its parentheses",
    `const a = "a":upper():rep(2)
print("b":lower())`, `local a = ("a"):upper():rep(2); print((("b"):lower()));`)
await lowers("a method call on a bare template string", "print(`${a}!`:upper())",
    `print((("%s!"):format(tostring(a)):upper()));`)
await lowers("interpolation becomes format", "print(`${a} any`)", `print((("%s any"):format(tostring(a))));`)
await lowers("interpolation escapes percent signs and keeps braces",
    "print(`${n}% of {total}`)", `print((("%s%% of {total}"):format(tostring(n))));`)
await lowers("a template without interpolation is a string", "print(`plain`)", `print("plain");`)

// --- functions -------------------------------------------------------------------
await lowers("function is a local function", "function f(a: number): number {\n    return a\n}", "local function f(a) return a; end;")
await lowers("parameter defaults", "function f(a = 1) {\n}", "local function f(a) if a == nil then a = 1; end; end;")
await lowers("destructured parameters",
    "function f({ x, y }, [z]) {\n}", "local function f(arg, arg2) local x, y = arg.x, arg.y; local z = arg2[1]; end;")
await lowers("methods keep ':' and drop the injected self",
    "holder = {}\nfunction holder:go(n: number) {\n    return self\n}", "holder = {}; function holder:go(n) return self; end;")
await lowers("function expressions", "const f = function(a = 2) { return a }", "local f = function(a) if a == nil then a = 2; end; return a; end;")

// --- statements and names --------------------------------------------------------
await lowers("for-in patterns", "const list = [{ name: \"a\" }]\nfor (const { name } of list) {\n    print(name)\n}",
    'local list = { { name = "a" } }; for _, item in ipairs(list) do local name = item.name; print(name); end;')
await lowers("if expressions", "const v = if a then 1 elseif b then 2 else 3", "local v = (a and 1 or (b and 2 or 3));")
await lowersLuau("luau: if expressions are Luau's own", "const v = if a then 1 elseif b then 2 else 3", "local v = if a then 1 elseif b then 2 else 3;")
await lowers("a Luau keyword used as a name", "let local = 1\nprint(t.local, local)", `local local_ = 1; print(t["local"], local_);`)
await lowers("generated names avoid the source's", "const ref = 1\nconst { a } = f()", "local ref = 1; local ref2 = f(); local a = ref2.a;")

await lowers("a table is walked for its values", "const list = [1, 2]\nfor (const v of list) { print(v) }",
    "local list = { 1, 2 }; for _, v in ipairs(list) do print(v); end;")
await lowers("for ... in: a table's keys, through pairs", "const o = { a: 1, b: 2 }\nfor (const k in o) { print(k, o[k]) }",
    "local o = { a = 1, b = 2 }; for k in pairs(o) do print(k, o[k]); end;")
await lowersLuau("luau: for ... in walks keys through pairs too", "const list = [1, 2]\nfor (const i in list) { print(i) }",
    "local list = { 1, 2 }; for i in pairs(list) do print(i); end;")
await lowersLuau("luau: a table is walked by Luau itself", "const list = [1, 2]\nfor (const v of list) { print(v) }",
    "local list = { 1, 2 }; for _, v in list do print(v); end;")
await lowers("an optional read of a key stops the chain",
    "declare maps: { [string]: { label: string } } | nil\ndeclare key: string\nconst named = maps?.[key]?.label",
    "local named = (function() local ref = maps; if ref == nil then return nil; end; ref = ref[key];"
    + " if ref == nil then return nil; end; return ref.label; end)();")
await lowers("an iterator function is the loop's own",
    "declare step: () => number | nil\nfor (const n of step) { print(n) }", "for n in step do print(n); end;")
await lowers("an iteration is the three Luau loops with, taken out of the array it is",
    "declare walk: [(s: nil, previous: number | nil) => number | nil, nil, nil]\nfor (const n of walk) { print(n) }",
    "local tilua_unpack = table.unpack or unpack; for n in tilua_unpack(walk, 1, 3) do print(n); end;")
await lowersLuau("what follows a return, break or continue is left out",
    "function f(x: number): number {\n    if (x > 1) {\n        return 1\n        print(\"dead\")\n    }\n    return x\n    print(x)\n}\nfor (i = 1, 3) {\n    if (i == 2) {\n        continue\n        print(i)\n    }\n    break\n    print(i)\n}",
    "local function f(x) if x > 1 then return 1; end; return x; end; for i = 1, 3 do if i == 2 then continue; end; break; end;")
await lowers("a module's code after its return is left out", "print(1)\nreturn\nconst y = 2\nprint(y)", "print(1); return;")
await lowers("attributes are Luau's, and left out", "@native\nfunction f(x: number): number {\n    return x\n}", "local function f(x) return x; end;")
await lowersLuau("luau: attributes are kept","@native\nfunction f(x: number): number {\n    return x\n}", "@native local function f(x) return x; end;")
await lowers("a shadowed global the output needs is captured first",
    "const table = {}\nconst [a, ...rest] = list\nprint(`${a}`)",
    `local tilua_table = table; local tilua_move = tilua_table.move or function(from, first, last, at, to) for i = first, last do to[at + i - first] = from[i]; end; return to; end; local table = {}; local a = list[1]; local rest = tilua_move(list, 2, #list, 1, {}); print((("%s"):format(tostring(a))));`)

check("a parse error leaves no output",
    ((r: { code?: string; diagnostics: unknown[] }) => [r.code, r.diagnostics.length > 0])(await compile("const = 1")), [undefined, true])
check("reassigning a const is an error",
    (await compile("const a = 1\na = 2")).diagnostics.map(d => d.message), ["Cannot assign to 'a' — it is a const"])
await lowers("import type is erased", `import type { Shape } from "./m"\nconst s: Shape = { r: 1 }`, "local s = { r = 1 };")
check("modules need a bundle",
    (await compile(`import { a } from "./m"`)).diagnostics.map(d => d.message), ["Imports and exports need a bundle: build the project with @tilua/compiler"])

// --- bundles ---------------------------------------------------------------------

const luauBinary = findLuau()

function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "tilua-compiler-"))
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), text)
    }
    return root
}

/** Run a bundle and return what it printed, or `undefined` without an interpreter. */
function run(name: string, result: BundleResult): string[] | undefined {
    if (result.code === undefined) {
        failures.push(`${name}\n    no bundle: ${result.diagnostics.map(d => `${d.line}:${d.column} ${d.message}`).join("; ")}`)
        return undefined
    }
    validLuau(name, result.code)
    if (!luauBinary) {
        skipped++
        return undefined
    }
    const file = join(mkdtempSync(join(tmpdir(), "tilua-run-")), "bundle.luau")
    writeFileSync(file, result.code)
    try {
        return execFileSync(luauBinary, [file], { encoding: "utf8" }).trim().split(/\r?\n/)
    } catch (error) {
        failures.push(`${name}\n    the bundle failed: ${(error as { stderr?: string }).stderr ?? error}`)
        return undefined
    }
}

function runs(name: string, result: BundleResult, expected: string[]): void {
    const output = run(name, result)
    if (output) check(name, output, expected)
}

// `+` joins strings, as in TypeScript: `..` where the types say so, a
// function asking the values where they cannot, and `+` for numbers.
await lowers("+ joins strings and adds numbers",
    "const s = \"a\"\nconst n = 1\nconst j = s + n + \"!\"\nconst k = n + n\nlet t = \"\"\nt += s",
    "local s = \"a\"; local n = 1; local j = (s .. n) .. \"!\"; local k = n + n; local t = \"\"; t = t .. (s);")
await lowersLuau("luau: += that joins is ..=",
    "let t = \"\"\nt += \"s\"", "local t = \"\"; t ..= \"s\";")
await lowers("+ with a side only the values can tell asks them",
    "function f(v: string | number) { return v + 1 }",
    "local function tilua_add(a, b) if type(a) == \"string\" or type(b) == \"string\" then return tostring(a) .. tostring(b); end; return a + b; end; local function f(v) return (tilua_add(v, 1)); end;")
runs("+: joins and additions run as in JavaScript", await compile([
    "const n = 3",
    "print(\"a\" + \"b\" == \"ab\", n + \"x\", \"x\" + n, n + n)",
    "print(1 + 2 + \"a\", \"a\" + 1 + 2, \"a\" + (1 + 2))",
    "function either(v: string | number): string | number { return v + 1 }",
    "print(either(1), either(\"1\"))",
    "let acc = \"\"",
    "for (i = 1, 3) { acc += i }",
    "print(acc)",
].join("\n")) as BundleResult, ["true\t3x\tx3\t6", "3a\ta12\ta3", "2\t11", "123"])

// `??=`, an object's methods, and labelled loops.
await lowers("??= assigns where the target is nil, reading what addresses it once",
    "let n: number | nil = nil\nn ??= 1\nconst t: { [string]: number } = {}\nt[tostring(n)] ??= 2",
    "local n = nil; if n == nil then n = 1; end; local t = {}; do local key = tostring(n); if t[key] == nil then t[key] = 2; end; end;")
await lowers("an object's method takes the object as its first parameter",
    "const o = {\n    n: 1,\n    get(): number { return this.n },\n}\nprint(o:get())",
    "local o = { n = 1, get = function(this) return this.n; end }; print((o:get()));")
await lowers("break outer raises a flag, and the loop it leaves breaks again",
    "outer: for (i = 1, 2) {\n    for (j = 1, 2) {\n        if (j == i) break outer\n    }\n}",
    "local outerBroke = false; for i = 1, 2 do for j = 1, 2 do if j == i then outerBroke = true; break; end; end; if outerBroke then break; end; end;")
runs("sugar: ??=, methods and labels run as in JavaScript", await compile([
    "let calls = 0",
    "function key(): string { calls += 1; return \"k\" }",
    "const t: { [string]: string } = {}",
    "t[key()] ??= \"first\"",
    "t[key()] ??= \"second\"",
    "print(t[\"k\"], calls)",
    "const Counter = {",
    "    count: 0,",
    "    increment(by: number): number {",
    "        this.count += by",
    "        return this:current()",
    "    },",
    "    current(): number { return this.count },",
    "}",
    "print(Counter:increment(2), Counter:increment(3))",
    "const visited: string[] = []",
    "rows: for (i = 1, 3) {",
    "    for (j = 1, 3) {",
    "        if (j == 2) continue rows",
    "        visited:push(`${i}${j}`)",
    "    }",
    "    visited:push(\"never\")",
    "}",
    "print(table.concat(visited, \",\"))",
    "let deep = 0",
    "a: while (true) {",
    "    while (true) {",
    "        while (true) {",
    "            deep += 1",
    "            break a",
    "        }",
    "    }",
    "}",
    "print(\"deep\", deep)",
    "const mixed: string[] = []",
    "o: for (i = 1, 3) {",
    "    try {",
    "        for (j = 1, 3) {",
    "            if (j == 2 and i == 2) continue o",
    "            if (i == 3) break o",
    "            mixed:push(`${i}${j}`)",
    "        }",
    "    } catch (e) { }",
    "}",
    "print(table.concat(mixed, \",\"))",
].join("\n")) as BundleResult, ["first\t2", "2\t5", "11,21,31", "deep\t1", "11,12,13,21"])

// `throw` and `try`: `error(value, 0)` and `pcall`, with a jump out of a
// `try` handed back as a code — and they run as JavaScript's do.
await lowers("throw is error at level 0", "throw \"NotFound\"", "error(\"NotFound\", 0);")
await lowers("try and catch is a pcall, and the catch runs in place",
    "try {\n    print(1)\n} catch (e) {\n    print(e)\n}",
    "local ok, result = pcall(function() print(1); end); if not ok then local e = result; print(e); end;")
await lowers("a promise's catch and finally are still methods",
    "const p = { catch: (s: unknown, f: unknown) => 1 }\np:catch(print)",
    "local p = { catch = function(s, f) return 1; end }; p:catch(print);")
runs("try: catch, finally, jumps out of it and nesting run as in JavaScript", await compile([
    "function parse(s: string): number {",
    "    const n = tonumber(s)",
    "    if (n == nil) { throw \"NotANumber\" }",
    "    return n",
    "}",
    "function safe(s: string): number {",
    "    try {",
    "        return parse(s)",
    "    } catch (e) {",
    "        print(\"caught\", e, e == \"NotANumber\")",
    "        return -1",
    "    } finally {",
    "        print(\"finally\", s)",
    "    }",
    "}",
    "print(safe(\"12\"), safe(\"x\"))",
    "let total = 0",
    "for (i = 1, 5) {",
    "    try {",
    "        if (i == 2) { continue }",
    "        if (i == 4) { break }",
    "        if (i == 3) { throw { code: i } }",
    "        total += i",
    "    } catch (e) {",
    "        print(\"table\", (e as { code: number }).code)",
    "    }",
    "}",
    "print(\"total\", total)",
    "function nested(): string {",
    "    try {",
    "        try { throw \"inner\" } finally { print(\"inner finally\") }",
    "    } catch (e) {",
    "        return `outer got ${e}`",
    "    }",
    "    return \"no\"",
    "}",
    "print(nested())",
    "function overrides(): number {",
    "    try { return 1 } finally { return 2 }",
    "}",
    "print(overrides())",
    "try {",
    "    try { throw \"escapes\" } finally { print(\"before it goes on\") }",
    "} catch (e) { print(\"then\", e) }",
].join("\n")) as BundleResult, [
    "finally\t12", "caught\tNotANumber\ttrue", "finally\tx", "12\t-1",
    "table\t3", "total\t1",
    "inner finally", "outer got inner",
    "2",
    "before it goes on", "then\tescapes",
])

// A library can do more than rename a call: `globalCall` and `globalValue`
// reach `print(x)` and a bare `print`, and every hook is told where the call
// was written and what the compiler knew about its arguments — the types and
// code that no longer exist at runtime. That is what `console:log` in
// @tilua-types/lua is built on.
{
    const seen: unknown[] = []
    const plugin: LoweringPlugin = {
        runtime: { log: "local __NAME__ = { lines = __LINES__ }" },
        methodCall(call) {
            if (call.receiverGlobal !== "console") return undefined
            seen.push(call.arguments.map(a => [a.typeText, a.source, a.declaration ?? null, a.spread]))
            return { callee: `${call.use("log")}.${call.method}`, prepend: [JSON.stringify(`${call.at.file}:${call.at.line}`)], passReceiver: false }
        },
        globalCall(call) {
            if (call.name !== "print") return undefined
            return { callee: `${call.use("log")}.print`, prepend: [`${call.at.line}`, `${call.at.column}`] }
        },
        globalValue(value) {
            return value.name === "print" ? `${value.use("log")}.printValue` : undefined
        },
    }
    const analyze = (code: string, extra: Partial<Parameters<typeof lower>[2]> = {}) => {
        const program = parseTilua(code)
        const scopes = analyzeScopesTilua(program)
        const result = lower(program, scopes, {
            source: code,
            file: "src/a.tilua",
            types: analyzeTypesTilua(program, scopes, { diagnostics: false }),
            lowerings: [{ plugin, from: "test" }],
            ...extra,
        })
        return { code: flat(printLuau(luau.program(result.statements))), diagnostics: result.diagnostics.map(d => d.message) }
    }

    check("lowering hooks: a method call on a global gets the call site prepended",
        analyze(`const double = (x: number) => x * 2\nconsole:log(double, "hi")`).code
            .endsWith(`tilua_log.log("src/a.tilua:2", double, "hi");`), true)
    check("lowering hooks: each argument's type, code, and declaration", seen, [[
        ["(x: number) => number", "double", "(x: number) => x * 2", false],
        ["\"hi\"", "\"hi\"", null, false],
    ]])
    check("lowering hooks: a runtime outside a bundle sees no line map",
        analyze(`console:log(1)`).code.startsWith("local tilua_log = { lines = nil }"), true)

    check("lowering hooks: a global call, and the same global read as a value", [
        analyze(`print(1)`).code.endsWith("tilua_log.print(1, 1, 1);"),
        analyze(`const p = print\np(1)`).code.endsWith("local p = tilua_log.printValue; p(1);"),
    ], [true, true])

    // A local of the same name is the author's, and no hook hears of it.
    check("lowering hooks: a local named like a global is left alone", [
        analyze("const console = { log: (self: unknown, n: number) => {} }\nconsole:log(1)").code.endsWith("console:log(1);"),
        analyze("function print(n: number) {}\nprint(1)").code.endsWith("print(1);"),
    ], [true, true])

    const broken: LoweringPlugin = { globalCall: () => ({ callee: "f", prepend: ["1 +"] }) }
    check("lowering hooks: Luau a library wrote that does not parse is reported",
        analyze(`print(1)`, { lowerings: [{ plugin: broken, from: "broken" }] }).diagnostics.map(m => m.split(":")[0]),
        ["'broken' lowered this to Luau that does not parse"])
}

// An error nothing caught — here `nil.value`, two modules deep — is reported
// in the project's files, with the way it got there, and then raised.
{
    const root = project({
        "tilua.config.json": JSON.stringify({ types: [] }),
        "src/util.tilua": "export function boom(t: any): any {\n    const inner = t.missing\n    return inner.value\n}\n",
        "src/main.tilua": `import { boom } from "./util"\nconst start = {}\nboom(start)\n`,
    })
    const result = await bundle({ entry: join(root, "src/main.tilua"), typeCheck: false })
    if (!luauBinary || result.code === undefined) {
        skipped++
    } else {
        const file = join(mkdtempSync(join(tmpdir(), "tilua-run-")), "bundle.luau")
        writeFileSync(file, result.code)
        let stderr = ""
        try {
            execFileSync(luauBinary, [file], { encoding: "utf8", stdio: "pipe" })
        } catch (error) {
            stderr = (error as { stderr?: string }).stderr ?? ""
        }
        check("bundle: an uncaught runtime error names the project's files", stderr.split(/\r?\n/).slice(0, 3), [
            "src/util.tilua:3: attempt to index nil with 'value'",
            "    at src/util.tilua:3 (boom)",
            "    at src/main.tilua:3 (load)",
        ])

        // The handler runs where an executor may have no `debug.info`, or
        // refuse it. A handler that fails leaves Luau only "error in error
        // handling", so it must not: the error is still mapped, from the
        // message's own position. Written on the bundle's first line, so no
        // line moves.
        const hostile = (name: string, prelude: string, expected: string[]) => {
            const altered = join(mkdtempSync(join(tmpdir(), "tilua-run-")), "bundle.luau")
            writeFileSync(altered, prelude + result.code)
            let said = ""
            try {
                execFileSync(luauBinary, [altered], { encoding: "utf8", stdio: "pipe" })
            } catch (error) {
                said = (error as { stderr?: string }).stderr ?? ""
            }
            check(name, said.split(/\r?\n/).slice(0, expected.length), expected)
        }
        hostile("bundle: an error is mapped with no debug.info", "debug = { traceback = debug.traceback }; ", [
            "src/util.tilua:3: attempt to index nil with 'value'",
            "    at src/util.tilua:3 (boom)",
        ])
        hostile("bundle: an error is mapped where debug.info refuses",
            "local tb = debug.traceback; debug = { info = function() error(\"restricted\") end, traceback = tb }; ", [
                "src/util.tilua:3: attempt to index nil with 'value'",
                "    at src/util.tilua:3 (boom)",
            ])
        hostile("bundle: an error is mapped with no debug library at all", "debug = {}; ", [
            "src/util.tilua:3: attempt to index nil with 'value'",
        ])
        // And if mapping itself breaks, the error as Luau raised it, and why.
        const brokenCode = result.code.replace(/^(local lines = \w+\.lines;)$/m, `$1 error("mapping broke");`)
        check("bundle: the mapping can be broken for the next check", brokenCode !== result.code, true)
        const broken = join(mkdtempSync(join(tmpdir(), "tilua-run-")), "bundle.luau")
        writeFileSync(broken, brokenCode)
        let said = ""
        try {
            execFileSync(luauBinary, [broken], { encoding: "utf8", stdio: "pipe" })
        } catch (error) {
            said = (error as { stderr?: string }).stderr ?? ""
        }
        const lines = said.split(/\r?\n/)
        check("bundle: an error the handler cannot map is still reported, with why", [
            /:\d+: attempt to index nil with 'value'$/.test(lines[0]),
            /^\(tilua could not map this error to the project's files: .*mapping broke\)$/.test(lines[1]),
            said.includes("error in error handling"),
        ], [true, true, false])
    }

    // `"lineMap": false`: no map, nothing that reads one, and the entry not
    // under `xpcall` — the error rises as Luau raised it, at the bundle's line.
    const bare = await bundle({ entry: join(root, "src/main.tilua"), typeCheck: false, lineMap: false })
    writeFileSync(join(root, "tilua.config.json"), JSON.stringify({ types: [], lineMap: false }))
    const configured = await bundle({ entry: join(root, "src/main.tilua"), typeCheck: false })
    check("lineMap: false leaves out the map and what reads it", [
        /\.lines\b|lineMap|describe|xpcall/.test(bare.code ?? "x.lines"),
        configured.code === bare.code,
        (bare.code ?? "").length < (result.code ?? "").length,
    ], [false, true, true])
    if (luauBinary && bare.code !== undefined) {
        const file = join(mkdtempSync(join(tmpdir(), "tilua-run-")), "bundle.luau")
        writeFileSync(file, bare.code)
        let stderr = ""
        try {
            execFileSync(luauBinary, [file], { encoding: "utf8", stdio: "pipe" })
        } catch (error) {
            stderr = (error as { stderr?: string }).stderr ?? ""
        }
        check("lineMap: false: an uncaught error names the bundle's line",
            /bundle\.luau:\d+: attempt to index nil with 'value'/.test(stderr.split(/\r?\n/)[0]), true)
    }
}

// The map is written packed, and read back the first time a line is looked
// up: every line of a big bundle, across files, and lines that go back up a
// file (a hoisted function), each read back where it was written.
{
    const { lineMapSource } = await import("../src/linemap.js")
    const origins = new Map<number, { file: string; line: number }>()
    for (let line = 1; line <= 3000; line += 1 + (line % 3)) {
        origins.set(line, { file: line % 7 ? "src/a.tilua" : "src\\b.tilua", line: (line * 37) % 5003 })
    }
    const source = lineMapSource(origins, "G.lineMap")
    check("line map: packed, it is a small part of what it was",
        source.length * 5 < [...origins].map(([n, o]) => `[${n}]={"${o.file}",${o.line}}`).join(",").length, true)
    if (luauBinary) {
        const result = await bundle({
            entry: join(project({ "src/main.tilua": "print(1)\n", "tilua.config.json": "{}" }), "src/main.tilua"),
            typeCheck: false,
        })
        // The bundle's own table, which the lines after it can still see.
        const G = /^(\w+) = \{\s*modules = /m.exec(result.code ?? "")?.[1] ?? "G"
        const probe = [...origins.keys()].filter((_, i) => i % 97 === 0).concat([2, 4000])
        const file = join(mkdtempSync(join(tmpdir(), "tilua-run-")), "bundle.luau")
        writeFileSync(file, [
            result.code ?? "",
            `local lines = ${source.replace("G.lineMap", `${G}.lineMap`)}`,
            ...probe.map(n => `do local o = lines[${n}]; print(${n}, o and o[1] or "-", o and o[2] or "-") end`),
        ].join("\n"))
        let said = ""
        try {
            said = execFileSync(luauBinary, [file], { encoding: "utf8", stdio: "pipe" })
        } catch (error) {
            said = `${(error as { stderr?: string }).stderr ?? ""}`
        }
        check("line map: Luau reads back every line where it was written",
            // After the bundle's own `print(1)`.
            said.trim().split(/\r?\n/).slice(1).map(l => l.split(/\t/).join(" ")),
            probe.map(n => {
                const o = origins.get(n)
                return o ? `${n} ${o.file.replace(/\\/g, "/")} ${o.line}` : `${n} - -`
            }))
    }
}

/** The line map a bundle carries, read as the bundle's `lineMap` reads it:
 *  bundle line -> `file:line`. */
function readLineMap(code: string): Map<number, string> {
    const map = new Map<number, string>()
    const call = /\.lines = \w+\.lineMap\(\{([^}]*)\},\s*"([^"]*)"\)/.exec(code)
    if (!call) return map
    const files = [...call[1].matchAll(/"([^"]*)"/g)].map(m => m[1])
    const data = call[2]
    let at = 0
    const read = (): number => {
        let value = 0, scale = 1, digit: number
        do {
            digit = VLQ_DIGITS.indexOf(data[at++])
            value += (digit % 32) * scale
            scale *= 32
        } while (digit >= 32)
        return value % 2 ? -Math.floor(value / 2) : Math.floor(value / 2)
    }
    let line = 0, file = 0, source = 0
    while (at < data.length) {
        line += read()
        file += read()
        source += read()
        map.set(line, `${files[file - 1]}:${source}`)
    }
    return map
}

// A bundle is one file, so a line in it says nothing about which of the
// project's files wrote it. The map is what `console:error` reads to answer
// that, and it is only worth having if every entry is right.
{
    const root = project({
        "tilua.config.json": JSON.stringify({ types: [], paths: {}, sourceMap: null }),
        "src/util.tilua": [
            "export function twice(n: number): number {",
            "    const doubled = n * 2",
            "    return doubled",
            "}",
        ].join("\n"),
        "src/main.tilua": [
            `import { twice } from "./util"`,
            "const start = 2",
            "print(twice(start))",
        ].join("\n"),
    })
    const result = await bundle({ entry: join(root, "src/main.tilua"), typeCheck: false })
    const code = result.code ?? ""
    const lines = code.split("\n")
    const map = readLineMap(code)
    // Every mapped line, as `what the bundle says` -> `where it was written`.
    const resolved = [...map].sort((a, b) => a[0] - b[0])
        .map(([line, origin]) => `${(lines[line - 1] ?? "").trim()} -> ${origin}`)
    check("line map: each bundled line points back at the source that wrote it", resolved, [
        "print((util.twice(start))); -> src/main.tilua:3",
        "function exports.twice(n) -> src/util.tilua:1",
        "local doubled = n * 2; -> src/util.tilua:2",
        "return doubled; -> src/util.tilua:3",
    ])
}

/** Run a bundle that should fail, and check its error mentions `message`. */
function fails(name: string, result: BundleResult, message: string): void {
    if (result.code === undefined) {
        failures.push(`${name}\n    no bundle: ${result.diagnostics.map(d => d.message).join("; ")}`)
        return
    }
    validLuau(name, result.code)
    if (!luauBinary) {
        skipped++
        return
    }
    const file = join(mkdtempSync(join(tmpdir(), "tilua-run-")), "bundle.luau")
    writeFileSync(file, result.code)
    try {
        execFileSync(luauBinary, [file], { encoding: "utf8", stdio: "pipe" })
        failures.push(`${name}\n    the bundle ran without an error`)
    } catch (error) {
        const output = `${(error as { stderr?: string }).stderr ?? ""}${(error as { stdout?: string }).stdout ?? ""}`
        check(name, output.includes(message), true)
        if (!output.includes(message)) failures.push(`    got: ${output.trim()}`)
    }
}

{
    const root = project({
        "tilua.config.json": JSON.stringify({ types: [], paths: { "@/*": ["src/*"] }, sourceMap: null }),
        "src/main.tilua": `import { twice } from "./math"\nimport { NAME } from "@/names"\nprint(twice(21), NAME)\n`,
        "src/math.tilua": "export function twice(n: number): number {\n    return n * 2\n}\n",
        "src/names.tilua": `export const NAME = "tilua"\n`,
    })
    const result = await bundle({ entry: join(root, "src/main.tilua") })
    check("bundle: every module the entry reaches, named from the config's folder",
        result.modules, ["src/main", "src/math", "src/names"])
    runs("bundle: imports through relative paths and aliases", result, ["42\ttilua"])
}

{
    // a imports b, which imports a back while a is still loading.
    const root = project({
        "main.tilua": `import { a1, counter, bump } from "./a"\nprint("main", a1())\nbump()\nbump()\nprint("counter", counter)\n`,
        "a.tilua": [
        "import { readLate } from \"./b\"",
        "export let counter = 0",
        "export function a1(): string { return \"a1\" }",
        "export function hoisted(): string { return \"hoisted\" }",
        "export function bump() { counter += 1 }",
        "export const late = \"late\"",
        "print(\"a sees\", readLate())",
        "",
        "",
    ].join("\n"),
        "b.tilua": [
        "import { hoisted, late } from \"./a\"",
        "print(\"b during the cycle\", hoisted())",
        "export function readLate(): string { return late }",
        "",
        "",
    ].join("\n"),
    })
    runs("bundle: a cycle sees hoisted functions at once, and later values live",
        await bundle({ entry: join(root, "main.tilua"), config: { types: [] } }),
        ["b during the cycle\thoisted", "a sees\tlate", "main\ta1", "counter\t2"])
}

{
    // Reading what the other module has not initialized yet is an error, as in ES modules.
    const root = project({
        "main.tilua": `import { value } from "./a"\nprint(value)\n`,
        "a.tilua": `import { early } from "./b"\nexport const value = early\n`,
        "b.tilua": `import { value } from "./a"\nexport const early = value\n`,
    })
    fails("bundle: a value read across a cycle before it is initialized is an error",
        await bundle({ entry: join(root, "main.tilua"), config: { types: [] } }),
        "Cannot access 'value' before initialization: 'a' has not reached it yet")
}

{
    // Re-exports are references: a later change shows through them.
    const root = project({
        "main.tilua": `import { count, bump } from "./re"\nimport * as All from "./all"\nprint(count, All.count)\nbump()\nprint(count, All.count)\n`,
        "state.tilua": `export let count = 0\nexport function bump() { count += 1 }\n`,
        "re.tilua": `export { count, bump } from "./state"\n`,
        "all.tilua": `export * from "./state"\n`,
    })
    runs("bundle: re-exports and export * stay live",
        await bundle({ entry: join(root, "main.tilua"), config: { types: [] } }), ["0\t0", "1\t1"])
}

{
    const root = project({
        "main.tilua": `import * as Util from "./util"\nprint(Util.twice(4), Util.NAME, Util.default)\n`,
        "util.tilua": `export function twice(n: number): number { return n * 2 }\nexport const NAME = "util"\nexport default true\n`,
    })
    runs("bundle: import * as", await bundle({ entry: join(root, "main.tilua"), config: { types: [] } }), ["8\tutil\ttrue"])
}

{
    const root = project({
        "main.tilua": `import { value } from "./m"\nvalue = 2\n`,
        "m.tilua": `export let value = 1\n`,
    })
    const result = await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })
    check("bundle: assigning to an import is an error, and leaves no bundle",
        [result.code, result.diagnostics.map(d => [d.category, d.message])],
        [undefined, [["scope", "Cannot assign to 'value' — it is an import"]]])
}

{
    const root = project({
        "main.tilua": `import { later, set } from "./m"\nprint(later)\nset()\nprint(later)\n`,
        "m.tilua": `export let later\nexport function set() { later = "set" }\n`,
    })
    runs("bundle: `export let` without a value is initialized to nil",
        await bundle({ entry: join(root, "main.tilua"), config: { types: [] } }), ["nil", "set"])
}

{
    const root = project({
        "main.tilua": `import def, { x as y } from "./m"\nimport { all } from "./re"\nprint(def.v, y, all)\n`,
        "m.tilua": `export const x = "x"\nexport default { v: "default" }\n`,
        "re.tilua": `export * from "./m"\nexport { x as all } from "./m"\n`,
    })
    runs("bundle: default, renamed and re-exported names",
        await bundle({ entry: join(root, "main.tilua"), config: { types: [] } }), ["default\tx\tx"])
}

{
    const root = project({
        "main.tilua": `import { Shape } from "./types"\nimport { value } from "./values"\nconst s: Shape = { r: value }\nprint(s.r)\n`,
        "types.tilua": "export type Shape = { r: number }\n",
        "values.tilua": "export const value = 3\n",
    })
    const result = await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })
    check("bundle: a module imported only for types is left out", result.modules, ["main", "values"])
    runs("bundle: and the rest still runs", result, ["3"])
}

{
    // `import type` is erased whatever it names: even a module whose code
    // would run is never required for it.
    const root = project({
        "main.tilua": `import type { Shape, noisy } from "./noisy"\nimport type * as N from "./noisy"\nconst s: Shape = { r: 1 }\nconst f: typeof noisy = function() {}\nconst n: N.Shape = s\nprint(s.r, n.r)\n`,
        "noisy.tilua": `print("noisy ran")\nexport type Shape = { r: number }\nexport function noisy() {}\n`,
    })
    const result = await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })
    check("bundle: a module reached only through import type is left out", result.modules, ["main"])
    runs("bundle: and never runs", result, ["1\t1"])
}

{
    const root = project({
        "main.tilua": `import type { value } from "./m"\nprint(value)\n`,
        "m.tilua": `export const value = 1\n`,
    })
    const result = await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })
    check("bundle: a type-only import used as a value is an error, and leaves no bundle",
        [result.code, result.diagnostics.map(d => [d.category, d.message])],
        [undefined, [["scope", "'value' is imported with 'import type' and can only be used as a type"]]])
}

{
    const root = project({ "main.tilua": `export const answer = 42\n` })
    const result = await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })
    check("bundle: an entry that exports returns its exports", flat(result.code ?? "").endsWith(`return result;`), true)
    // Run under `xpcall`, so an error nothing caught is reported in the
    // project's files before it is raised again.
    check("bundle: the entry runs under xpcall", flat(result.code ?? "").includes(
        `local ok, result = xpcall(function() return G.require("main"); end, G.fail); if not ok then error(result, 0); end`), true)
}

{
    const root = project({ "main.tilua": `import { nope } from "./missing"\nprint(nope)\n` })
    const result = await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })
    check("bundle: a module that cannot be found leaves no bundle",
        [result.code, result.diagnostics.map(d => [d.category, d.message])],
        [undefined, [["module", "Cannot find module './missing'"]]])
}

{
    const root = project({ "main.tilua": `const n: number = "text"\nprint(n)\n` })
    const result = await bundle({ entry: join(root, "main.tilua"), config: { types: ["./defs.d.tilua"] } })
    check("bundle: type errors are reported and the bundle is still written",
        [result.code !== undefined, result.diagnostics.filter(d => d.category === "type").map(d => d.message)],
        [true, [`Type '"text"' is not assignable to 'number'`]])
}

{
    // An iteration is `[step, state, first]` — an array like any other, which
    // the loop takes the three of, rather than a table it walks the values of.
    const root = project({
        "main.tilua": [
            `const names = ["a", "b"]`,
            `type Walk = [(t: string[], previous: [number, string] | nil) => [number, string] | nil, string[], nil]`,
            `const walk: Walk = [function(t, previous) {`,
            `    const i = if previous == nil then 1 else previous[1] + 1`,
            `    const name = t[i]`,
            `    if (name == nil) { return nil }`,
            `    return [i, name]`,
            `}, names, nil]`,
            'for (const [i, name] of walk) { print(`${i}${name}`) }',
        ].join("\n") + "\n",
    })
    const result = await bundle({ entry: join(root, "main.tilua") })
    check("an iteration is looped with as its three parts",
        result.code?.includes("for item in tilua_unpack(walk, 1, 3) do"), true)
    runs("an iteration walks what its steps answer", result, ["1a", "2b"])
}

{
    // Most of the language in one program, checked by what it prints.
    const root = project({
        "main.tilua": [
            `import { Stack } from "./stack"`,
            `type Point = { x: number, y: number }`,
            `const table = { note: "shadows the global" }`,
            `const point: Point = { x: 1, y: 2 }`,
            `const { x, y: py = 9, ...others } = { ...point, z: 3, w: 4 }`,
            `let count = 0`,
            // A table is walked as it is. Not `pairs(others)`: with no library
            // that is Luau's own, answering three values where tilua has one.
            `for (const value of others) { count += 1 }`,
            `const [first, , third = "three", ...tail] = ["one", "two", nil, "four", "five"]`,
            `function sum({ a, b = 10 }: { a: number, b?: number }, scale = 1): number {`,
            `    return (a + b) * scale`,
            `}`,
            `const values = [0, ...[1, 2], sum({ a: 1 }), sum({ a: 1, b: 1 }, 2)]`,
            `let total = 0`,
            `for (const v of values) { total += v }`,
            `const stack = Stack.new()`,
            `stack:push(5)`,
            `const label = if total > 10 then "big" else "small"`,
            `let a = 1`,
            `let b = 2`,
            `{ a, b } = { a: b, b: a }`,
            `print(\`\${x} \${py} \${count} \${first} \${third} \${tail.length} \${total} \${label} \${stack:size()} \${a}\${b} 100%\`, table.note, ...scriptArgs)`,
        ].join("\n"),
        "stack.tilua": [
        "export const Stack = {}",
        "Stack.__index = Stack",
        "function Stack.new() {",
        "    return setmetatable({ items: [] }, Stack)",
        "}",
        "function Stack:push(value: number) {",
        "    table.insert(self.items, value)",
        "}",
        "function Stack:size(): number {",
        "    return self.items.length",
        "}",
        "",
        "",
    ].join("\n"),
    })
    runs("bundle: the language at runtime",
        await bundle({ entry: join(root, "main.tilua"), config: { types: [] } }),
        ["1 2 2 one three 2 18 big 1 21 100%\tshadows the global"])
}

{
    const root = project({ "main.tilua": `const G = 1\nprint(G)\n` })
    runs("bundle: the module table avoids the modules' names",
        await bundle({ entry: join(root, "main.tilua"), config: { types: [] } }), ["1"])
}

{
    const root = project({
        "main.tilua": [
        "type Node = { name: string, child: Node | nil, greet: (self: Node, suffix: string) => string, pair: () => [number, number] }",
        "let reads = 0",
        "let argued = 0",
        "function arg(): string {",
        "    argued += 1",
        "    return \"!\"",
        "}",
        "function make(name: string, child: Node | nil): Node {",
        "    return { name, child, greet: function(self: Node, suffix: string): string { return self.name + suffix }, pair: function(): [number, number] { return [1, 2] } }",
        "}",
        "const leaf = make(\"leaf\", nil)",
        "const root = make(\"root\", leaf)",
        "const none: Node | nil = nil",
        "function get(n: Node | nil): Node | nil {",
        "    reads += 1",
        "    return n",
        "}",
        "print(root?.name, none?.name, root?.child?.name, leaf?.child?.name)",
        "print(root?:greet(arg()), none?:greet(arg()), argued)",
        "print(get(root)?.child?.name, get(none)?.child?.name, reads)",
        "print(root?.child:greet(\"?\"), (none?.child) == nil)",
        "const [first, second] = root.pair()",
        "print(first, second)",
        "none?:greet(arg())",
        "root?.child?:greet(arg())",
        "get(root)?.child?:greet(arg())",
        "print(argued, reads)",
        "function spread(...nodes: (Node | nil)[]): string | nil {",
        "    return nodes[1]?.child?.name",
        "}",
        "print(spread(root), spread(nil))",
        "",
        "",
    ].join("\n"),
    })
    runs("bundle: optional chains",
        await bundle({ entry: join(root, "main.tilua"), config: { types: [] } }),
        [
            "root\tnil\tleaf\tnil",
            "root!\tnil\t1",
            "leaf\tnil\t2",
            "leaf?\ttrue",
            "1\t2",
            "3\t3",
            "leaf\tnil",
        ])
    const code = (await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })).code ?? ""
    check("bundle: an optional read on a name is a call, which any Lua has",
        code.includes("if root == nil then nil else root.name"), false)
    const forLuau = (await bundle({ entry: join(root, "main.tilua"), config: { types: [LUAU] } })).code ?? ""
    check("luau: an optional read on a name is an `if` expression",
        forLuau.includes("if root == nil then nil else root.name"), true)
}

// What a call means is the type library's to say: the compiler asks, the
// library answers with what to call instead and the Luau behind it.
{
    const lowering = [
        "const runtime = [",
        "    'local __NAME__ = {}',",
        "    'function __NAME__.first(t) return t[1] end',",
        "    'function __NAME__.shout(s) return string.upper(s) .. \"!\" end',",
        "].join('\\n')",
        "",
        "export default {",
        "    runtime: { own: runtime },",
        "    methodCall({ method, receiver, use }) {",
        "        const array = receiver?.kind === 'array' || receiver?.kind === 'tuple'",
        "        const text = receiver?.kind === 'primitive' && receiver.name === 'string'",
        "        const literal = receiver?.kind === 'literal' && receiver.base === 'string'",
        "        if (array && method === 'first') return { callee: `${use('own')}.first` }",
        "        if ((text || literal) && method === 'shout') return { callee: `${use('own')}.shout` }",
        "        return undefined",
        "    },",
        "}",
    ].join("\n")
    const manifest = (extra: Record<string, unknown> = {}): string => JSON.stringify({
        name: "@tilua-types/own",
        tilua: { types: "index.d.tilua", lowering: "lowering.mjs", ...extra },
    })
    const definitions = [
        "declare function print(...args: unknown[]): nil",
        // A library adds to the language's metatables, and lowers what it adds.
        "declare metatable<T> T[]: { __index: { first: (self: T[]) => T | nil, nope: (self: T[]) => T | nil } }",
        "declare metatable string: { __index: { shout: (self: string) => string } }",
    ].join("\n")

    const root = project({
        "node_modules/@tilua-types/own/package.json": manifest(),
        "node_modules/@tilua-types/own/index.d.tilua": definitions,
        "node_modules/@tilua-types/own/lowering.mjs": lowering,
        "main.tilua": `print(([3, 4]):first(), ("hi"):shout())`,
    })
    runs("bundle: a type library's own lowering",
        await bundle({ entry: join(root, "main.tilua"), config: { types: ["own"] } }), ["3\tHI!"])

    const claimed = (await bundle({ entry: join(root, "main.tilua"), config: { types: ["own"] } })).code ?? ""

    // Declared in the types but not lowered: left as a method call, for the
    // value itself to answer.
    const unclaimed = project({
        "node_modules/@tilua-types/own/package.json": manifest(),
        "node_modules/@tilua-types/own/index.d.tilua": definitions,
        "node_modules/@tilua-types/own/lowering.mjs": lowering,
        "main.tilua": "const v = ([1]):nope()\n",
    })
    const left = (await bundle({ entry: join(unclaimed, "main.tilua"), config: { types: ["own"] } })).code ?? ""

    // And with no library at all, nothing is lowered.
    const bare = project({ "main.tilua": "const v = ([1]):first()\n" })
    const plain = (await bundle({ entry: join(bare, "main.tilua"), config: { types: [] } })).code ?? ""

    check("bundle: the library's runtime is emitted once, and only what it claims", [
        claimed.includes("function tilua_own.first"),
        (claimed.match(/local tilua_own = /g) ?? []).length,
        left.includes(":nope()"),
        plain.includes(":first()"),
    ], [true, 1, true, true])

    // A module that will not load is reported, and the build goes on.
    const broken = project({
        "node_modules/@tilua-types/own/package.json": manifest(),
        "node_modules/@tilua-types/own/index.d.tilua": definitions,
        "node_modules/@tilua-types/own/lowering.mjs": "export default",
        "main.tilua": "const v = ([1]):first()\n",
    })
    const result = await bundle({ entry: join(broken, "main.tilua"), config: { types: ["own"] } })
    check("bundle: a lowering module that will not load is a problem, not a crash", [
        result.diagnostics.some(d => d.message.includes("failed to load")),
        (result.code ?? "").includes(":first()"),
    ], [true, true])
}

{
    const root = project({
        "main.tilua": [
        "let argued = 0",
        "function arg(): string {",
        "    argued += 1",
        "    return \"!\"",
        "}",
        "const call: ((s: string) => string) | nil = function(s: string): string { return \"got\" + s }",
        "const none: ((s: string) => string) | nil = nil",
        "print(call?.(arg()), none?.(arg()), argued)",
        "none?.(arg())",
        "call?.(arg())",
        "print(argued)",
        "type Names = \"a\" | \"b\"",
        "const per = { a: function(): string { return \"A\" } } as const satisfies { [Names]: () => string }",
        "let key: Names = \"a\"",
        "print(per[key]?.())",
        "key = \"b\"",
        "print(per[key]?.())",
        "",
        "",
    ].join("\n"),
    })
    runs("bundle: optional calls",
        await bundle({ entry: join(root, "main.tilua"), config: { types: [] } }),
        ["got!\tnil\t1", "2", "A", "nil"])
}

{
    const root = project({
        "main.tilua": [
            `const a = 1`,
            `--@tilua-ignore`,
            `a = 2`,
            `const n: number = "x" --@tilua-expect-error covers the next line of code, not its own`,
            `--@tilua-expect-error`,
            `print(a)`,
        ].join("\n"),
        "quiet.tilua": `--@tilua-nocheck\nconst b = 1\nb = 2\nconst s: number = "x"\n`,
    })
    const loud = await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })
    check("bundle: directives suppress scope and type errors, and an unused expect-error is one",
        loud.diagnostics.map(d => `${d.line}: ${d.message}`),
        ["4: Type '\"x\"' is not assignable to 'number'", "4: Unused '@tilua-expect-error' directive", "5: Unused '@tilua-expect-error' directive"])
    const linted = await bundle({ entry: join(project({
        "main.tilua": [
            `declare n: number`,
            `--@tilua-expect-warning`,
            `print(n == "x")`,
            `--@tilua-expect-warning`,
            `print(n)`,
        ].join("\n"),
    }), "main.tilua"), config: { types: [] } })
    check("bundle: expect-warning takes a warning, and unused it is a warning",
        linted.diagnostics.map(d => `${d.line}: ${d.severity ?? "error"}: ${d.message}`),
        ["4: warning: Unused '@tilua-expect-warning' directive"])
    const unknown = project({
        "main.tilua": `counter = 1\nprint(counter)\nprint(typo)\n`,
        "defs.d.tilua": `declare function print(...args: unknown[]): nil\n`,
    })
    const withUnknown = await bundle({ entry: join(unknown, "main.tilua"), config: { types: ["./defs.d.tilua"] } })
    check("bundle: a name nothing declares is reported, and still builds",
        [withUnknown.diagnostics.map(d => d.message), withUnknown.code !== undefined], [["Cannot find name 'typo'"], true])
    const quiet = await bundle({ entry: join(root, "quiet.tilua"), config: { types: [] } })
    check("bundle: nocheck builds a file with scope errors", [quiet.diagnostics, quiet.code !== undefined], [[], true])
}

{
    const source = [
        "let Resource: ReturnType<typeof Load> | nil",
        "const early = parity(4)",
        "function Load() {",
        "    return { level: Config.level, even: parity(4) }",
        "}",
        "function parity(n: number): string {",
        "    function isEven(k: number): boolean {",
        "        if (k == 0) { return true }",
        "        return isOdd(k - 1)",
        "    }",
        "    function isOdd(k: number): boolean {",
        "        if (k == 0) { return false }",
        "        return isEven(k - 1)",
        "    }",
        "    return if isEven(n) then \"even\" else \"odd\"",
        "}",
        "const Config = { level: 3 }",
        "Resource = Load()",
        "print(early, Resource.level, Resource.even, parity(3))",
        "",
        "",
    ].join("\n")
    const root = project({ "main.tilua": source })
    runs("bundle: functions are hoisted, and see the module's later names",
        await bundle({ entry: join(root, "main.tilua"), config: { types: [] } }), ["even\t3\teven\todd"])
    // Outside a bundle: the same, as one file.
    const single = await compile(source)
    check("compile: a function used above its declaration is hoisted whole", single.diagnostics.map(d => d.message), [])
    if (single.code !== undefined) runs("compile: hoisted functions run", { code: single.code, diagnostics: [], modules: [] } as unknown as BundleResult, ["even\t3\teven\todd"])
}

{
    const root = project({
        "tags.tilua": [
            "export function Tags(a: number, b: number): boolean",
            "export function Tags(a?: number, b?: number): string",
            "export function Tags(a: number = 1, b?: number): string {",
            "    return tostring(a) + tostring(b)",
            "}",
            "",
            "",
        ].join("\n"),
        "main.tilua": `import { Tags } from "./tags"\nprint(Tags(1, 2))\n`,
        "defs.d.tilua": "declare function print(...args: unknown[]): nil\ndeclare function tostring(value: unknown): string\n",
    })
    runs("bundle: an exported overload set is one function",
        await bundle({ entry: join(root, "main.tilua"), config: { types: ["./defs.d.tilua"] } }), ["12"])
}

{
    const source = [
        "function Setup() {",
        "    let EventManager = {",
        "        Connections: [1, 2],",
        "        Count: function() {",
        "            return EventManager.Connections.length",
        "        }",
        "    }",
        "    return EventManager",
        "}",
        "function Sibling() {",
        "    const read = function() { return later }",
        "    const later = 7",
        "    return read()",
        "}",
        "const shadow = 1",
        "do {",
        "    const shadow = shadow + 1",
        "    print(Setup().Count(), Sibling(), shadow)",
        "}",
        "",
        "",
    ].join("\n")
    const root = project({ "main.tilua": source })
    runs("bundle: a closure reads the name its own value is bound to",
        await bundle({ entry: join(root, "main.tilua"), config: { types: [] } }), ["2\t7\t2"])
    const single = await compile(source)
    if (single.code !== undefined) {
        runs("compile: the same outside a bundle",
            { code: single.code, diagnostics: [], modules: [] } as unknown as BundleResult, ["2\t7\t2"])
    }
}

function findLuau(): string | undefined {
    const candidates = [process.env.LUAU, "luau"].filter((c): c is string => !!c)
    const empty = join(mkdtempSync(join(tmpdir(), "tilua-probe-")), "empty.luau")
    writeFileSync(empty, "")
    for (const candidate of candidates) {
        try {
            execFileSync(candidate, [empty], { stdio: "ignore" })
            return candidate
        } catch {
            // not this one
        }
    }
    return undefined
}

// A spread argument is `table.unpack` — directly when it is last, which is
// the only place Lua expands a list, and around the whole argument list
// otherwise.
await lowers("a spread argument last is Lua's own expansion",
    "declare xs: number[]\nf(1, ...xs)",
    "local tilua_unpack = table.unpack or unpack; f(1, tilua_unpack(xs));")
await lowers("a spread anywhere else builds the list first",
    "declare xs: number[]\nf(...xs, 1)",
    "local tilua_unpack = table.unpack or unpack; local tilua_move = table.move or function(from, first, last, at, to) for i = first, last do to[at + i - first] = from[i]; end; return to; end; local function tilua_concat(...) local result = {}; "
    + "for i = 1, select(\"#\", ...) do local part = select(i, ...); tilua_move(part, 1, #part, #result + 1, result); end; "
    + "return result; end; "
    + "f(tilua_unpack(tilua_concat(xs, { 1 })));")
// `...[a, b]` is the Luau pack `a, b`, written out rather than unpacked.
await lowers("a spread array literal is its values",
    "f(...[1, 2])\nf(0, ...[1, ...[2, 3]], 4)",
    "f(1, 2); f(0, 1, 2, 3, 4);")
await lowers("a spread literal's last call keeps every value when it ends the list",
    "f(...[1, g()])\nf(g(), 1)",
    "f(1, g()); f(g(), 1);")
await lowers("a spread literal's last call anywhere else stays an array",
    "f(...[1, g()], 2)",
    "local tilua_unpack = table.unpack or unpack; local tilua_move = table.move or function(from, first, last, at, to) for i = first, last do to[at + i - first] = from[i]; end; return to; end; local function tilua_concat(...) local result = {}; "
    + "for i = 1, select(\"#\", ...) do local part = select(i, ...); tilua_move(part, 1, #part, #result + 1, result); end; "
    + "return result; end; "
    + "f(tilua_unpack(tilua_concat({ 1 }, { g() }, { 2 })));")
await lowers("a spread array literal in an array is its values",
    "const xs = [0, ...[1, 2], 3]",
    "local xs = { 0, 1, 2, 3 };")
// A string's, an array's and a table's methods are the language's: with no
// library at all, the compiler lowers them into its own runtime. A string's
// Lua methods stay what they are.
{
    const lowered = await compile([
        "const names = [\"a\", \"bb\"]",
        "const long = names:filter(n => n.length > 1)",
        "const up = (\"x\"):upper()",
        "const trimmed = (\" x \"):trim()",
        "const keys = { b: 1, a: 2 }:keys()",
    ].join("\n"))
    const code = lowered.code ?? ""
    check("language methods: lowered with no library", [
        lowered.diagnostics.map(d => d.message),
        code.includes("tilua_array.filter(names,"),
        code.includes(":upper()"),
        code.includes("tilua_string.trim("),
        /tilua_object\.keys\(\{\s*"b",\s*"a"\s*\}, false,/.test(code),
        code.includes("function tilua_array.filter"),
        code.includes("function tilua_array.map"),
    ], [[], true, true, true, true, true, true])
}

// A table's `Object` methods: typed, and run.
{
    const root = project({
        "main.tilua": [
            "declare function setmetatable<T>(t: T, mt: unknown): T",
            "const base = setmetatable({ own: 1 }, { __index: { lent: 2 } })",
            "print(base:hasOwn(\"own\"), base:hasOwn(\"lent\"), base:hasOwnProperty(\"own\"))",
            "const merged = { a: 1 }:assign({ b: \"two\" }, { a: 3 })",
            "const a: number = merged.a",
            "const b: string = merged.b",
            "print(a, b)",
            // Four sources: past what the overloads spell out, and a nil skipped.
            "const many = { a: 1 }:assign({ b: 2 }, nil, { c: 3 }, { d: 4 })",
            "print(many:hasOwn(\"b\"), many:hasOwn(\"d\"))",
            "const point = { x: 1 }",
            "print(point:isFrozen())",
            "const frozen = point:freeze()",
            "print(frozen == point, point:isFrozen(), frozen.x)",
        ].join("\n"),
    })
    const result = await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })
    check("object methods: type-check", result.diagnostics.map(d => d.message), [])
    runs("object methods: hasOwn, assign, freeze, isFrozen", result, [
        "true\tfalse\ttrue", "3\ttwo", "true\ttrue", "false", "true\ttrue\t1",
    ])
    const readonly = await bundle({ entry: join(project({ "main.tilua": "const p = { x: 1 }:freeze()\np.x = 2\n" }), "main.tilua"), config: { types: [] } })
    check("object methods: what freeze answers is readonly",
        readonly.diagnostics.map(d => d.message), ["Cannot assign to 'x' because it is a read-only property"])
}

// Several results are an array — a table, returned and taken apart like any.
await lowers("several results are an array, and a destructuring reads it",
    [
        "function two(): [number, string] {",
        "    return [1, \"a\"]",
        "}",
        "const [n, s] = two()",
        "const both = two()",
        "",
        "",
    ].join("\n"),
    "local function two() return { 1, \"a\" }; end; local ref = two(); local n, s = ref[1], ref[2]; local both = two();")
// A call is one value: kept to one as an argument and in a `return`, typed
// or not. An array's last element takes every value — `[require(m)]` is how
// a program asks for them.
await lowers("a call is one value, and an array asks for all of them",
    "declare function typed(): number\nprint(1, untyped())\nprint(typed())\nfunction f() {\n    return untyped()\n}\nconst xs = [untyped()]",
    "print(1, (untyped())); print((typed())); local function f() return (untyped()); end; local xs = { untyped() };")
await lowers("`scriptArgs` is the script's own `...`, as an array",
    "const first = scriptArgs[1]",
    "local scriptArgs = { ... }; local first = scriptArgs[1];")

// A library puts its own function where a global stands — `pcall` answering
// `{ success, data, error }` — for a call and for the global read as a value,
// a member of a global table (`string.find`) included.
{
    const plugin: LoweringPlugin = {
        runtime: { result: "local __NAME__ = {}\nfunction __NAME__.pcall(...) return { ... } end\nfunction __NAME__.find(...) return { ... } end\n" },
        globalCall: ({ name, use }) => name === "pcall" ? { callee: `${use("result")}.pcall` }
            : name === "string.find" ? { callee: `${use("result")}.find` }
            : undefined,
        globalValue: ({ name, use }) => name === "pcall" ? `${use("result")}.pcall`
            : name === "string.find" ? `${use("result")}.find`
            : undefined,
    }
    const program = parseTilua([
        "declare function load(): number",
        "const result = pcall(load)",
        "const later = pcall",
        "const found = string.find(\"abc\", \"b\")",
        "const finder = string.find",
        "",
    ].join("\n"))
    const scopes = analyzeScopesTilua(program)
    const result = lower(program, scopes, { types: analyzeTypesTilua(program, scopes, {}), lowerings: [{ plugin, from: "test" }] })
    const code = flat(printLuau(luau.program(result.statements)))
    check("globals: a library's own function stands where the global did", [
        code.includes("local result = tilua_result.pcall(load);"),
        code.includes("local later = tilua_result.pcall;"),
        code.includes("local found = tilua_result.find(\"abc\", \"b\");"),
        code.includes("local finder = tilua_result.find;"),
    ], [true, true, true, true])
}

// Lua's standard library is always there, so is how it runs: `pcall` answers
// one value and `console:log` says where it was called, with no type library
// named — and with `noLib`, neither.
{
    const program = parseTilua("declare function load(): number\nconst result = pcall(load)\nconsole:log(result)\n")
    const scopes = analyzeScopesTilua(program)
    const lowered = (noLib: boolean): string => flat(printLuau(luau.program(lower(program, scopes, {
        types: analyzeTypesTilua(program, scopes, { noLib }), noLib, file: "src/a.tilua",
    }).statements)))
    const standard = lowered(false)
    check("standard library: lowered with no library named", [
        standard.includes("local result = tilua_result.pcall(load);"),
        standard.includes('tilua_console.log("[src/a:3]:", nil, result);'),
    ], [true, true])
    check("standard library: `noLib` leaves it out", lowered(true), "local result = pcall(load); console:log(result);")
}

// A rest parameter is Lua's `{...}` under a name: the function still takes
// `...`, and the array of it is a local.
await lowers("a rest parameter is the varargs, named",
    [
        "function join(sep, ...parts) {",
        "    return parts",
        "}",
        "",
        "",
    ].join("\n"),
    "local function join(sep, ...) local parts = { ... }; return parts; end;")

// --- classes ----------------------------------------------------------------
// What a class lowers to is one table per class and one table per instance,
// with the instance's metatable pointing at the class — so the only way to be
// sure is to run it.
{
    const root = project({
        "tilua.config.json": JSON.stringify({ types: [], sourceMap: null }),
        "shape.tilua": [
            "export class Shape {",
            "    name: string",
            "    sides = 0",
            "    static made = 0",
            "    constructor(name: string) {",
            "        this.name = name",
            "        Shape.made += 1",
            "    }",
            "    function area(): number {",
            "        return 0",
            "    }",
            "    function describe(): string {",
            "        return this.name + \" has area \" + tostring(this:area())",
            "    }",
            "    get label(): string {",
            "        return \"<\" + this.name + \">\"",
            "    }",
            "    set label(value: string) {",
            "        this.name = value",
            "    }",
            "    static function count(): number {",
            "        return Shape.made",
            "    }",
            "}",
            "",
            "",
            "",
        ].join("\n"),
        "main.tilua": [
            "import { Shape } from \"./shape\"",
            "",
            "class Square extends Shape {",
            "    side: number",
            "    sides = 4",
            "    constructor(side: number) {",
            "        super(\"square\")",
            "        this.side = side",
            "    }",
            "    function area(): number {",
            "        return this.side * this.side",
            "    }",
            "    function describe(): string {",
            "        return super.describe() + \" (square)\"",
            "    }",
            "}",
            "",
            "-- No constructor of its own: it takes what Square takes.",
            "class Tile extends Square {",
            "}",
            "",
            "const s = Square.new(3)",
            "print(s:describe())",
            "print(s.label, s.sides, s.side)",
            "s.label = \"box\"",
            "print(s:describe())",
            "",
            "const t = Tile.new(2)",
            "print(t:describe(), t.label)",
            "print(Shape.count(), Square.count(), Square.made)",
            "",
            "-- The instance points at the class, so a method added to the class",
            "-- afterwards is there on instances already built.",
            "print(getmetatable(s) == Square, getmetatable(t) == Tile)",
            "",
            "",
            "",
        ].join("\n"),
    })
    const result = await bundle({ entry: join(root, "main.tilua") })
    check("class: the bundle type-checks", result.diagnostics.map(d => d.message), [])
    runs("class: instances, inheritance, super, accessors and statics", result, [
        "square has area 9 (square)",
        "<square>\t4\t3",
        "box has area 9 (square)",
        "square has area 4 (square)\t<square>",
        "2\t2\t2",
        "true\ttrue",
    ])
}

// A static is set once the class is whole, top to bottom, as in TypeScript:
// one may build an instance, and a later one may read an earlier one.
runs("class: statics run after the methods and `new`, in order", await compile([
    "class Vec {",
    "    static zero = Vec.new(0, 0)",
    "    static unit = Vec.zero:plus(Vec.new(1, 1))",
    "    x: number",
    "    y: number",
    "    constructor(x: number, y: number) {",
    "        this.x = x",
    "        this.y = y",
    "    }",
    "    function plus(other: Vec): Vec {",
    "        return Vec.new(this.x + other.x, this.y + other.y)",
    "    }",
    "}",
    "print(Vec.zero.x, Vec.unit.y)",
].join("\n")) as BundleResult, ["0\t1"])

// The memory model, as the language promises it: an instance points at its
// class, a class points at the one it extends, and nothing is copied per
// instance. Only running it can show that.
{
    const root = project({
        "tilua.config.json": JSON.stringify({ types: [], sourceMap: null }),
        "box.tilua": [
            "export default class Box<T> {",
            "    value: T",
            "    constructor(value: T) {",
            "        this.value = value",
            "    }",
            "    function get(): T {",
            "        return this.value",
            "    }",
            "    function map<R>(f: (value: T) => R): Box<R> {",
            "        return Box.new(f(this.value))",
            "    }",
            "}",
            "",
            "",
            "",
        ].join("\n"),
        "main.tilua": [
            "import Box from \"./box\"",
            "",
            "class Base {",
            "    n = 1",
            "}",
            "class Derived extends Base {",
            "}",
            "",
            "const base = Base.new()",
            "const derived = Derived.new()",
            "print(base.ClassObject == Base, derived.ClassObject == Derived)",
            "print(Derived.ParentClass == Base, Base.ParentClass == nil)",
            "print(derived.ClassObject.ParentClass == Base)",
            "-- The class is one table, shared: nothing of it sits on an instance.",
            "print(rawget(derived, \"ClassObject\") == nil, rawget(derived, \"n\") == 1)",
            "",
            "const numbers = Box.new(41)",
            "print(numbers:get() + 1)",
            "print(numbers:map(function(n) { return tostring(n) + \"!\" }):get())",
            "",
            "class Ints extends Box<number> {",
            "    constructor(n: number) {",
            "        super(n)",
            "    }",
            "    function double(): number {",
            "        return this:get() * 2",
            "    }",
            "}",
            "print(Ints.new(21):double())",
            "",
            "const Counter = class {",
            "    n = 0",
            "    function bump(): number {",
            "        this.n += 1",
            "        return this.n",
            "    }",
            "}",
            "const counter = Counter.new()",
            "counter:bump()",
            "print(counter:bump(), counter.ClassObject == Counter)",
            "",
            "",
            "",
        ].join("\n"),
    })
    const result = await bundle({ entry: join(root, "main.tilua") })
    check("class: the bundle with generics, a class value and a default export type-checks",
        result.diagnostics.map(d => d.message), [])
    runs("class: an instance points at its class, and a class at the one it extends", result, [
        "true\ttrue",
        "true\ttrue",
        "true",
        "true\ttrue",
        "42",
        "41!",
        "42",
        "2\ttrue",
    ])
}

// A class with no accessors anywhere in its chain keeps the plain
// `__index = class` lookup: the metatable is the class table itself.
await lowers("class: the simple case is the plain Lua idiom",
    [
        "class Counter {",
        "    n = 0",
        "    function bump(): number {",
        "        this.n += 1",
        "        return this.n",
        "    }",
        "}",
        "",
        "",
    ].join("\n"),
    "local function tilua_class(base, name) local class = { __getters = {}, __setters = {} }; class.__index = class; "
    + "class.ClassObject = class; class.ParentClass = base; class.name = name; "
    + "if base ~= nil then setmetatable(class, { __index = base }); setmetatable(class.__getters, { __index = base.__getters }); "
    + "setmetatable(class.__setters, { __index = base.__setters }); for _, key in ipairs({ \"__add\", \"__sub\", \"__mul\", \"__div\", \"__idiv\", \"__mod\", \"__pow\", \"__unm\", \"__concat\", \"__len\", \"__eq\", \"__lt\", \"__le\", \"__call\", \"__tostring\", \"__iter\" }) do class[key] = base[key]; end; end; return class; end; "
    + "local function tilua_accessors(class) "
    + "if not class.__dynamic and next(class.__getters) == nil and next(class.__setters) == nil then return; end; "
    + "class.__dynamic = true; "
    + "class.__index = function(this, key) local getter = class.__getters[key]; if getter ~= nil then return getter(this); end; return class[key]; end; "
    + "class.__newindex = function(this, key, value) local setter = class.__setters[key]; if setter ~= nil then setter(this, value); return; end; rawset(this, key, value); end; "
    + "end; "
    + "local Counter = tilua_class(nil, \"Counter\"); "
    + "function Counter.bump(this) this.n = this.n + (1); return this.n; end; "
    + "function Counter.__init(this, ...) this.n = 0; end; "
    + "function Counter.new(...) local this = setmetatable({}, Counter); Counter.__init(this, ...); return this; end; "
    + "tilua_accessors(Counter);")

// `new` is the class's own `new`, and nothing more.
await lowers("class: new is a call of the class's own constructor",
    [
        "declare class Vec { x: number }",
        "declare Vec: { new: (x: number) => Vec }",
        "const v = Vec.new(1)",
    ].join("\n"),
    "local v = Vec.new(1);")

// `abstract` has nothing to lower: no `new` for the abstract class, no
// function for an abstract method. The class extending it has both.
{
    const result = await compile([
        "abstract class Shape {",
        "    abstract function area(): number",
        "    function twice(): number {",
        "        return this:area() * 2",
        "    }",
        "}",
        "class Unit extends Shape {",
        "    function area(): number {",
        "        return 1",
        "    }",
        "}",
        "print(Unit.new():twice())",
    ].join("\n"))
    const code = result.code ?? ""
    check("class: an abstract class has no `new`, and an abstract method no function", [
        result.diagnostics.length, code.includes("function Shape.new"), code.includes("function Shape.area"),
        code.includes("function Unit.new"), code.includes("function Unit.area"),
    ], [0, false, false, true, true])
}

// A metamethod is an ordinary function on the class table, which is what
// Luau reads it from.
{
    const result = await compile([
        "class Vec {",
        "    x: number",
        "    constructor(x: number) {",
        "        this.x = x",
        "    }",
        "    function __add(other: Vec): Vec {",
        "        return Vec.new(this.x + other.x)",
        "    }",
        "}",
        "class Named extends Vec {",
        "}",
        "print((Named.new(1) + Vec.new(2)).x)",
    ].join("\n"))
    check("class: a metamethod is a function on the class, and the helper copies it into a class extending it", [
        result.diagnostics.length, (result.code ?? "").includes("function Vec.__add(this, other)"),
        (result.code ?? "").includes("class[key] = base[key]"),
    ], [0, true, true])
    if (result.code) validLuau("class: metamethods lower to valid Luau", result.code)
}

// A second build in the same process keeps what has not changed — and must
// not keep what has. A module rewritten between builds is read again, types
// and all, and so is every module that imports it.
{
    const root = project({
        "main.tilua": `import { size } from "./box"\nconst n: number = size()\nprint(n)\n`,
        "box.tilua": `export function size(): number { return 1 }\n`,
    })
    const first = await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })
    // The same name, a different type: what imports it can no longer fit.
    await new Promise(resolve => setTimeout(resolve, 10))
    writeFileSync(join(root, "box.tilua"), `export function size(): string { return "1" }\n`)
    const second = await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })
    check("a rewritten module is analyzed again on the next build", [
        first.diagnostics.map(d => d.message),
        second.diagnostics.map(d => d.message),
        second.code?.includes('return "1"'),
    ], [
        [],
        ["Type 'string' is not assignable to 'number'"],
        true,
    ])
}

// --- typeof ---------------------------------------------------------------------
// Luau cannot tell an array from an object — both are tables — so every array
// the program makes is written down as one, and `typeof` looks there.
await lowersMarked("typeof: an array is written down as one where it is made",
    "const xs = [1]\nconst o = { a: 1 }",
    `${ARRAYS} local xs = tilua_asArray({ 1 }); local o = { a = 1 };`)
{
    const lowered = await compile("declare v: unknown\ndeclare a: number[] | nil\ndeclare o: { x: number }\nconst k = [typeof v, typeof a, typeof (o)]")
    const code = flat(lowered.code ?? "")
    check("typeof: a call of the runtime, told what the type already says", [
        lowered.diagnostics.map(d => d.message),
        code.includes("local function tilua_typeof(value, known) local name = (typeof or type)(value);"),
        code.includes("tilua_asArray({ tilua_typeof(v), tilua_typeof(a, \"array\"), tilua_typeof(o, \"object\") })"),
    ], [[], true, true])
    const program = parseTilua("const k = typeof v")
    const code51 = flat(printLuau(luau.program(lower(program, analyzeScopesTilua(program), {}).statements)))
    check("typeof: Luau's `typeof` where there is one, and `type` elsewhere", code51.includes("local name = (typeof or type)(value);"), true)
}
// One record for the whole bundle: an array another module made is one here.
{
    const root = project({
        "other.tilua": [
            "export function empty(): number[] {",
            "    return []",
            "}",
            "export function pass(...args: number[]) {",
            "    return args",
            "}",
        ].join("\n"),
        "main.tilua": [
            "import { empty, pass } from \"./other\"",
            "const name = (v: unknown) => typeof v",
            "print(name([]), name({}), name([1]), name({ a: 1 }))",
            "print(name(empty()), name(pass(1, 2)), name(pass()))",
            "print(name(nil), name(1), name(\"s\"), name(true), name(print))",
            "const xs = [1, 2]",
            "print(name(xs:filter(x => x > 5)), name(xs:map(x => x)), name({ a: 1 }:keys()))",
            "const [first, ...rest] = [1]",
            "print(name(rest), name([...rest]))",
            "class A { }",
            "print(name(A.new()))",
            "print(typeof xs, typeof { a: 1 }, typeof (xs) == \"array\")",
            "print(name(scriptArgs))",
            "const v: unknown = xs",
            "if (typeof v == \"array\") {",
            "    print(v.length)",
            "}",
        ].join("\n"),
    })
    const result = await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })
    check("typeof: type-check", result.diagnostics.map(d => d.message), [])
    runs("typeof: arrays and objects, empty ones included", result, [
        "array\tobject\tarray\tobject",
        "array\tarray\tarray",
        "nil\tnumber\tstring\tboolean\tfunction",
        "array\tarray\tarray",
        "array\tarray",
        "object",
        "array\tobject\ttrue",
        "array",
        "2",
    ])
}

// --- import() and output in several files -----------------------------------------
//
// `import("./x")` is the bundle's `import`, a wrapper around its `require`. With
// `output` the bundle is more than one file, and `require` loads the file a
// module is in the first time it is asked for — so these are run from disk,
// written as the bundler names them. `LUA51` naming a Lua 5.1 interpreter runs
// each of them built for that target as well.

/** Write every file of `result` where it says, and run the entry's. */
function runFiles(name: string, result: BundleResult, binary: string | undefined): string[] | undefined {
    if (result.code === undefined) {
        failures.push(`${name}\n    no bundle: ${result.diagnostics.map(d => `${d.line}:${d.column} ${d.message}`).join("; ")}`)
        return undefined
    }
    for (const file of result.files) validLuau(`${name} (${file.path})`, file.code)
    if (!binary) {
        skipped++
        return undefined
    }
    const folder = mkdtempSync(join(tmpdir(), "tilua-files-"))
    for (const file of result.files) {
        mkdirSync(dirname(join(folder, file.path)), { recursive: true })
        writeFileSync(join(folder, file.path), file.code)
    }
    const entryFile = join(folder, result.files[0].path)
    try {
        // From the entry's own folder: Luau reads a `require`d path from the
        // file that asks, and names that file from where it was started.
        return execFileSync(binary, [basename(entryFile)], { encoding: "utf8", stdio: "pipe", cwd: dirname(entryFile) }).trim().split(/\r?\n/)
    } catch (error) {
        const { stdout, stderr } = error as { stdout?: string; stderr?: string }
        return `${stdout ?? ""}\n${stderr ?? ""}`.trim().split(/\r?\n/)
    }
}

{
    const files = {
        "tilua.config.json": JSON.stringify({ types: [] }),
        "src/main.tilua": [
            `import { clamp } from "./util"`,
            `print("main", clamp(5, 0, 3))`,
            `function open() {`,
            `    const shop = import("./shop/buy")`,
            `    print("price", shop.price("hat"), shop.default)`,
            `    return shop`,
            `}`,
            `print("same", open() == import("./shop/buy"))`,
            `print(import("./extra").describe())`,
            `import("./side")`,
            `print(import("./util").clamp(-4, 0, 3), scriptArgs.length)`,
        ].join("\n"),
        "src/util.tilua": `export function clamp(x: number, lo: number, hi: number): number {\n    if (x < lo) { return lo }\n    if (x > hi) { return hi }\n    return x\n}\n`,
        "src/shop/buy.tilua": `import { clamp } from "../util"\nimport { tax } from "./tax"\nprint("buy loaded")\nexport function price(name: string): number {\n    return clamp(name.length * 10, 0, 25) + tax()\n}\nexport default "shop"\n`,
        "src/shop/tax.tilua": `print("tax loaded")\nexport function tax(): number { return 2 }\n`,
        "src/extra.tilua": `import { tax } from "./shop/tax"\nexport function describe(): string {\n    return \`extra \${tax()}\`\n}\n`,
        "src/side.tilua": `print("side", scriptArgs.length)\n`,
    }
    const root = project(files)
    const entry = join(root, "src/main.tilua")
    const expected = ["main\t3", "tax loaded", "buy loaded", "price\t27\tshop", "same\ttrue", "extra 2", "side\t0", "0\t0"]

    const single = await bundle({ entry })
    check("import(): one file by default", single.files.map(f => f.path), ["main.luau"])
    check("import(): the bundle's import, called with the module's name",
        single.code?.includes(`G.import("src/shop/buy")`) && single.code.includes("import = function(name)"), true)
    check("import(): a statement of its own still loads the module", single.code?.includes(`G.import("src/side");`), true)
    runs("import(): loads a module when it runs, once", single, expected)

    const plain = await bundle({ entry: join(project({ "main.tilua": `import { a } from "./a"\nprint(a)\n`, "a.tilua": `export const a = 1\n` }), "main.tilua"), config: { types: [] } })
    check("import(): a bundle that writes none has no wrapper", plain.code?.includes("import = function"), false)

    // Luau loads another file with `require` by path; the interpreter these
    // run on is Luau's, which has no `loadfile`.
    const chunks = await bundle({ entry, output: "chunks", outFile: "game.luau", root, config: { types: [LUAU] } })
    check("chunks: what only an import() reaches gets a file, and what two share another",
        chunks.files.map(f => [f.path, f.modules]), [
            ["game.luau", ["src/main", "src/util"]],
            ["game_src_shop_buy.luau", ["src/shop/buy"]],
            ["game_src_extra.luau", ["src/extra"]],
            ["game_src_side.luau", ["src/side"]],
            ["game_shared.luau", ["src/shop/tax"]],
        ])
    check("chunks: the entry's file says where the others are",
        chunks.code?.includes(`["src/shop/tax"] = "./game_shared"`), true)
    check("chunks: every other file is a function over the bundle's table",
        chunks.files[1]?.code.startsWith("return function(G)"), true)
    check("chunks: the same program", runFiles("chunks: the same program", chunks, luauBinary) ?? expected, expected)

    const modules = await bundle({ entry, output: "modules", root, config: { types: [LUAU] } })
    check("modules: a file for each, in the project's tree", modules.files.map(f => f.path),
        ["src/main.luau", "src/util.luau", "src/shop/buy.luau", "src/extra.luau", "src/side.luau", "src/shop/tax.luau"])
    check("modules: named from the entry's own file", modules.code?.includes(`["src/shop/tax"] = "./shop/tax"`), true)
    check("modules: the same program", runFiles("modules: the same program", modules, luauBinary) ?? expected, expected)

    const configured = await bundle({ entry: join(project({ ...files, "tilua.config.json": JSON.stringify({ types: [], output: "chunks" }) }), "src/main.tilua") })
    check("output: the config's, without an option", configured.files.length, 5)

    // Without a library saying more, another file is loaded with
    // `loadfile`, which every Lua but Luau has.
    const lua51Binary = process.env.LUA51
    for (const output of ["single", "chunks", "modules"] as const) {
        const built = await bundle({ entry, output })
        check(`lua51: ${output}, loaded with loadfile`, output === "single" || built.code?.includes("loadfile(folder .. file)"), true)
        if (lua51Binary) check(`lua51: ${output} runs`, runFiles(`lua51: ${output} runs`, built, lua51Binary), expected)
    }
}

// An error in a file that is not the entry's is still reported in the project's.
{
    const root = project({
        "tilua.config.json": JSON.stringify({ types: [] }),
        "src/main.tilua": `function boom() {\n    import("./shop/broken").fail(nil)\n}\nboom()\n`,
        "src/shop/broken.tilua": `export function fail(inner: any) {\n    return inner.value\n}\n`,
    })
    for (const output of ["chunks", "modules"] as const) {
        const ran = runFiles(`${output}: an error in another file`, await bundle({ entry: join(root, "src/main.tilua"), output, root, config: { types: [LUAU] } }), luauBinary)
        if (ran) {
            check(`${output}: an error in another file names the project's`, ran.slice(0, 4), [
                "src/shop/broken.tilua:2: attempt to index nil with 'value'",
                "    at src/shop/broken.tilua:2 (fail)",
                "    at src/main.tilua:2 (boom)",
                "    at src/main.tilua:4 (load)",
            ])
        }
    }
}

{
    const root = project({
        "main.tilua": `const name = "./a"\nconst a = import("./missing")\nconst b = import(name)\n`,
    })
    const result = await bundle({ entry: join(root, "main.tilua"), config: { types: [] } })
    check("import(): a module that is not there, and one not named by a literal",
        [result.code, result.diagnostics.filter(d => d.category === "module").map(d => `${d.line}:${d.column} ${d.message}`)],
        [undefined, [
            "2:18 Cannot find module './missing'",
            "3:18 import() takes a string literal: which module it loads is decided when the project is built",
        ]])
    const alone = await compile(`const a = import("./a")\n`)
    check("import(): needs a bundle", [alone.code, alone.diagnostics.map(d => d.message)],
        [undefined, ["import() needs a bundle: build the project with @tilua/compiler"]])
}

// --- Lua 5.1 at runtime -------------------------------------------------------------
//
// Valid Lua 5.1 is not yet Lua 5.1 that runs: `for _, v in list do` parses, and
// then calls a table. So what a Lua with Luau's syntax would do itself is
// looked at here as text, and — with `LUA51` naming a Lua 5.1 interpreter —
// the same program, built for Lua and for Luau, has to print the same thing.
{
    // Which it is, the types say: without them every table goes the long way.
    const program = parseTilua("const list = [1, 2]\nfor (const v of list) { print(v) }")
    const scopes = analyzeScopesTilua(program)
    const result = lower(program, scopes, { types: analyzeTypesTilua(program, scopes) })
    check("lua51: an array is walked with ipairs", unmarked(flat(printLuau(luau.program(result.statements)))),
        "local list = { 1, 2 }; for _, v in ipairs(list) do print(v); end;")
}
lowers51("lua51: any other table is walked as Luau would walk it", "declare t: { [string]: number }\nfor (const v of t) { print(v) }",
    "local function tilua_each(source, ...) if type(source) == \"function\" then return source, ...; end; "
    + "local meta = getmetatable(source); if meta ~= nil and meta.__iter ~= nil then return meta.__iter(source); end; "
    + "return next, source; end; for _, v in tilua_each(t) do print(v); end;")
lowers51("lua51: an optional read is a call, not an `if` expression", "declare a: { b: boolean } | nil\nconst v = a?.b",
    "local v = (function() local ref = a; if ref == nil then return nil; end; return ref.b; end)();")
lowers51("lua51: attributes are Luau's, and are dropped", "@native\nfunction f(x: number) { return x }", "local function f(x) return x; end;")
lowers51("lua51: a rest element is copied with table.move where there is one", "declare list: number[]\nconst [head, ...tail] = list",
    "local tilua_move = table.move or function(from, first, last, at, to) for i = first, last do to[at + i - first] = from[i]; end; return to; end; "
    + "local head = list[1]; local tail = tilua_move(list, 2, #list, 1, {});")
lowers51("lua51: a spread argument is `unpack`, wherever the Lua keeps it", "declare f: (...args: number[]) => nil\ndeclare xs: number[]\nf(1, ...xs)",
    "local tilua_unpack = table.unpack or unpack; f(1, tilua_unpack(xs));")

{
    const root = project({
        "main.tilua": [
            `import { Stack } from "./stack"`,
            `type Point = { x: number, y: number }`,
            `const point: Point = { x: 1, y: 2 }`,
            `const { x, y: py = 9, ...others } = { ...point, z: 3, w: 4 }`,
            `let count = 0`,
            `for (const value of others) { count += value }`,
            `const [first, , third = "three", ...tail] = ["one", "two", nil, "four", "five"]`,
            `function sum({ a, b = 10 }: { a: number, b?: number }, scale = 1): number {`,
            `    return (a + b) * scale`,
            `}`,
            `const values = [0, ...[1, 2], sum({ a: 1 }), sum({ a: 1, b: 1 }, 2)]`,
            `let total = 0`,
            `for (const v of values) {`,
            `    if (v == 2) { continue }`,
            `    total += v`,
            `}`,
            `const stack = Stack.new()`,
            `stack:push(5)`,
            `const label = if total > 10 then "big" else "small"`,
            `const flags: { on: boolean } | nil = { on: false }`,
            `const none: { on: boolean } | nil = nil`,
            `function steps(limit: number) {`,
            `    let at = 0`,
            `    return () => {`,
            `        at += 1`,
            `        return if at <= limit then at else nil`,
            `    }`,
            `}`,
            `let stepped = 0`,
            `for (const step of steps(3)) { stepped += step }`,
            `@native`,
            `function half(n: number): number { return n // 2 }`,
            `function all(...parts: number[]): number { return parts.length }`,
            `print(\`\${x} \${py} \${count} \${first} \${third} \${tail.length} \${total} \${label} \${stack:size()}\`)`,
            `print(flags?.on, none?.on, stepped, half(7), 1_000, all(...values), all(0, ...tail:map(v => v.length)))`,
            `print([3, 1, 2]:reverse():concat([9], [8]):slice(2, 4):join("-"), [[1], [2, 3]]:flat():join(""), typeof values, typeof point)`,
        ].join("\n"),
        "stack.tilua": [
            "export const Stack = {}",
            "Stack.__index = Stack",
            "function Stack.new() {",
            "    return setmetatable({ items: [] }, Stack)",
            "}",
            "function Stack:push(value: number) {",
            "    table.insert(self.items, value)",
            "}",
            "function Stack:size(): number {",
            "    return self.items.length",
            "}",
            "",
        ].join("\n"),
    })
    const entry = join(root, "main.tilua")
    const forLuau = await bundle({ entry, config: { types: [LUAU] } })
    const forLua51 = await bundle({ entry, config: { types: [] } })
    if (forLua51.code !== undefined) validLua51("lua51: the language at runtime", forLua51.code)
    const expected = run("lua51: the same program, for Luau", forLuau)
    const lua51Binary = process.env.LUA51
    if (expected && lua51Binary) {
        check("lua51: the language at runtime prints what Luau prints", runFiles("lua51: the language at runtime", forLua51, lua51Binary), expected)
    }
}

// `??`, `n++` / `n--`, `in`, `instanceof`, interfaces and object accessors:
// TypeScript's, at runtime.
{
    const root = project({
        "main.tilua": [
            "interface Named {",
            "    name: string",
            "    greet(): string",
            "}",
            "class Animal implements Named {",
            "    name: string",
            "    constructor(name: string) { this.name = name }",
            "    function greet(): string { return `I am ${this.name}` }",
            "}",
            "class Dog extends Animal {",
            "    constructor(name: string) { super(name) }",
            "}",
            "class Cat { constructor() {} }",
            "export type { Named }",
            "const off: boolean | nil = false",
            "const none: number | nil = nil",
            "function pick(): number | nil { return nil }",
            "print(off ?? true, none ?? 2, pick() ?? 3, (off or true))",
            "let n = 0",
            "n++",
            "n++",
            "n--",
            "const counts = { hits: 1 }",
            "counts.hits++",
            "const xs = [5]",
            "xs[1]--",
            "print(n, counts.hits, xs[1])",
            "const shape: { radius?: number, side?: number } = { radius: 2 }",
            "print(\"radius\" in shape, \"side\" in shape)",
            "const rex = Dog.new(\"Rex\")",
            "const items: (Animal | Cat | string)[] = [rex, Cat.new(), \"x\"]",
            "print(rex instanceof Dog, rex instanceof Animal, rex instanceof Cat, items[2] instanceof Animal, items[3] instanceof Animal)",
            "const named: Named = rex",
            "print(named:greet())",
            "const person = {",
            "    first: \"Ada\",",
            "    last: \"Lovelace\",",
            "    get full(): string { return `${this.first} ${this.last}` },",
            "    set full(value: string) { this.first = value },",
            "    get initial(): string { return this.first:sub(1, 1) },",
            "}",
            "print(person.full, person.initial)",
            "person.full = \"Grace\"",
            "print(person.full, person.first)",
            "const snapshot = { ...person }",
            "print(snapshot.full, snapshot.initial)",
            "const Anon = class { constructor() {} }",
            "print(Dog.name, rex.ClassObject.name, rex.ClassObject.ParentClass?.name, Anon.name)",
            "const letters = [\"x\", \"y\"]",
            "print(letters:keys():join(\",\"), letters:values():join(\",\"), letters:entries()[2][1], letters:entries()[2][2])",
            "const stats = { hp: 10, mp: 5 }",
            "const doubled = stats:entries():map(([k, v]) => [k, v * 2]):fromEntries()",
            "print(doubled.hp, doubled.mp)",
            "const written = pcall(() => { (person as any).initial = \"z\" })",
            "print(written.success, tostring(written.error))",
            "",
        ].join("\n"),
    })
    const entry = join(root, "main.tilua")
    const result = await bundle({ entry, config: { types: [] } })
    const expected = [
        "false\t2\t3\ttrue",
        "1\t2\t4",
        "true\tfalse",
        "true\ttrue\tfalse\tfalse\tfalse",
        "I am Rex",
        "Ada Lovelace\tA",
        "Grace Lovelace\tGrace",
        "Grace Lovelace\tG",
        "Dog\tDog\tAnimal\tAnon",
        "1,2\tx,y\t2\ty",
        "20\t10",
    ]
    const output = run("bundle: TypeScript's operators, interfaces and accessors", result)
    if (output) {
        check("bundle: TypeScript's operators, interfaces and accessors", output.slice(0, expected.length), expected)
        check("bundle: a getter with no setter cannot be written", output[expected.length]?.startsWith("false\t") && output[expected.length].includes("has a getter and no setter"), true)
    }
    const forLua51 = await bundle({ entry, config: { types: [] } })
    if (forLua51.code !== undefined) validLua51("lua51: TypeScript's operators, interfaces and accessors", forLua51.code)
    else failures.push(`lua51: TypeScript's operators, interfaces and accessors\n    no bundle: ${forLua51.diagnostics.map(d => d.message).join("; ")}`)
}

// In Luau `^` binds tighter than a unary operator: `#xs ^ 2` is `#(xs ^ 2)`.
await lowers("^: a length or a negation on its left is bracketed",
    "const xs = [1, 2]\nconst n = 3\nprint(xs.length ^ 2.5, (-n) ^ 2, -n ^ 2, 2 ^ -n)",
    "local xs = { 1, 2 }; local n = 3; print((#xs) ^ 2.5, (-n) ^ 2, -n ^ 2, 2 ^ -n);")

// `import "./x"` runs the module, in its place among the imports, and names nothing.
{
    const root = project({
        "tilua.config.json": JSON.stringify({ types: [] }),
        "src/main.tilua": `import "./setup"\nimport { value } from "./value"\nprint("main", value)\n`,
        "src/setup.tilua": `print("setup")\n`,
        "src/value.tilua": `print("value")\nexport const value = 1\n`,
    })
    runs("import \"...\": the module runs, before the ones imported after it",
        await bundle({ entry: join(root, "src/main.tilua") }), ["setup", "value", "main\t1"])
}

// A helper is defined once for the bundle, not once in each module that uses it.
{
    const root = project({
        "tilua.config.json": JSON.stringify({ types: [] }),
        "src/main.tilua": [
            `import { a } from "./a"`,
            `import { b } from "./b"`,
            `class K { n = 1 }`,
            `print([1, 2]:map(x => x * 2):join(","), typeof [1], a(), b(), K.new().n)`,
            `print(import("./c").c())`,
        ].join("\n"),
        "src/a.tilua": `export function a() { class P {}\n return [3]:filter(y => y > 1).length + typeof {} }\n`,
        "src/b.tilua": `export function b() { return [3]:map(y => y):join("") }\n`,
        "src/c.tilua": `export function c() { return [5]:map(y => y + 1):join("") }\n`,
    })
    const entry = join(root, "src/main.tilua")
    const expected = ["2,4\tarray\t1object\t3\t1", "6"]
    const single = await bundle({ entry })
    runs("shared helpers: a bundle that runs as before", single, expected)
    const count = (code: string, text: string): number => code.split(text).length - 1
    check("shared helpers: each defined once",
        ["local tilua_array = {}", "local function tilua_asArray(", "local function tilua_typeof(", "local function tilua_class("].map(text => count(single.code ?? "", text)),
        [1, 1, 1, 1])
    for (const output of ["chunks", "modules"] as const) {
        const result = await bundle({ entry, output, root, config: { types: [LUAU] } })
        check(`shared helpers (${output}): each file defines what its modules use`, result.files.every(f => f.code.includes("tilua_array = (function()")), true)
        const ran = runFiles(`shared helpers (${output})`, result, luauBinary)
        if (ran) check(`shared helpers (${output}): runs as before`, ran, expected)
    }
}

// --- tree shaking ----------------------------------------------------------------
// `"treeShaking": true` leaves out what the entry never reaches: declarations
// nothing reads, modules nothing reads that do nothing as they run, and the
// members of a runtime table nothing calls.
{
    const files = {
        "tilua.config.json": JSON.stringify({ types: [], treeShaking: true }),
        "src/main.tilua": [
            `import { used, unreadImport } from "./lib"`,
            `import * as M from "./math"`,
            `import { quiet } from "./quiet"`,
            `import { loud } from "./loud"`,
            `import { again } from "./barrel"`,
            `import "./setup"`,
            `const xs = [3, 1, 2]`,
            `print(used(), M.square(3), xs:map(x => x * 2):join(","), again)`,
            `print(import("./lazy").both())`,
            `export const out = 1`,
        ].join("\n"),
        "src/lib.tilua": [
            `export function used() { return helper() + 1 }`,
            `function helper() { return 41 }`,
            `export function unused() { return onlyForUnused() }`,
            `function onlyForUnused() { return 1 }`,
            `export const unreadImport = 5`,
            `export const made = make()`,
            `function make() { print("made"); return 2 }`,
            `export class Unused { static count = 0 }`,
            `export class Counted { static count = make() }`,
        ].join("\n"),
        "src/math.tilua": `export function square(n: number) { return n * n }\nexport function cube(n: number) { return n * n * n }\n`,
        "src/quiet.tilua": `export const quiet = 1\n`,
        "src/loud.tilua": `print("loud runs")\nexport const loud = 1\n`,
        "src/barrel.tilua": `export { again } from "./deep"\nexport * from "./star"\n`,
        "src/deep.tilua": `export const again = "again"\nexport const notAgain = 0\n`,
        "src/star.tilua": `export function starred() { return 0 }\n`,
        "src/setup.tilua": `print("setup runs")\nexport function setupHelper() { return 0 }\n`,
        "src/lazy.tilua": `export function both() { return "lazy" }\nexport function also() { return 1 }\n`,
    }
    const root = project(files)
    const entry = join(root, "src/main.tilua")
    const shaken = await bundle({ entry })
    const whole = await bundle({ entry, treeShaking: false })
    const code = shaken.code ?? ""
    check("tree shaking: what nothing reads is left out", [
        shaken.diagnostics.map(d => d.message),
        ["helper", "used", "square", "again", "both", "also", "out"].map(name => code.includes(name)),
        ["onlyForUnused", "unreadImport", "cube", "notAgain", "starred", "setupHelper", "Unused"].map(name => code.includes(name)),
        shaken.modules,
        whole.modules,
    ], [
        [],
        [true, true, true, true, true, true, true],
        [false, false, false, false, false, false, false],
        ["src/main", "src/lib", "src/math", "src/loud", "src/barrel", "src/setup", "src/lazy", "src/deep"],
        ["src/main", "src/lib", "src/math", "src/barrel", "src/setup", "src/lazy", "src/deep", "src/star"],
    ])
    check("tree shaking: a runtime table keeps the members called", [
        code.includes("function tilua_array.map("), code.includes("function tilua_array.join("),
        code.includes("function tilua_array.filter("), (whole.code ?? "").includes("function tilua_array.filter("),
    ], [true, true, false, true])
    // What runs as a module loads still runs: `make()` and the class whose
    // static calls it, and every module that prints.
    runs("tree shaking: the program does what it did", shaken, ["made", "made", "loud runs", "setup runs", "42\t9\t6,2,4\tagain", "lazy"])
    // Unshaken, an import whose names nothing reads brings no module in —
    // `loud` with it. Shaken, a module that runs anything still runs.
    runs("tree shaking: unshaken, an import read by nothing loads nothing", whole, ["made", "made", "setup runs", "42\t9\t6,2,4\tagain", "lazy"])
}

// A library may call its runtime by index — `tilua_z["object"]`, as
// `@tilua-types/zod` does — and what it calls that way is read, so it stays.
{
    const lowering = [
        "const runtime = 'local __NAME__ = {}\\nfunction __NAME__.object(t) return \"object\" end\\nfunction __NAME__.unused() return 0 end'",
        "export default {",
        "    runtime: { z: runtime },",
        "    globalCall({ name, use }) {",
        "        return name.startsWith('z.') ? { callee: `${use('z')}[${JSON.stringify(name.slice(2))}]` } : undefined",
        "    },",
        "}",
    ].join("\n")
    const root = project({
        "tilua.config.json": JSON.stringify({ types: ["z"], treeShaking: true }),
        "node_modules/@tilua-types/z/package.json": JSON.stringify({ name: "@tilua-types/z", tilua: { types: "index.d.tilua", lowering: "lowering.mjs" } }),
        "node_modules/@tilua-types/z/index.d.tilua": "declare function print(...args: unknown[]): nil\ndeclare z: { object: (t: unknown) => string, unused: () => number }\n",
        "node_modules/@tilua-types/z/lowering.mjs": lowering,
        "main.tilua": "print(z.object({}))\n",
    })
    const shaken = await bundle({ entry: join(root, "main.tilua") })
    check("tree shaking: a runtime member called by index is kept", [
        shaken.diagnostics.map(d => d.message),
        (shaken.code ?? "").includes(".object("),
        (shaken.code ?? "").includes(".unused("),
    ], [[], true, false])
    runs("tree shaking: a runtime member called by index runs", shaken, ["object"])
}

for (const failure of failures) console.log(`FAIL ${failure}`)
const note = luauBinary ? "" : ` (${skipped} runs skipped: no Luau interpreter; set LUAU to run them)`
console.log(`\n${passed} passed, ${failures.length} failed${note}`)
process.exit(failures.length ? 1 : 0)
