// tilua -> Luau. The @tilua/parser AST is lowered to a luau-parser AST, which
// luau-parser prints; a project's modules are bundled into one file.
export { bundle, type BundleOptions, type BundleResult, type BundleDiagnostic } from "./bundle.js"
export { compile, type CompileResult, type Diagnostic } from "./compile.js"
export { resolveConfig, type ConfigInput, type TiluaConfigJson, type ResolvedConfig } from "./config.js"
export { lower, type LowerOptions, type LowerResult, type LowerDiagnostic, type ModuleContext } from "./lower.js"
// What a type library writes its lowering against.
export { loadLowerings, type LoadedLowering, type LoweringProblem } from "./lowering.js"
export type { LoweringPlugin, MethodCall, MethodLowering } from "./lowering.js"
