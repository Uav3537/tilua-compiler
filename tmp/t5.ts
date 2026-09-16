import { compile } from "../src/index.js"
// source text built with String.raw so what you see is what the file holds
const src = String.raw`const a = [=[back \ slash, \n not newline, \" quote, ]] bracket, "dq"]=]
print(a)
`
console.log("SOURCE:\n" + src)
const r = await compile(src)
console.log("OUT:\n" + (r.code ?? JSON.stringify(r.diagnostics)))
