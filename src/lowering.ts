/**
 * Loading the lowering a type library brings with it.
 *
 * The compiler lowers tilua itself — `import`, `export`, `a ? b : c`, `?.`,
 * destructuring, spreads, template strings, and the methods of the language's
 * own metatables (`names:filter(f)`, see language.ts): the things the language
 * means on its own. Everything a *library* gives a value it must also say how
 * to run: `names:first()` is a call to a function because the library that
 * declared `first` ships the Luau behind it, not because the compiler has heard
 * of `first`.
 *
 * A library names its module in package.json:
 *
 *     "tilua": { "types": "index.d.tilua", "lowering": "lowering.mjs" }
 *
 * and the module's default export is a `LoweringPlugin` (declared in
 * @tilua/parser, and re-exported here). A method a metatable gave the receiver
 * is asked of the library that declared the metatable alone; anything else of
 * each plugin, the last library loaded first, taking the first answer.
 */
import { pathToFileURL } from "node:url"
import type { LoweringPlugin } from "@tilua/parser"

// The contract itself is declared in @tilua/parser, so a type library can be
// written against it with `import type { LoweringPlugin } from "@tilua/parser"`
// — without depending on the compiler that calls it.
export type {
    LoweringPlugin, MethodCall, MethodLowering, GlobalCall, GlobalValue, CallLowering, CallSite, ArgumentInfo,
} from "@tilua/parser"

export interface LoadedLowering {
    readonly plugin: LoweringPlugin
    /** The package it came from, for reporting. */
    readonly from: string
    /** The package's definitions, as their index in the libraries the
     *  analyzer was given: a method read from a metatable they declare is
     *  this lowering's to answer. Absent for the language's own. */
    readonly library?: number
}

export interface LoweringProblem {
    readonly file: string
    readonly message: string
}

/** Load what the project's type libraries lower. A module that will not load,
 *  or exports the wrong shape, is reported and skipped: the rest of the build
 *  is still worth having. */
export async function loadLowerings(
    modules: readonly { file: string; from: string; library?: number }[],
): Promise<{ lowerings: LoadedLowering[]; problems: LoweringProblem[] }> {
    const lowerings: LoadedLowering[] = []
    const problems: LoweringProblem[] = []
    for (const module of modules) {
        try {
            const loaded = (await import(pathToFileURL(module.file).href)) as { default?: unknown }
            const plugin = loaded.default
            if (!plugin || typeof plugin !== "object") {
                problems.push({
                    file: module.file,
                    message: `'${module.from}' lowering module has no default export`,
                })
                continue
            }
            lowerings.push({ plugin: plugin as LoweringPlugin, from: module.from, library: module.library })
        } catch (error) {
            problems.push({
                file: module.file,
                message: `'${module.from}' lowering module failed to load: ${(error as Error).message}`,
            })
        }
    }
    return { lowerings, problems }
}
