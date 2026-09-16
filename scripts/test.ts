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
await lowers("const and let are local", "const a = 1\nlet b, c = 2, 3", "local a = 1; local b, c = 2, 3;")
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
await lowers("destructuring beside plain names",
    "const x, { y } = f()", "local x, ref = f(); local y = ref.y;")

// --- array destructuring ---------------------------------------------------------
await lowers("arrays read by index", "const [first, second] = list", "local first, second = list[1], list[2];")
await lowers("holes are skipped", "const [, second] = list", "local second = list[2];")
await lowers("array rest", "const [head, ...tail] = list", "local head = list[1]; local tail = table.move(list, 2, #list, 1, {});")

// --- destructuring assignment ----------------------------------------------------
await lowers("assigns straight from a name", "let a, b = 1, 2\n{ a, b } = value", "local a, b = 1, 2; a, b = value.a, value.b;")
await lowers("assignment from anything else is scoped",
    "let a, b = 1, 2\n{ a, b } = { a: b, b: a }", "local a, b = 1, 2; do local ref = { a = b, b = a }; a, b = ref.a, ref.b; end;")

// --- tables, arrays and strings --------------------------------------------------
await lowers("object literals", `const t = { a: 1, "b-c": 2, [k]: 3, d }`, `local t = { a = 1, ["b-c"] = 2, [k] = 3, d = d };`)
await lowers("array literals are tables", "const xs = [1, 2, 3]", "local xs = { 1, 2, 3 };")
await lowers("object spread copies in order",
    "const t = { a: 1, ...base, b: 2 }",
    `local function tilua_assign(target, ...) for i = 1, select("#", ...) do local source = select(i, ...); if source ~= nil then for key, value in pairs(source) do target[key] = value; end; end; end; return target; end; local t = tilua_assign({}, { a = 1 }, base, { b = 2 });`)
await lowers("array spread joins the runs",
    "const xs = [f(), ...ys, g()]",
    `local function tilua_concat(...) local result = {}; for i = 1, select("#", ...) do local part = select(i, ...); table.move(part, 1, #part, #result + 1, result); end; return result; end; local xs = tilua_concat({ (f()) }, ys, { (g()) });`)
await lowers("interpolation becomes format", "print(`${a} any`)", `print(("%s any"):format(tostring(a)));`)
await lowers("interpolation escapes percent signs and keeps braces",
    "print(`${n}% of {total}`)", `print(("%s%% of {total}"):format(tostring(n)));`)
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
await lowers("for-in patterns", "for (_, { name } in pairs(t)) {\n    print(name)\n}", "for _, item in pairs(t) do local name = item.name; print(name); end;")
await lowers("if expressions", "const v = if a then 1 elseif b then 2 else 3", "local v = if a then 1 elseif b then 2 else 3;")
await lowers("a Luau keyword used as a name", "let local = 1\nprint(t.local, local)", `local local_ = 1; print(t["local"], local_);`)
await lowers("generated names avoid the source's", "const ref = 1\nconst { a } = f()", "local ref = 1; local ref2 = f(); local a = ref2.a;")

await lowers("for x in a table yields the values", "const list = [1, 2]\nfor (v in list) { print(v) }",
    "local list = { 1, 2 }; for _, v in list do print(v); end;")
await lowers("an iterator function keeps its own values", "for (k in pairs(t)) { print(k) }", "for k in pairs(t) do print(k); end;")
await lowers("attributes are kept", "@native\nfunction f(x: number): number {\n    return x\n}", "@native local function f(x) return x; end;")
await lowers("a shadowed global the output needs is captured first",
    "const table = {}\nconst [a, ...rest] = list\nprint(`${a}`)",
    `local tilua_table = table; local table = {}; local a = list[1]; local rest = tilua_table.move(list, 2, #list, 1, {}); print(("%s"):format(tostring(a)));`)

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

