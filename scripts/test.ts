/**
 * @tilua/compiler tests.
 *
 * Lowering cases compile a fragment and compare the Luau it prints, with the
 * printer's line breaks folded into spaces so a case reads on one line. Every
 * output is parsed back with luau-parser: whatever lowering builds must be
 * valid Luau.
 *
 * Bundle cases build a small project on disk. When a Luau interpreter is
 * available — `luau` on the PATH, or the `LUAU` environment variable naming
 * one — each bundle is also run, and what it prints is compared: that is the
 * only way to know a cycle really behaves like ES modules.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parse as parseLuau, print as printLuau } from "luau-parser"
import { parse as parseTilua, analyzeScopes as analyzeScopesTilua, analyzeTypes as analyzeTypesTilua } from "@tilua/parser"
import { bundle, compile, type BundleResult } from "../src/index.js"
import { lower } from "../src/lower.js"
import type { LoweringPlugin } from "../src/lowering.js"
import * as luau from "../src/luau.js"

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
    check(name, flat(result.code), expected)
}

/** Lower `source` for stock Lua 5.1 and check its output, on one line. */
function lowers51(name: string, source: string, expected: string): void {
    const program = parseTilua(source)
    const result = lower(program, analyzeScopesTilua(program), { target: "lua51" })
    if (result.diagnostics.length) {
        failures.push(`${name}\n    did not lower: ${result.diagnostics.map(d => d.message).join("; ")}`)
        return
    }
    const code = printLuau(luau.program(result.statements))
    validLuau(name, code)
    validLua51(name, code)
    check(name, flat(code), expected)
}

/** The Lua 5.1 lowering refuses `source`, saying `reason`. */
function refuses51(name: string, source: string, reason: string): void {
    const program = parseTilua(source)
    const result = lower(program, analyzeScopesTilua(program), { target: "lua51" })
    check(name, result.diagnostics.map(d => d.message.includes(reason)), [true])
}

// --- declarations ---------------------------------------------------------------
await lowers("const and let are local", "const a = 1\nlet b = 2", "local a = 1; local b = 2;")
await lowers("a declaration without a value", "let x", "local x;")
await lowers("types are dropped", "type P = { x: number }\ndeclare game: unknown\nconst n: number = 1 as number", "local n = 1;")
await lowers("satisfies and as const are dropped", "const t = { a: 1 } satisfies { a: number }\nconst u = [1] as const", "local t = { a = 1 }; local u = { 1 };")
// --- the Lua 5.1 target -----------------------------------------------------
// Stock 5.1 has none of Luau's additions, and no `goto` to lower `continue` to.
{
    lowers51("lua51: compound assignment expands", "let a = 1\na += 2", "local a = 1; a = a + (2);")
    lowers51("lua51: concat assignment expands", "let s = \"a\"\ns ..= \"b\"", "local s = \"a\"; s = s .. (\"b\");")
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
        "cannot be compiled for Lua 5.1")
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
await lowers("array rest", "const [head, ...tail] = list", "local head = list[1]; local tail = table.move(list, 2, #list, 1, {});")

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
    `local function tilua_assign(target, ...) for i = 1, select("#", ...) do local source = select(i, ...); if source ~= nil then for key, value in pairs(source) do target[key] = value; end; end; end; return target; end; local t = tilua_assign({}, { a = 1 }, base, { b = 2 });`)
await lowers("array spread joins the runs",
    "const xs = [f(), ...ys, g()]",
    `local function tilua_concat(...) local result = {}; for i = 1, select("#", ...) do local part = select(i, ...); table.move(part, 1, #part, #result + 1, result); end; return result; end; local xs = tilua_concat({ (f()) }, ys, { g() });`)
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
await lowers("for-in patterns", "const list = [{ name: \"a\" }]\nfor (const { name } in list) {\n    print(name)\n}",
    'local list = { { name = "a" } }; for _, item in list do local name = item.name; print(name); end;')
await lowers("if expressions", "const v = if a then 1 elseif b then 2 else 3", "local v = if a then 1 elseif b then 2 else 3;")
await lowers("a Luau keyword used as a name", "let local = 1\nprint(t.local, local)", `local local_ = 1; print(t["local"], local_);`)
await lowers("generated names avoid the source's", "const ref = 1\nconst { a } = f()", "local ref = 1; local ref2 = f(); local a = ref2.a;")

await lowers("a table is walked for its values", "const list = [1, 2]\nfor (const v in list) { print(v) }",
    "local list = { 1, 2 }; for _, v in list do print(v); end;")
await lowers("an optional read of a key stops the chain",
    "declare maps: { [string]: { label: string } } | nil\ndeclare key: string\nconst named = maps?.[key]?.label",
    "local named = (function() local ref = maps; if ref == nil then return nil; end; ref = ref[key];"
    + " if ref == nil then return nil; end; return ref.label; end)();")
await lowers("an iterator function is the loop's own",
    "declare step: () => number | nil\nfor (const n in step) { print(n) }", "for n in step do print(n); end;")
await lowers("an iteration is the three Luau loops with, taken out of the array it is",
    "declare walk: [(s: nil, previous: number | nil) => number | nil, nil, nil]\nfor (const n in walk) { print(n) }",
    "for n in unpack(walk, 1, 3) do print(n); end;")
