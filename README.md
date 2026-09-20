# @tilua/compiler

Compiles a [tilua](https://marketplace.visualstudio.com/search?term=tilua)
project to one Luau file. Each file is parsed by
[`@tilua/parser`](https://www.npmjs.com/package/@tilua/parser), its AST lowered
to a `luau-parser` AST, and that AST printed by `luau-parser`.

```bash
npm i -D @tilua/compiler @tilua-types/roblox
npx tilua src/main.tilua --out build/main.luau
```

```
tilua <entry> [--out <file>] [--config <tilua.config.json>] [--noCheck] [--target luau|lua51]
```

Every module the entry imports is bundled in. Problems are reported as
`file:line:column message`. Type errors are checked against the config's
`types`: they are reported, but the bundle is still written (`--noCheck` skips
the check). A syntax error or a missing module stops the build.

Without `--out`, the entry's own path with `.luau` is written. Without
`--config`, the nearest `tilua.config.json` above the entry applies — see the
[`@tilua/parser`](https://www.npmjs.com/package/@tilua/parser) README for what
goes in it.

## API

```ts
import { bundle, compile } from "@tilua/compiler"

const result = await bundle({
    entry: "src/main.tilua",
    // A config file's path, or its contents:
    config: { types: ["roblox"], paths: { "@shared/*": ["src/shared/*"] } },
})
result.code          // the Luau bundle, unless a module failed
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

| tilua | Luau |
|---|---|
| `const { a, b } = value` | `local a, b = value.a, value.b` |
| `const [x, ...rest] = list` | `local x = list[1]; local rest = table.move(list, 2, #list, 1, {})` |
| `const { a = 1 } = t` | `local a = t.a; if a == nil then a = 1 end` |
| `[1, 2]` / `{ a: 1, b }` | `{ 1, 2 }` / `{ a = 1, b = b }` |
| `{ ...base, a: 1 }` / `[...xs, 1]` | a small helper copying the parts in order |
| `` `${a} any` `` | `("%s any"):format(tostring(a))` |
| `a?.b` | `if a == nil then nil else a.b` |
| `a?:m()` as a statement | `if a ~= nil then a:m() end` |
| `f()?.b?:m(x)` | a function call that keeps each link in a local, so every link runs once, in order, and none after a nil |
| `function f(n = 1, { x })` | `function f(n, arg) if n == nil then n = 1 end local x = arg.x ...` |
| `const` / `let` | `local` |
| `class C { … }` | one table for the class, one per instance — see below |
| `return [a, b]` | `return { a, b }` — several results are an array |
| `for (const item in xs)` | `for _, item in xs do … end` — an array or a table walked for its values |
| `for (const item in step)` | `for item in step do … end` — an iterator function |
| `for (const [k, v] in pairs(t))` | `for item in unpack(pairs(t), 1, 3) do local k, v = item[1], item[2] … end` — an iteration is `[step, state, first]` |
| `pcall(f)`, and other globals Luau answers several values from | the type library's own function, answering one — see below |
| `function f(a, ...rest)` | `function f(a, ...) local rest = {...}` |
| `scriptArgs` | the chunk's own `...`, as `local scriptArgs = { ... }` |
| `f(a, ...xs)` | `table.unpack(xs)` in the last position |
| `f(...xs, a)` | the list built first, then `table.unpack` of it |
| `x as T`, `x satisfies T`, types, `declare` | removed |
| `names:filter(f)` | whatever the type library that declared `filter` says — see below |

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
to reach the one it extends.

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

The compiler lowers tilua. What a *library* gives a value, the library also
says how to run: `names:filter(f)` is a call to a function because
[`@tilua-types/lua`](https://www.npmjs.com/package/@tilua-types/lua) declares
the method and ships the Luau behind it.

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
bundle's line map. See the `@tilua/parser` README for the details.
`console:log` is not built into the compiler: `@tilua-types/lua` implements it
with these hooks.

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
in the project's files, such as one from `error` in `@tilua-types/lua`, is
left as it is.

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

## Development

```bash
npm test          # with a Luau interpreter on the PATH (or named by LUAU),
                  # the tests also run each bundle and check its output
npm run build
npm run typecheck
```
