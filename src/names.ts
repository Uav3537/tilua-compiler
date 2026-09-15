/**
 * Fresh local names for what lowering introduces — a destructuring temporary,
 * a required module, a helper function.
 *
 * A generated name must not capture or shadow anything the source means, so
 * every name the file mentions anywhere is taken up front. A name is only
 * reused by coincidence of a different spelling, never by accident.
 */
import type * as T from "@tilua/parser"

export class Names {
    private constructor(private readonly taken: Set<string>) {}

    /** The names `programs` mention — a bundle takes every module's, so that
     *  a name shared across modules (the module table) collides with none. */
    static from(...programs: T.Program[]): Names {
        // The globals generated code calls must stay visible to it.
        const taken = new Set<string>(["select", "pairs", "table", "tostring", "setmetatable", "error"])
        const walk = (value: unknown): void => {
            if (!value || typeof value !== "object") return
            if (Array.isArray(value)) {
                for (const item of value) walk(item)
                return
            }
            const node = value as { type?: unknown; name?: unknown }
            if (typeof node.name === "string" && node.name) taken.add(node.name)
            for (const [key, child] of Object.entries(value)) {
                if (key !== "line" && key !== "column") walk(child)
            }
        }
        for (const program of programs) walk(program)
        return new Names(taken)
    }

    /** A copy that goes on to take names independently — one per module, each
     *  starting from what the whole bundle already takes. */
    fork(): Names {
        return new Names(new Set(this.taken))
    }

    /** `base`, or `base2`, `base3`, ... — whichever is free first. */
    fresh(base: string): string {
        let name = base
        for (let n = 2; this.taken.has(name); n++) name = `${base}${n}`
        this.taken.add(name)
        return name
    }
}