await lowers("attributes are kept", "@native\nfunction f(x: number): number {\n    return x\n}", "@native local function f(x) return x; end;")
await lowers("a shadowed global the output needs is captured first",
    "const table = {}\nconst [a, ...rest] = list\nprint(`${a}`)",
    `local tilua_table = table; local table = {}; local a = list[1]; local rest = tilua_table.move(list, 2, #list, 1, {}); print((("%s"):format(tostring(a))));`)

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
    }
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
    const map = new Map<number, string>()
    for (const m of code.slice(code.indexOf(".lines = ")).matchAll(/\[(\d+)\]\s*=\s*\{\s*"([^"]+)"\s*,\s*(\d+)\s*\}/g)) {
        map.set(Number(m[1]), `${m[2]}:${m[3]}`)
    }
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
            'for (const [i, name] in walk) { print(`${i}${name}`) }',
        ].join("\n") + "\n",
    })
    const result = await bundle({ entry: join(root, "main.tilua") })
    check("an iteration is looped with as its three parts",
        result.code?.includes("for item in unpack(walk, 1, 3) do"), true)
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
            `for (const key in pairs(others)) { count += 1 }`,
            `const [first, , third = "three", ...tail] = ["one", "two", nil, "four", "five"]`,
            `function sum({ a, b = 10 }: { a: number, b?: number }, scale = 1): number {`,
            `    return (a + b) * scale`,
            `}`,
            `const values = [0, ...[1, 2], sum({ a: 1 }), sum({ a: 1, b: 1 }, 2)]`,
            `let total = 0`,
            `for (const v in values) { total += v }`,
            `const stack = Stack.new()`,
            `stack:push(5)`,
            `const label = if total > 10 then "big" else "small"`,
            `let a = 1`,
            `let b = 2`,
            `{ a, b } = { a: b, b: a }`,
            `print(\`\${x} \${py} \${count} \${first} \${third} \${#tail} \${total} \${label} \${stack:size()} \${a}\${b} 100%\`, table.note, ...scriptArgs)`,
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
        "    return #self.items",
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
        "    return { name, child, greet: function(self: Node, suffix: string): string { return self.name .. suffix }, pair: function(): [number, number] { return [1, 2] } }",
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
    check("bundle: an optional read on a name is an `if` expression",
        code.includes("if root == nil then nil else root.name"), true)
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
        "const call: ((s: string) => string) | nil = function(s: string): string { return \"got\" .. s }",
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
            "    return tostring(a) .. tostring(b)",
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
        "            return #EventManager.Connections",
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
    "f(1, table.unpack(xs));")
await lowers("a spread anywhere else builds the list first",
    "declare xs: number[]\nf(...xs, 1)",
    "local function tilua_concat(...) local result = {}; "
    + "for i = 1, select(\"#\", ...) do local part = select(i, ...); table.move(part, 1, #part, #result + 1, result); end; "
    + "return result; end; "
    + "f(table.unpack(tilua_concat(xs, { 1 })));")
// `...[a, b]` is the Luau pack `a, b`, written out rather than unpacked.
await lowers("a spread array literal is its values",
    "f(...[1, 2])\nf(0, ...[1, ...[2, 3]], 4)",
    "f(1, 2); f(0, 1, 2, 3, 4);")
await lowers("a spread literal's last call keeps every value when it ends the list",
    "f(...[1, g()])\nf(g(), 1)",
    "f(1, g()); f(g(), 1);")
await lowers("a spread literal's last call anywhere else stays an array",
    "f(...[1, g()], 2)",
    "local function tilua_concat(...) local result = {}; "
    + "for i = 1, select(\"#\", ...) do local part = select(i, ...); table.move(part, 1, #part, #result + 1, result); end; "
    + "return result; end; "
    + "f(table.unpack(tilua_concat({ 1 }, { g() }, { 2 })));")
await lowers("a spread array literal in an array is its values",
    "const xs = [0, ...[1, 2], 3]",
    "local xs = { 0, 1, 2, 3 };")
// A string's, an array's and a table's methods are the language's: with no
// library at all, the compiler lowers them into its own runtime. A string's
// Lua methods stay what they are.
{
    const lowered = await compile([
        "const names = [\"a\", \"bb\"]",
        "const long = names:filter(n => #n > 1)",
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
            "        return this.name .. \" has area \" .. tostring(this:area())",
            "    }",
            "    get label(): string {",
            "        return \"<\" .. this.name .. \">\"",
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
            "        return super.describe() .. \" (square)\"",
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
            "print(numbers:map(function(n) { return tostring(n) .. \"!\" }):get())",
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
    "local function tilua_class(base) local class = { __getters = {}, __setters = {} }; class.__index = class; "
    + "class.ClassObject = class; class.ParentClass = base; "
    + "if base ~= nil then setmetatable(class, { __index = base }); setmetatable(class.__getters, { __index = base.__getters }); "
    + "setmetatable(class.__setters, { __index = base.__setters }); for _, key in ipairs({ \"__add\", \"__sub\", \"__mul\", \"__div\", \"__idiv\", \"__mod\", \"__pow\", \"__unm\", \"__concat\", \"__len\", \"__eq\", \"__lt\", \"__le\", \"__call\", \"__tostring\", \"__iter\" }) do class[key] = base[key]; end; end; return class; end; "
    + "local function tilua_accessors(class) "
    + "if not class.__dynamic and next(class.__getters) == nil and next(class.__setters) == nil then return; end; "
    + "class.__dynamic = true; "
    + "class.__index = function(this, key) local getter = class.__getters[key]; if getter ~= nil then return getter(this); end; return class[key]; end; "
    + "class.__newindex = function(this, key, value) local setter = class.__setters[key]; if setter ~= nil then setter(this, value); return; end; rawset(this, key, value); end; "
    + "end; "
    + "local Counter = tilua_class(nil); "
    + "function Counter.bump(this) this.n += 1; return this.n; end; "
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

for (const failure of failures) console.log(`FAIL ${failure}`)
const note = luauBinary ? "" : ` (${skipped} runs skipped: no Luau interpreter; set LUAU to run them)`
console.log(`\n${passed} passed, ${failures.length} failed${note}`)
process.exit(failures.length ? 1 : 0)
