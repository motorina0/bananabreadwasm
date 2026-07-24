import assertModule from 'assert'
import {promises as fs} from 'fs'

const assert = assertModule.strict
const publicSource = await fs.readFile(
  new URL('../../static/public.js', import.meta.url),
  'utf8'
)
const publicHtml = await fs.readFile(
  new URL('../../ui/public.html', import.meta.url),
  'utf8'
)

assert.match(publicSource, /joinGame/)
assert.match(publicSource, /subscribePayment/)
assert.match(publicSource, /enterUrl/)
assert.doesNotMatch(publicSource, /declareWinner|settleKill|\/server\/kill/)
assert.doesNotMatch(publicHtml, /bb\.wasm|q1k3|packed\.js/)
assert.match(publicHtml, /target="_top"/)
assert.match(publicHtml, /The Sour server—not a browser—confirms every kill/)
assert.match(publicSource, /ADMISSIONS PAUSED/)

console.log('BananaBread paid lobby browser-boundary tests passed')
