import { compile } from "../src/index.js"
const cases = [
  'const a = [==[a\nb]==]',
  'const a = [[quote " here]]',
  'const a = [==[back \ slash]==]',
  'const a = [==[interp ${x} ok]==]',
  'const a = `tpl "q" ${1}`',
  'const a = [==[\nleading newline]==]',
]
for (const c of cases) console.log(c, "=>", JSON.stringify((await compile(c + "\nprint(a)\n")).code ?? (await compile(c+"\nprint(a)\n")).diagnostics))
