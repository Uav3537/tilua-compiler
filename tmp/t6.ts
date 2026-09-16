import { compile } from "../src/index.js"
const r = await compile('const x = 1\nconst a = `100% done ${x}`\nprint(a)\n')
console.log(r.code ?? r.diagnostics)
