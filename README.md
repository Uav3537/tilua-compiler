# @tilua/compiler

Compiles a [tilua](https://marketplace.visualstudio.com/search?term=tilua)
project to one Lua file — Lua that runs on Lua 5.1 to 5.4, LuaJIT and Luau
alike, or Luau where a library says the project is Luau (see [Lua and
Luau](#lua-and-luau)). Each file is parsed by
[`@tilua/parser`](https://www.npmjs.com/package/@tilua/parser), its AST lowered
to a `luau-parser` AST, and that AST printed by `luau-parser`.

```bash
npm i -D @tilua/compiler @tilua-types/roblox
npx tilua src/main.tilua --out build/main.luau
```

```
tilua [<entry>] [--out <file>] [--output single|chunks|files] [--config <tilua.config.json>]
              [--noCheck] [--noLineMap] [--minify] [--watch]
tilua init
```

`--watch` builds again whenever a file it reads changes — a `.tilua`, the
config, a Rojo project, and with an `outDir` of its own anything under
`rootDir` — and keeps going. `tilua init` sets up the Rojo project in the
folder: `src` compiled to `out`, and the project pointed at `out` — see
`@tilua-types/roblox`.

Every module the entry imports is bundled in. Problems are reported as
`file:line:column message`. Type errors are checked against the config's
`types`: they are reported, but the bundle is still written (`--noCheck` skips
the check). A syntax error or a missing module stops the build.

Without `--out`, the entry's own path with `.luau` is written. Without
`--config`, the nearest `tilua.config.json` above the entry applies — see the
[`@tilua/parser`](https://www.npmjs.com/package/@tilua/parser) README for what
goes in it.

`--output` (or `"output"` in the config) makes the bundle more than one file —
see [Several files](#several-files).

## API

```ts
import { bundle, compile } from "@tilua/compiler"

const result = await bundle({
    entry: "src/main.tilua",
    // A config file's path, or its contents:
    config: { types: ["roblox"], paths: { "@shared/*": ["src/shared/*"] } },
})
result.code          // the Lua bundle, unless a module failed
result.files         // [{ path, code, modules }] — one, unless `output` says otherwise
result.diagnostics   // { file, line, column, message, category: "syntax" | "module" | "type" | "config" }

// One file, no imports. The config is optional here too, and brings the same
// type libraries — including what they lower.
const one = await compile("const names = [1]\n", "tilua.config.json")
```

`config` is typed `string | TiluaConfigJson`. Left out, the nearest
`tilua.config.json` above the entry applies — and for `compile`, nothing at
all.

Both are `async`: a type library may ship its own lowering, which is a
JavaScript module the build loads.

## What becomes what

| tilua | Lua |
|---|---|
| `const { a, b } = value` | `local a, b = value.a, value.b` |
| `const [x, ...rest] = list` | `local x = list[1]; local rest = tilua_move(list, 2, #list, 1, {})` — `table.move` where the Lua has it; `{}` written down as an array |
| `const { a = 1 } = t` | `local a = t.a; if a == nil then a = 1 end` |
| `[1, 2]` / `{ a: 1, b }` | `tilua_asArray({ 1, 2 })` / `{ a = 1, b = b }` — see `typeof` below |
| `typeof v` | `tilua_typeof(v)`, or `tilua_typeof(v, "array")` where `v`'s type already says which table it is |
| `{ ...base, a: 1 }` / `[...xs, 1]` | a small helper copying the parts in order |
| `` `${a} any` `` | `("%s any"):format(tostring(a))` |
| `a?.b` | `if a == nil then nil else a.b` |
| `a?:m()` as a statement | `if a ~= nil then a:m() end` |
| `f()?.b?:m(x)` | a function call that keeps each link in a local, so every link runs once, in order, and none after a nil |
| `function f(n = 1, { x })` | `function f(n, arg) if n == nil then n = 1 end local x = arg.x ...` |
| `const` / `let` | `local` |
| `class C { … }` | one table for the class, one per instance — see below |
| `return [a, b]` | `return { a, b }` — several results are an array |
| `for (const item of xs)` | `for _, item in xs do … end` — an array or a table walked for its values |
| `for (const item of step)` | `for item in step do … end` — an iterator function |
| `for (const [k, v] of pairs(t))` | `for item in unpack(pairs(t), 1, 3) do local k, v = item[1], item[2] … end` — an iteration is `[step, state, first]` |
| `for (const key in t)` | `for key in pairs(t) do … end` — a table's keys, as in TypeScript |
| `t ??= v` | `if t == nil then t = v end` — what addresses `t` read once, into locals |
| `{ m() { … } }` | `{ m = function(this) … end }` — called with `:` |
| `break outer` from a loop inside `outer` | a flag `outer` declares, raised, and a `break`; after each loop on the way out, a check that breaks again — or, at `outer`, does the `break` or `continue` |
| `throw value` | `error(value, 0)` — level 0, so a `catch` is handed exactly what was thrown |
| `try { a } catch (e) { b }` | `local ok, result = pcall(function() a end) if not ok then local e = result b end` |
| `try { a } catch (e) { b } finally { c }` | `a` and then `b` each in a `pcall`, `c` after them, and what neither caught thrown again |
| a `return`, `break` or `continue` that leaves a `try` | its function returns a code — and the value — and an `if` after the `pcall` does the jump there |
| code after a `return`, `break` or `continue` | left out: Luau allows nothing after one in its block |
| `pcall(f)`, and other globals Luau answers several values from | the type library's own function, answering one — see below |
| `function f(a, ...rest)` | `function f(a, ...) local rest = {...}` |
| `scriptArgs` | the chunk's own `...`, as `local scriptArgs = { ... }` |
| `f(a, ...xs)` | `table.unpack(xs)` in the last position |
| `f(...xs, a)` | the list built first, then `table.unpack` of it |
| `import("./shop")` | `G.import("src/shop")` — the bundle's `require`, wrapped |
| `a ?? b` | `if a ~= nil then a else b` for a name; otherwise a function that reads `a` once |
| `n++` / `n--` | `n += 1` / `n -= 1` |
| `s + t`, `s += t` with a string on a side | `s .. t`, `s ..= t` |
| `a + b` where only the values can say — `any`, `string \| number` | `tilua_add(a, b)`: joins if either is a string, else adds |
| `"key" in t` | `(t["key"] ~= nil)` |
| `v instanceof Dog` | `tilua_instanceof(v, Dog)` — walks `v.ClassObject`, then each `.ParentClass` |
| `{ a: 1, get b() { … }, set b(v) { … } }` | `tilua_accessors({ a = 1 }, { b = … }, { b = … })` — a metatable runs the accessors |
| `x as T`, `x satisfies T`, types, `interface`, `export type { … }`, `declare` | removed |
| `names:filter(f)` | whatever the type library that declared `filter` says — see below |

## Lua and Luau

The compiler knows Lua. What it writes is Lua 5.1's syntax, and runs on Lua
5.1 to 5.4, LuaJIT and Luau alike: `table.move`, `table.unpack` and `typeof`
are used where the Lua has them and stood in for where it does not.

A Lua with more syntax is a type library's to say — its lowering lists it
(`syntax`, see [What a type library lowers](#what-a-type-library-lowers)). `@tilua-types/luau` says
Luau's, and `@tilua-types/roblox` loads it, so a Roblox project is written as
Luau without asking:

| written | Lua (no library) | Luau (`"types": ["luau"]`, or `["roblox"]`) |
|---|---|---|
| `a += b`, `a // b` | `a = a + (b)`, `math.floor(a / (b))` | as written |
| `continue` | a `break` out of a one-pass `repeat` | as written |
| `c ? a : b`, `a?.b`, `a ?? b` | `and`/`or` where neither arm can be `false`, else a function called on the spot | `if c then a else b` |
| `for (const x of xs)` | `ipairs(xs)` where `xs` is an array by its type; otherwise `tilua_each(xs)`, which walks a table as Luau would — its `__iter` if it has one, `next` if not | `for _, x in xs do` |
| `1_000`, `0b101` | plain numbers | as written |
| `@native` and other attributes | dropped | kept |
| another file of the bundle | `loadfile` | `require` by path |

Without such a library the output is printed as Lua 5.1, and the printer
refuses what 5.1 has no syntax for: a `+=` let through, or a library's runtime
written in Luau, stops the build with `The output cannot be written as Lua
5.1: …` instead of failing on a Lua that cannot read it.

An object's `freeze` does nothing on a Lua without `table.freeze`, and
`isFrozen` answers `false`. `npm test` with `LUA51` naming a Lua 5.1
interpreter builds a program both ways and checks they print the same.

The config's `target` is gone: `"target": "lua51"` is now what every build
is, and `"luau"` is `"types": ["luau"]`.

## `typeof`, arrays and objects

Luau cannot tell an array from an object: both are tables, and an empty one
has nothing to go by. So every array the program makes is written down as
one where it is made — `[a, b]`, a rest parameter, `scriptArgs`, what
`:map`, `:filter`, `:keys` and the rest answer — in a table that holds its
keys weakly, one for the whole bundle. `tilua_asArray(t)` does that and hands
`t` back.

`typeof v` is Luau's `typeof` (Lua 5.1's `type`) for anything but a table.
For a table it answers, in order:

1. what `v`'s type says, where every table it can be is an array, or every
   one an object — passed by the compiler, so nothing is looked up;
2. `"array"` if it was written down as one;
3. `"object"` if it has a metatable — an instance of a class;
4. `"array"` if it has a first element, and `"object"` otherwise: a table the
   program did not make (one `JSONDecode` answered) is read by its shape, and
   an empty one of those is an `"object"`.

## Classes

`class` is sugar over the Lua idiom, and it lowers to that idiom and nothing
more: one table per class, holding its methods and its statics, and one table
per instance whose metatable is the class. An instance reaches the class
directly — nothing is copied per instance.

```ts
class Dog extends Animal {
    breed = "corgi"

    constructor(name: string) {
        super(name)
    }

    function speak(): string {
        return `${super.speak()} woof`
    }
}
```

```lua
local Dog = tilua_class(Animal)
function Dog.speak(this)
    return ("%s woof"):format(tostring(Animal.speak(this)))
end
function Dog.__init(this, name)
    Animal.__init(this, name)      -- super(name)
    this.breed = "corgi"           -- the field initializers, after super
end
function Dog.new(...)
    local this = setmetatable({}, Dog)
    Dog.__init(this, ...)
    return this
end
tilua_accessors(Dog)
```

`__init` is what `super(...)` calls: it runs the constructor on an instance
that already exists, so a derived class builds one table, not one per level.
`new` is a real function on the class table, and `Dog.new(x)` is how an
instance is built — the way Luau builds one. An `abstract class` has no `new`,
and an `abstract` method no function: both exist only to be checked.

A method named for a metamethod — `__add`, `__tostring`, `__call`, … — is an
ordinary function on the class table, and since the class table is its
instances' metatable, it works as one. Luau reads metamethods off the
metatable with `rawget`, never through its `__index`, so a class would not
inherit its base's: `tilua_class` copies them into each class that extends
another, and one the class writes itself replaces the copy.

Two links come with every class, and they cost an instance nothing because
they live on the class table: `ClassObject`, which an instance reads through
its metatable to reach its own class, and `ParentClass`, which a class reads
to reach the one it extends. The class table holds its `name` too
(`tilua_class(base, "Dog")`), so `rex.ClassObject.name` says what built an
instance.

A class written as a value (`const Counter = class { … }`) is the same code,
inside a function that runs where the class is written and hands the table
back — an expression has no room for statements. Type parameters leave no
trace at all: `Box<number>` and `Box<string>` compile to the one `Box`.

Two helpers go in at the top of any file that declares a class.
`tilua_class(base)` makes the table, points `__index` at it, and chains it to
the base — for the statics, and for the getter and setter tables. Getters and
setters are what the second helper is for: `tilua_accessors(class)` replaces
`__index` with a function *only* when the class or one it extends declares an
accessor. Every other class keeps the plain `__index = class` lookup, which is
the fast one.

## What a type library lowers

The compiler lowers tilua, and Lua's standard library, which every file has:
`pcall` answers one value, `console:log` prints where it was called, `error`
names the project's file (runtime/console.luau, runtime/result.luau). What a
*library* gives a value, the library also says how to run: `names:first()` is
a call to a function because the library that declared `first` ships the Luau
behind it.

A library names a module in its package.json (`"tilua": { "lowering":
"lowering.mjs" }`) whose default export answers for a call. The contract is
`LoweringPlugin`, declared in `@tilua/parser` and re-exported here, so a
library can be checked against it — by JSDoc, or in TypeScript — without
depending on the compiler:

```js
// @ts-check
/** @type {import("@tilua/parser").LoweringPlugin} */
const plugin = {
    runtime: { array: "local __NAME__ = {}\nfunction __NAME__.filter(t, test) ... end" },
    methodCall({ method, receiver, use }) {
        if (receiver?.kind === "array" && method === "filter") {
            return { callee: `${use("array")}.filter` }
        }
        return undefined
    },
}
export default plugin
```

`receiver` is the tilua type the analyzer worked out; `use(key)` names the
table from `runtime`, emitted once at the top of the output and only if a call
needed it; the receiver becomes the call's first argument unless
`passReceiver: false`. The last library loaded is asked first, and `undefined`
leaves an ordinary Luau method call.

Hooks also get the call site (`at`) and what the compiler knew about each
argument (`arguments`: type, the code it was written as, and what a name was
declared as). An answer can `prepend` Luau expressions ahead of the written
arguments. `globalCall` and `globalValue` answer for a global, such as
`print(x)` or a bare `print`. A runtime can read `__LINES__` to reach the
bundle's line map, and wraps a new array it answers with in `__ARRAY__(...)`. See the `@tilua/parser` README for the details.

`entryExports` answers for what a bundle whose entry exports returns: it is
handed that expression (`value`) and the entry's exports as an importer sees
them, and may answer another expression and statements to put before it.
`@tilua-types/luau` casts the exports table to its Luau type there, so a
script that `require`s the bundle knows what it got.

A library can add options to `tilua.config.json` by declaring them in its
package.json — `"tilua": { "options": { "typedExports": { "type": "boolean",
"default": true } } }` — and every hook is handed its library's own as
`options`. A key no loaded library declares is an unknown option. See the
`@tilua/parser` README.

A library for a Lua with more syntax than 5.1's lists it, and the output uses
it (see [Lua and Luau](#lua-and-luau)):

```js
export default { syntax: ["compoundAssignment", "continue", "ifExpression", "floorDivision",
    "iteration", "attributes", "numberLiterals", "requireByPath"] }
```
The standard library's own lowering (src/standard.ts) is written with these
hooks too; `"noLib": true` leaves it out with the library.

## Errors at runtime

A bundle is one Luau file, so a position Luau reports names a line of that
file. The entry therefore runs under `xpcall`. If an error reaches the top,
its message is rewritten from bundle lines to the places in the project that
wrote them, a traceback of those places is added, and the error is raised
again:

```
src/util.tilua:3: attempt to index nil with 'value'
    at src/util.tilua:3 (boom)
    at src/main.tilua:3 (load)
```

A message that is not a string is raised unchanged. A position that is already
in the project's files, such as one from the standard library's `error`, is
left as it is.

With several files each has its own line map, and a position is read by the
map of the file it names — matched by the end of that file's path, since the
Lua running it may call it by a full path, a relative one, or an Instance's.

The map is packed — the files it names once, then three base-64 VLQ numbers a
line, each counted from the line before — and read out the first time a line
is looked up, so a program that never fails never unpacks it.

For a release nobody will debug, `"lineMap": false` in `tilua.config.json`
(or `--noLineMap`, or `bundle({ lineMap: false })`) leaves out the map and
everything that reads it: the entry runs without `xpcall`, a callback handed
to Roblox is passed through unwrapped, and an error names the bundle's own
lines, as plain Luau would.

## Layout

`"indent": "\t"` (or a number of spaces) indents the output a block level at
a time; without it nothing is indented. `"minify": true` (or `--minify`, or
`bundle({ minify: true })`) writes the whole output on one line, keeping a `;`
only where the next statement starts with `(`. One line cannot be mapped back
to the project's, so a minified bundle goes without the line map, as with
`"lineMap": false`.

## Modules

Roblox's `require` takes an Instance, so the bundle has its own. Each module
is an entry in one table:

```lua
local G
G = {
    modules = {
        ["src/util"] = {
            names = { clamp = true },
            load = function(exports)
                function exports.clamp(x, lo, hi) ... end
            end,
        },
        ["src/main"] = {
            load = function(exports)
                local util
                util = G.require("src/util")
                print(util.clamp(5, 0, 1))
            end,
        },
    },
    records = {},
    require = function(name) ... end,
}
G.require("src/main")
```

Modules are named by their path from the project folder. An entry that
exports ends with `return G.require(...)`, so the bundle can itself be a
ModuleScript.

Modules follow ES module rules, including when they import each other:

- **Loading state.** A module's record exists, marked `loading`, before its
  code runs. When `a` imports `b` and `b` imports `a` back, `b` gets `a`'s
  exports as they stand instead of loading `a` again.
- **Hoisting.** Every top-level function is defined before a module's imports
  run, so `b` can call `a`'s functions in the middle of that cycle.
- **Initialization.** Reading an export its module has not initialized yet is
  an error — `Cannot access 'x' before initialization` — as reading a `let`
  before its declaration is in JavaScript.
- **Live bindings.** Exports live on the module's `exports` table and imports
  are read through it (`util.clamp`, never a copy), so a value set later — or
  a `let` changed later — is what the importer sees. Re-exports
  (`export { x } from`) and `export *` are references too: they read the
  other module on every access.
- **Read-only imports.** Assigning to an imported name, or to a member of a
  namespace (`import * as M`, then `M.x = 1`), is an error.
- **Types only.** `import type` is erased whatever it names, and so is an
  import used only as a type. A module reached only that way is left out of
  the bundle and never runs.
- **`import()`.** `import("./shop")` is `G.import("src/shop")`, and `G.import`
  is a wrapper around `G.require`: it answers the module's exports table — the
  value `import * as Shop` names — where the code runs, loading the module if
  nothing has yet. Nothing is awaited: Lua has no promises, and a module is
  loaded by calling it. The path is a string literal; the module it names is
  part of the bundle like any other.

## Tree shaking

`"treeShaking": true` in `tilua.config.json` (or `bundle({ treeShaking })`)
leaves out of the bundle what the entry never reaches:

- **Declarations nothing reads.** A top-level function, class or `const`
  that nothing kept reads, and whose value costs nothing to leave unmade — a
  literal, a function, a class whose statics are not calls. A `const` made by
  a call stays: the call is something the module does.
- **Exports nothing imports.** `import { a }` reads `a`, `M.a` reads `a` of
  `import * as M`, and anything else done with `M` — or `import("./x")` —
  reads every export. `export { a } from` and `export * from` pass a read on;
  the entry's exports are always read.
- **Modules nothing needs.** A module none of whose exports are read, and
  that does nothing as it runs, is not bundled. One that does something —
  prints, registers, connects — still runs where it is imported, as an ES
  module does, even if nothing it exports is read.
- **Runtime functions nothing calls.** The language's and the libraries'
  runtime tables keep the members the program calls, and what those call:
  `xs:map(f):join(",")` brings `map` and `join`, not the rest of the array
  methods.

Off by default: what is left out is decided from the code, and code that
reaches a module by a name only the running program knows — `G.require` of a
string built at runtime — is not something it can see.

## Several files

`"output"` in `tilua.config.json` (or `--output`, or `bundle({ output })`)
says how many files the project becomes:

| `output` | files |
|---|---|
| `"single"` (default) | one, holding every module |
| `"chunks"` | the entry's, holding what it reaches through `import` statements; one for each `import()` that leads somewhere else, holding what only it reaches; and one for what several of those share |
| `"files"` | no entry: one per file under `rootDir`, in the same place under `outDir`, and the runtime — see [A file per module](#a-file-per-module) |

```
tilua src/main.tilua --out build/main.luau --output chunks
# build/main.luau, build/main_src_shop.luau, ...
```

From the API, `result.files` holds every file with the path it has to be
written at, the entry's first; `outFile` names the entry's file, which the
others are named after.

The module table is the same one, filled by more than one file. The entry's
file has the runtime; every other file is a function that adds its modules:

```lua
return function(G)
    G.modules["src/shop"] = { load = function(exports) ... end }
end
```

`G.files` says which file each of those modules is in, and `require` loads
that file, once, the first time one of its modules is asked for — by an
`import()`, or by an `import` statement in a module that was itself loaded
late. So a file costs nothing until then.

How a file is loaded depends on the Lua (see [Lua and Luau](#lua-and-luau)):

| Lua | loads a file with |
|---|---|
| any | `loadfile(folder .. "main_src_shop.luau")()(G)`, where `folder` is the entry's own, read off `debug.getinfo` |
| Luau (`requireByPath`) | `require("./main_src_shop")(G)` — `require` by path, read from the entry's own file. In Roblox each file is a ModuleScript beside the entry's |

Either way the files have to stay where they were written, relative to the
entry's.

## A file per module

`"output": "files"` has no entry. Every `.tilua` under `rootDir` (a
definitions file aside) becomes a `.luau` in the same place under `outDir`,
as `tsc` writes `src` to `dist`, and each of them is a file a script can
`require`:

```jsonc
{ "types": ["roblox"], "output": "files", "rootDir": "src", "outDir": "dist" }
```

```
tilua            # the config above this folder says the rest
# dist/main.luau, dist/shop/buy.luau, ..., dist/_tilua.luau
```

`rootDir` is the config's folder unless set, and `outDir` is `rootDir`, so
each `.luau` lands beside its `.tilua`. Every file it writes ends with a line
saying tilua wrote it: the CLI never replaces a `.luau` without that line —
one written by hand — and removes one with it whose `.tilua` is gone.

With an `outDir` of its own, the CLI makes it a mirror of `rootDir`: every
`.tilua` compiled, every other file copied as it is, every folder there, and
nothing else. `outDir` is the build's alone, so it may not hold `rootDir` or
the project, nor sit under `rootDir`. `--out` names the folder in place of
`outDir`. From the API, `bundle({ output: "files", root })` without an
`entry`; `result.files` holds every file, its path from `outDir`.

The runtime — the module table, `require`, the line maps, and the helpers
the modules share, the language's and the libraries' runtimes, each set up
once — is a file of its own, `_tilua.luau`. Every other file requires it,
takes the helpers it names from it, adds its module to the table, and returns
the module's exports:

```lua
local G = require("../_tilua")
G.modules["src/shop/buy"] = { load = function(exports)
    local tax
    tax = G.require("src/shop/tax", function()
        return require("./tax")
    end)
    ...
end }
return G.run("src/shop/buy")
```

An `import` is still the runtime's `require`, so the modules behave as they
do in one file: a cycle gets the exports as they stand (Luau's own `require`
refuses one), and exports are live. The function after the name requires the
module's file by its path from this one, written out for the tools that
follow a `require`, and only if nothing has loaded it yet; an `import()` is
the same, where it runs. `run` is `require` under `xpcall` for the first file
asked for, so an error reaches the project's files once, however deep.

A file named `init.tilua` is the folder it is in, as Luau reads `init.luau`:
`import "./net"` finds `net/init.tilua`, the folder's files require it as
`./net`, and it requires them as `@self/remote`.

Where the files end up is the host's to say: a library's `files` hook can
place each file somewhere else, name the top of that tree (`@game`), move
the runtime, run something first in a file, and mark the files that are
scripts the host runs rather than modules — nothing may import one.
`@tilua-types/roblox` answers from a Rojo project.

A file is required by its path, which Luau reads and Lua 5.1 does not: the
output needs a library that says its Lua can (`requireByPath` — `"luau"`, or
`"roblox"`, which loads it). A file imported from outside `rootDir` has no
place under `outDir`, and is an error. Without an entry there is nothing to
reach things from, so `treeShaking` leaves no module out; it still leaves out
the runtime functions nothing calls.

`@tilua-types/luau` casts what each file returns to its module's exports, so
a script that requires any of them knows what it got.

<!-- compatibility:start -->
## Compatibility

`@tilua/compiler@9.0.1` works with these tilua packages. *Released with* is the
version it was built and tested against.

| Package | Range | Released with | |
| --- | --- | --- | --- |
| `@tilua/parser` | `^9.0.1` | 9.0.1 | dependency |
<!-- compatibility:end -->

## Development

```bash
npm test          # with a Luau interpreter on the PATH (or named by LUAU),
                  # the tests also run each bundle and check its output
npm run build
npm run typecheck
```