// `console:log` shows a function as the type it was inferred to have and the
// code it was written as. Neither exists at runtime, so the compiler is the
// only thing that can say them, and it passes both alongside the value.
{
    const analyze = (code: string) => {
        const program = parseTilua(code)
        const scopes = analyzeScopesTilua(program)
        const result = lower(program, scopes, {
            source: code,
            types: analyzeTypesTilua(program, scopes, { diagnostics: false }),
        })
        return flat(printLuau(luau.program(result.statements)))
    }

    // Nothing worth saying about a string or a table: no meta at all.
    check("console: a call with nothing to describe passes no meta",
        analyze(`console:log("hi", 42)`).includes(`.log(nil, "hi", 42)`), true)

    // A function is followed back to what it was declared as.
    const named = analyze("const double = (x: number) => x * 2\nconsole:log(double)")
    check("console: a function is described by its type and its code", [
        named.includes(`"(x: number) => number"`),
        named.includes(`"(x: number) => x * 2"`),
    ], [true, true])

    // A local `console` is the author's own, and is left alone.
    check("console: a local named console is not the language's",
        analyze("const console = { log: (self: unknown, n: number) => {} }\nconsole:log(1)").includes("console:log(1)"), true)

    check("console: warn and error go through the same runtime", [
        analyze(`console:warn("careful")`).includes(".warn(nil,"),
        analyze(`console:error("boom")`).includes(".error(nil,"),
    ], [true, true])
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
        "print(util.twice(start)); -> src/main.tilua:3",
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
    check("bundle: an entry that exports returns its exports", flat(result.code ?? "").endsWith(`return G.require("main");`), true)
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
    // `pairs(t)` is typed as a pack — the iterator triplet — not as a table.
    // Lowering used to read that pack as a table iterated directly and insert
    // a `_` key variable, which bound the loop's one name to the value.
    const root = project({
        "defs.d.tilua": `declare function pairs<T>(t: T): ((t: T, key?: unknown) => (unknown, unknown), T, nil)\n`,
        "main.tilua": [
            `const scores: { [string]: number } = { a: 1 }`,
            `for (key in pairs(scores)) { print(key) }`,
        ].join("\n") + "\n",
    })
    const result = await bundle({ entry: join(root, "main.tilua"), config: { types: ["./defs.d.tilua"] } })
    check("a typed pairs() keeps the loop's one variable on the key",
        result.code?.includes("for key in pairs(scores) do"), true)
    runs("a typed pairs() iterates keys", result, ["a"])
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
            `for (key in pairs(others)) { count += 1 }`,
            `const [first, , third = "three", ...tail] = ["one", "two", nil, "four", "five"]`,
            `function sum({ a, b = 10 }: { a: number, b?: number }, scale = 1): number {`,
            `    return (a + b) * scale`,
            `}`,
            `const values = [0, ...[1, 2], sum({ a: 1 }), sum({ a: 1, b: 1 }, 2)]`,
            `let total = 0`,
            `for (v in values) { total += v }`,
            `const stack = Stack.new()`,
            `stack:push(5)`,
            `const label = if total > 10 then "big" else "small"`,
            `let a, b = 1, 2`,
            `{ a, b } = { a: b, b: a }`,
            `print(\`\${x} \${py} \${count} \${first} \${third} \${#tail} \${total} \${label} \${stack:size()} \${a}\${b} 100%\`, table.note, ...)`,
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
        "type Node = { name: string, child: Node | nil, greet: (self: Node, suffix: string) => string, pair: () => (number, number) }",
        "let reads = 0",
        "let argued = 0",
        "function arg(): string {",
        "    argued += 1",
        "    return \"!\"",
        "}",
        "function make(name: string, child: Node | nil): Node {",
        "    return { name, child, greet: function(self: Node, suffix: string): string { return self.name .. suffix }, pair: function(): (number, number) { return 1, 2 } }",
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
        "print(root?.pair())",
        "none?:greet(arg())",
        "root?.child?:greet(arg())",
        "get(root)?.child?:greet(arg())",
        "print(argued, reads)",
        "function spread(...: Node | nil): string | nil {",
        "    return (...)?.child?.name",
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
        "declare function print(...: unknown): ()",
        "type ArrayMethods<T> = { first: (self: T[]) => T | nil, nope: (self: T[]) => T | nil }",
        "type StringMethods = { shout: (self: string) => string }",
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
        "defs.d.tilua": `declare function print(...: unknown): ()\n`,
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
        "defs.d.tilua": "declare function print(...: unknown): ()\ndeclare function tostring(value: unknown): string\n",
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
await lowers("a `return` spreads the same way a call does",
    "declare xs: number[]\nfunction f() {\n    return ...xs\n}",
    "local function f() return table.unpack(xs); end;")
await lowers("and so does a declaration",
    "declare xs: number[]\nconst a, b = ...xs",
    "local a, b = table.unpack(xs);")

await lowers("bare `...` is the pack, not a spread",
    "function f(...) {\n    g(...)\n}",
    "local function f(...) g(...); end;")

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

await lowers("an array of the varargs is Lua's own table of them",
    [
        "function join(...) {",
        "    const parts = [...]",
        "    return parts",
        "}",
        "",
        "",
    ].join("\n"),
    "local function join(...) local parts = { ... }; return parts; end;")

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
            "const s = new Square(3)",
            "print(s:describe())",
            "print(s.label, s.sides, s.side)",
            "s.label = \"box\"",
            "print(s:describe())",
            "",
            "const t = new Tile(2)",
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
            "        return new Box(f(this.value))",
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
            "const base = new Base()",
            "const derived = new Derived()",
            "print(base.ClassObject == Base, derived.ClassObject == Derived)",
            "print(Derived.ParentClass == Base, Base.ParentClass == nil)",
            "print(derived.ClassObject.ParentClass == Base)",
            "-- The class is one table, shared: nothing of it sits on an instance.",
            "print(rawget(derived, \"ClassObject\") == nil, rawget(derived, \"n\") == 1)",
            "",
            "const numbers = new Box(41)",
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
            "print(new Ints(21):double())",
            "",
            "const Counter = class {",
            "    n = 0",
            "    function bump(): number {",
            "        this.n += 1",
            "        return this.n",
            "    }",
            "}",
            "const counter = new Counter()",
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
    + "setmetatable(class.__setters, { __index = base.__setters }); end; return class; end; "
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
        "const v = new Vec(1)",
    ].join("\n"),
    "local v = Vec.new(1);")

for (const failure of failures) console.log(`FAIL ${failure}`)
const note = luauBinary ? "" : ` (${skipped} runs skipped: no Luau interpreter; set LUAU to run them)`
console.log(`\n${passed} passed, ${failures.length} failed${note}`)
process.exit(failures.length ? 1 : 0)
