import { compile } from "../src/index.js"
const bs = String.fromCharCode(92)
for (const s of ['"nul' + bs + '0' + '5 d"', '"tab' + bs + 'x07 bel"']) {
  const r = await compile('const a = ' + s + '\nprint(a)\n')
  console.log(JSON.stringify(s), "=>", JSON.stringify(r.code ?? r.diagnostics))
}
