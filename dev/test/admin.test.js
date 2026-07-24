import assertModule from 'assert'
import {promises as fs} from 'fs'

const assert = assertModule.strict
const source = await fs.readFile(
  new URL('../../static/admin.js', import.meta.url),
  'utf8'
)
const notifications = []
const savedPayloads = []
let component = null

const client = {
  notify(message, type) {
    notifications.push({message, type})
    return Promise.resolve()
  },
  saveSettings(payload) {
    savedPayloads.push(structuredClone(payload))
    return Promise.resolve({
      settings: {
        ...payload,
        gatewayUrl: String(payload.gatewayUrl || '').replace(/\/+$/, ''),
        updatedAt: 1
      }
    })
  }
}
const window = {
  createLNbitsExtensionClient() {
    return client
  },
  crypto: {
    getRandomValues(bytes) {
      bytes.fill(1)
      return bytes
    }
  }
}
const Vue = {
  createApp(options) {
    component = options
    return {
      mount() {},
      use() {
        return this
      }
    }
  },
  h() {}
}
const Quasar = {
  Notify: {
    create() {}
  }
}

Function('window', 'Vue', 'Quasar', source)(window, Vue, Quasar)
assert.ok(component)

function createViewModel() {
  const viewModel = {
    ...component.data(),
    ...component.methods
  }
  for (const [name, getter] of Object.entries(component.computed)) {
    Object.defineProperty(viewModel, name, {
      configurable: true,
      get: () => getter.call(viewModel)
    })
  }
  return viewModel
}

const viewModel = createViewModel()
viewModel.settings.enabled = true
assert.equal(viewModel.canSave, false)
assert.match(viewModel.walletError, /Select an LNbits wallet/)
await viewModel.saveSettings()
assert.equal(savedPayloads.length, 0)
assert.match(notifications.at(-1).message, /Select an LNbits wallet/)

viewModel.wallets = [{id: 'wallet_1', name: 'Arena'}]
viewModel.settings.gatewayUrl = 'http://arena.example.com'
assert.match(viewModel.gatewayError, /HTTPS/)
viewModel.settings.gatewayUrl = 'http://localhost:1340/'
viewModel.settings.serverSecret = '0123456789abcdef0123456789abcdef'
assert.equal(viewModel.canSave, true)
await viewModel.saveSettings()
assert.equal(savedPayloads.length, 1)
assert.equal(viewModel.settingsAreSaved, true)
assert.equal(viewModel.canCreate, true)

viewModel.settings.gatewayUrl = 'https://new-arena.example.com'
assert.equal(viewModel.settingsAreSaved, false)
assert.equal(viewModel.canCreate, false)

assert.doesNotMatch(source, /Enable paid arenas/)
assert.match(source, /label: 'Enable arenas'/)

console.log('BananaBread admin settings tests passed')
