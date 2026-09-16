import { readFileSync } from "node:fs"
import { compile } from "../src/index.js"
const r = await compile(readFileSync("tmp/s.tl", "utf8"))
console.log(r.code ?? r.diagnostics)
