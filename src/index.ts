// tilua -> Lua. The @tilua/parser AST is lowered to a luau-parser AST, which
// luau-parser prints; a project's modules are bundled into one file. What it
// writes runs on Lua 5.1 to 5.4, LuaJIT and Luau; a library says what more
// its Lua has (`LoweringPlugin.syntax`).
export { bundle, WRITTEN_BY_TILUA, type BundleOptions, type BundleResult, type BundleFile, type BundleDiagnostic } from "./bundle.js"
export { compile, type CompileResult, type Diagnostic } from "./compile.js"
export { resolveConfig, type ConfigInput, type TiluaConfigJson, type ResolvedConfig } from "./config.js"
export { lower, type LowerOptions, type LowerResult, type LowerDiagnostic, type ModuleContext } from "./lower.js"
// What a type library writes its lowering against.
export { loadLowerings, type LoadedLowering, type LoweringProblem } from "./lowering.js"
export type {
    LoweringPlugin, LuaSyntax, MethodCall, MethodLowering, PluginContext, EntryExports, EntryExportsLowering,
    FilesLayout, FilesAnswer,
} from "./lowering.js"
