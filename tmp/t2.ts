import { compile } from "../src/index.js"
const src = [
 'const a = [=[say "hi"]=]',
 'const t = { k: [=[v"q"]=] }',
 'const f = `x ${[=[in"ner"]=]} y`',
 'print([=[arg"q"]=])',
 'const u = [=[q"]=] .. [=[r"]=]',
].join("\n")
const r = await compile(src)
console.log(r.code ?? r.diagnostics)
