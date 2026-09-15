/**
 * Which `tilua.config.json` a build uses.
 */
import { resolve } from "node:path"
import { findConfig, loadConfig, nodeHost, type ConfigProblem, type TiluaConfig } from "@tilua/parser"
import type { Target } from "./lower.js"

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
    /** Which Lua the output must run on. `"luau"` (the default) keeps Luau's
     *  own syntax; `"lua51"` also lowers what stock Lua 5.1 cannot parse —
     *  `a += b`, `continue`, `if c then a else b` as an expression, `//`,
     *  digit separators and binary literals. */
    target?: Target
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
