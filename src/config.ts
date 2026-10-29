/**
 * Which `tilua.config.json` a build uses.
 */
import { resolve } from "node:path"
import { findConfig, loadConfig, nodeHost, type ConfigProblem, type OutputMode, type TiluaConfig } from "@tilua/parser"

/** What `tilua.config.json` holds. */
export interface TiluaConfigJson {
    /** Type libraries to check against: `["roblox"]` loads `@tilua-types/roblox`. */
    types?: string[]
    /** Import path aliases, as in tsconfig: `{ "@shared/*": ["src/shared/*"] }`. */
    paths?: Record<string, string[]>
    /** Where `paths` targets resolve from. Default: the config's folder. */
    baseUrl?: string
    /** A Rojo sourcemap, or `null`. */
    sourceMap?: string | null
    /** How many files the output is. `"single"` (the default) is one file;
     *  `"chunks"` also writes a file for what only an `import()` reaches,
     *  loaded when it is first asked for; `"files"` has no entry, and
     *  compiles every file under `rootDir` to one of its own under `outDir`. */
    output?: OutputMode
    /** With `"files"`, the folder whose files are compiled. Default: the
     *  config's folder. */
    rootDir?: string
    /** With `"files"`, the folder the output goes in, laid out as `rootDir`
     *  is. Default: `rootDir`, each `.luau` beside its `.tilua`. */
    outDir?: string
    /** Leave out Lua's standard library — `print`, `string`, `pcall` — which
     *  is otherwise there for every file, as JavaScript's is in TypeScript. */
    noLib?: boolean
    /** Leave out of the bundle what the entry never reaches (`treeShake`). */
    treeShaking?: boolean
    /** Write the map from the bundle's lines back to the project's, which
     *  error reports and `console` read. Default: true. */
    lineMap?: boolean
    /** Indent the output, a block level at a time: `"\t"` or a number of
     *  spaces. Default: no indentation. */
    indent?: "\t" | number
    /** Write the output on one line, with as few `;` as it can take, and
     *  without the line map. Default: false. */
    minify?: boolean
    /** The options a type library in `types` declares, such as
     *  `@tilua-types/luau`'s `typedExports`. */
    [option: string]: unknown
}

/** A config file's path, or the config itself. Relative paths — to a config
 *  file, and inside an inline config — resolve from `cwd`. */
export type ConfigInput = string | TiluaConfigJson

export interface ResolvedConfig {
    readonly config?: TiluaConfig
    readonly problems: readonly ConfigProblem[]
}

/** The config for a build of `entry`: the one given, or else the nearest
 *  `tilua.config.json` above the entry. */
export function resolveConfig(input: ConfigInput | undefined, entry: string, cwd = process.cwd()): ResolvedConfig {
    if (input === undefined) return findConfig(entry)
    if (typeof input === "string") return loadConfig(resolve(cwd, input))
    const path = resolve(cwd, "tilua.config.json")
    const text = JSON.stringify(input, null, 2)
    return loadConfig(path, { readFile: file => (file === path ? text : nodeHost.readFile(file)) })
}
