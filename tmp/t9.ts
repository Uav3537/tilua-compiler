import { compile } from "../src/index.js"
const r = await compile('--[==[ block\ncomment with " quote ]==]\nconst a = 1\nprint(a)\n')
console.log(r.code ?? r.diagnostics)
