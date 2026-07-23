import assertModule from 'assert'
import {promises as fs} from 'fs'

const assert = assertModule.strict
const source = (
  await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8')
)
  .replace(/^import .*\n\n/, '')
  .replace(/export function /g, 'function ')

function createHarness(payLnurl) {
  const tables = new Map()
  let now = 1_700_000_000
  let sequence = 0
  const table = name => {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }
  const storage = {
    get(name, id, fallback = null) {
      return table(name).get(id) ?? fallback
    },
    set(name, row) {
      table(name).set(row.id, structuredClone(row))
    },
    delete(name, id) {
      table(name).delete(id)
    },
    getPaginated(name, options = {}) {
      let rows = Array.from(table(name).values()).map(row =>
        structuredClone(row)
      )
      for (const [field, value] of Object.entries(options.filters || {})) {
        rows = rows.filter(row => row[field] === value)
      }
      const sortBy = options.sortBy || 'id'
      rows.sort((left, right) => {
        const result = (left[sortBy] ?? 0) < (right[sortBy] ?? 0) ? -1 : 1
        return options.descending ? -result : result
      })
      const offset = Number(options.offset || 0)
      const limit = Number(options.limit || rows.length)
      return {data: rows.slice(offset, offset + limit), total: rows.length}
    }
  }
  const system = {
    id(prefix) {
      sequence += 1
      return prefix + '_' + sequence
    },
    now() {
      now += 1
      return now
    }
  }
  const wallet = {
    listUserWallets() {
      return []
    },
    createInvoicePublic() {
      return {
        paymentHash: 'a'.repeat(64),
        paymentRequest: 'lnbc1invoice',
        checkingId: 'check_1'
      }
    },
    payLnurl
  }
  const api = Function(
    'storage',
    'system',
    'wallet',
    `${source}; return {
      saveSettings: saveBananabreadwasmSettings,
      createGame: createBananabreadwasmGame,
      getPublicGame: getPublicBananabreadwasmGame,
      settleKill: settleBananabreadwasmKill,
      expireDisconnect: expireBananabreadwasmDisconnect,
      retrySettlement: settleBananabreadwasmPayout
    }`
  )(storage, system, wallet)
  const invoke = (method, payload) => {
    const response = JSON.parse(api[method](JSON.stringify(payload)))
    if (!response.ok) throw new Error(response.error)
    return response.data
  }
  return {api, invoke, storage, tables}
}

function configure(harness) {
  return harness.invoke('saveSettings', {
    enabled: true,
    walletId: 'wallet_1',
    walletName: 'Arena',
    haircut: 10,
    gatewayUrl: 'https://arena.example.com',
    serverSecret: '0123456789abcdef0123456789abcdef'
  })
}

function addPlayer(harness, game, id, name, token) {
  harness.storage.set('bananabreadwasm_players', {
    id,
    game_id: game.id,
    name,
    ln_address: name.toLowerCase() + '@example.com',
    payment_hash: id,
    player_token: token,
    slot: id === 'killer' ? 1 : 2,
    status: 'alive',
    paid_amount: 100,
    killer_id: '',
    kill_event_id: '',
    payout_amount: 0,
    payout_status: '',
    payout_attempts: 0,
    disconnect_event_id: '',
    refund_amount: 0,
    refund_status: '',
    refund_attempts: 0,
    created_at: 1,
    paid_at: 1
  })
}

{
  const harness = createHarness(() => ({ok: true, success: true}))
  configure(harness)
  const minimum = harness.invoke('createGame', {joinAmount: 49}).game
  const maximum = harness.invoke('createGame', {joinAmount: 101}).game
  assert.equal(minimum.joinAmount, 50)
  assert.equal(maximum.joinAmount, 100)
  assert.equal(maximum.haircut, 10)
}

{
  const paymentRequests = []
  const harness = createHarness(request => {
    paymentRequests.push(request)
    return {ok: true, success: true, paymentHash: 'reward'}
  })
  configure(harness)
  const game = harness.invoke('createGame', {joinAmount: 100}).game
  addPlayer(harness, game, 'killer', 'KILLER', 'killer-ticket')
  addPlayer(harness, game, 'victim', 'VICTIM', 'victim-ticket')

  const first = harness.invoke('settleKill', {
    gameId: game.id,
    serverSecret: '0123456789abcdef0123456789abcdef',
    eventId: 'sour-death-1',
    killerPlayerId: 'killer',
    victimPlayerId: 'victim'
  })
  const duplicate = harness.invoke('settleKill', {
    gameId: game.id,
    serverSecret: '0123456789abcdef0123456789abcdef',
    eventId: 'sour-death-1',
    killerPlayerId: 'killer',
    victimPlayerId: 'victim'
  })

  assert.equal(first.duplicate, false)
  assert.equal(first.payout.amount, 90)
  assert.equal(first.victim.status, 'dead')
  assert.equal(duplicate.duplicate, true)
  assert.equal(paymentRequests.length, 1)
  assert.equal(paymentRequests[0].amount, 90)
  assert.equal(paymentRequests[0].maxSat, 90)
  assert.throws(
    () =>
      harness.invoke('settleKill', {
        gameId: game.id,
        eventId: 'browser-claim',
        killerPlayerId: 'killer',
        victimPlayerId: 'victim'
      }),
    /serverSecret/
  )
}

{
  let attempt = 0
  const harness = createHarness(() => {
    attempt += 1
    return attempt === 1
      ? {ok: false, error: 'temporary payment failure'}
      : {ok: true, success: true, paymentHash: 'retry-paid'}
  })
  configure(harness)
  const game = harness.invoke('createGame', {joinAmount: 100}).game
  addPlayer(harness, game, 'killer', 'KILLER', 'killer-ticket')
  addPlayer(harness, game, 'victim', 'VICTIM', 'victim-ticket')
  const killed = harness.invoke('settleKill', {
    gameId: game.id,
    serverSecret: '0123456789abcdef0123456789abcdef',
    eventId: 'sour-death-2',
    killerPlayerId: 'killer',
    victimPlayerId: 'victim'
  })
  assert.equal(killed.victim.payoutStatus, 'failed')
  const retried = harness.invoke('retrySettlement', {
    gameId: game.id,
    kind: 'all'
  })
  const noDuplicate = harness.invoke('retrySettlement', {
    gameId: game.id,
    kind: 'all'
  })
  assert.equal(retried.settlements.length, 1)
  assert.equal(retried.settlements[0].result.success, true)
  assert.equal(noDuplicate.settlements.length, 0)
  assert.equal(attempt, 2)
}

{
  const paymentRequests = []
  const harness = createHarness(request => {
    paymentRequests.push(request)
    return {ok: true, success: true, paymentHash: 'refund'}
  })
  configure(harness)
  const game = harness.invoke('createGame', {joinAmount: 100}).game
  addPlayer(harness, game, 'player', 'PLAYER', 'player-ticket')
  const first = harness.invoke('expireDisconnect', {
    gameId: game.id,
    serverSecret: '0123456789abcdef0123456789abcdef',
    eventId: 'disconnect-1',
    playerId: 'player'
  })
  const duplicate = harness.invoke('expireDisconnect', {
    gameId: game.id,
    serverSecret: '0123456789abcdef0123456789abcdef',
    eventId: 'disconnect-1',
    playerId: 'player'
  })
  assert.equal(first.player.status, 'left')
  assert.equal(first.refund.amount, 100)
  assert.equal(duplicate.duplicate, true)
  assert.equal(paymentRequests.length, 1)
}

console.log('BananaBread authoritative settlement tests passed')
