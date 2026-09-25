/**
 * Turning a line of the bundle back into a place in the project.
 *
 * A bundle is one Luau file. Everything Luau says at runtime — a traceback, an
 * error's position — is a line in *that* file, which tells the author nothing:
 * the code they wrote lives in `src/shop/buy.tilua`, not on line 4117 of a
 * generated file they have never opened. `console:error` is only worth having
 * if it can say the first one.
 *
 * Lowering stamps every emitted statement with the source line it came from
 * (`LowerResult.origins`), and the bundler knows which file each module's
 * statements were lowered from. What is missing is the third number: which
 * line of the *output* each statement was printed on, which only the printer
 * knows and does not report.
 *
 * So the output is read back. Printing is canonical — `print(parse(print(x)))`
 * is `print(x)` exactly — so parsing the printed text gives the same
 * statements in the same order, each now carrying the line it was printed on.
 * Walking the two trees together pairs them up. If they ever disagree the map
 * is abandoned rather than guessed at: a wrong line is worse than none.
 */
import type { Program, Statement } from "luau-parser"
import { luauString } from "@tilua/parser"

/** Where a statement was written. */
export interface Origin {
    /** Path of the source file, as the project refers to it. */
    readonly file: string
    /** 1-based line in that file. */
    readonly line: number
}

/** Every statement of `node`, in the order the printer will emit them. Both
 *  trees are walked by this one function, so the order cannot drift between
 *  them — the risk with walking a built tree and a parsed one is that their
 *  keys are in different orders, and using the same walk removes it. */
function statementsOf(node: unknown): Statement[] {
    const out: Statement[] = []
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return
        if (Array.isArray(value)) return void value.forEach(visit)
        const record = value as Record<string, unknown>
        if (typeof record.type === "string" && record.type.endsWith("Statement")) {
            out.push(value as Statement)
        }
        for (const [key, child] of Object.entries(record)) {
            if (key !== "line" && key !== "column") visit(child)
        }
    }
    visit(node)
    return out
}

/**
 * The line of the bundle each source line landed on.
 *
 * `emitted` is the tree that was printed, `printed` a parse of that text, and
 * `origins` says where each emitted statement came from. The result maps a
 * bundle line to the place in the project that wrote it.
 */
export function buildLineMap(
    emitted: Program,
    printed: Program,
    origins: WeakMap<Statement, Origin>,
): Map<number, Origin> {
    const before = statementsOf(emitted)
    const after = statementsOf(printed)
    if (before.length !== after.length) return new Map()

    const map = new Map<number, Origin>()
    for (let i = 0; i < before.length; i++) {
        // The two walks have diverged; nothing after this point can be trusted.
        if (before[i].type !== after[i].type) return new Map()
        const origin = origins.get(before[i])
        if (!origin) continue
        const line = after[i].line.start
        // The first statement on a line wins: a line holding several is read
        // as starting where the first of them did.
        if (!map.has(line)) map.set(line, origin)
    }
    return map
}

/** The map as Luau source: `{ [12] = { "src/a.tilua", 3 }, ... }`.
 *
 *  Written as text rather than built as a tree because it is data, it is large,
 *  and it is the one thing in the output whose own line numbers do not matter. */
export function lineMapSource(map: ReadonlyMap<number, Origin>): string {
    const entries = [...map.entries()].sort((a, b) => a[0] - b[0])
    const quoted = (s: string): string => luauString(s.replace(/\\/g, "/"))
    return `{${entries.map(([line, o]) => `[${line}]={${quoted(o.file)},${o.line}}`).join(",")}}`
}
