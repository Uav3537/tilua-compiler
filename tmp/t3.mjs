import { compile } from "../dist/index.js"
const r = await compile('const a = [=[say "hi"]=]\nprint(a)\n')
console.log(r.code ?? r.diagnostics)
