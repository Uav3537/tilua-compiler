import { compile } from "../src/index.js"
const src = ['const a = "nul' + String.fromCharCode(92) + '0' + '5 digit"', 'print(#a)', ''].join("\n")
console.log(JSON.stringify(src))
const r = await compile(src)
console.log(r.code ?? r.diagnostics)
