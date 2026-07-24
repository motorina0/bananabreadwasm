import {storage, system, wallet} from './lnbits-sdk.js'

const SETTINGS_TABLE = 'bananabreadwasm_settings'
const GAMES_TABLE = 'bananabreadwasm_games'
const PLAYERS_TABLE = 'bananabreadwasm_players'
const SETTINGS_ID = 'bananabreadwasm-settings'
const MAX_PLAYERS = 5
const MIN_JOIN_SATS = 50
const MAX_JOIN_SATS = 100
const DEFAULT_HAIRCUT = 10
const DISCONNECT_GRACE_SECONDS = 60
const GAME_SEARCH_FIELDS = ['name', 'status']

export function getBananabreadwasmSettings(_requestJson) {
  return runJson(() => ({settings: ownerSettings(getSettings())}))
}

export function saveBananabreadwasmSettings(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const existing = getSettings()
    const now = system.now()
    const settings = {
      id: SETTINGS_ID,
      wallet_id: cleanText(request.walletId ?? request.wallet_id, 128),
      wallet_name: cleanText(request.walletName ?? request.wallet_name, 120),
      enabled: request.enabled === true,
      haircut: normalizeInteger(request.haircut, DEFAULT_HAIRCUT, 0, 100),
      gateway_url: normalizeGatewayUrl(
        request.gatewayUrl ?? request.gateway_url
      ),
      server_secret: cleanText(
        request.serverSecret ?? request.server_secret,
        256
      ),
      created_at: existing.created_at || now,
      updated_at: now
    }
    if (settings.enabled && !settings.wallet_id) {
      throw new Error('walletId is required when BananaBread is enabled.')
    }
    if (settings.enabled && !settings.gateway_url) {
      throw new Error('gatewayUrl is required when BananaBread is enabled.')
    }
    if (settings.enabled && settings.server_secret.length < 32) {
      throw new Error(
        'serverSecret must contain at least 32 characters when BananaBread is enabled.'
      )
    }
    storage.set(SETTINGS_TABLE, settings)
    return {settings: ownerSettings(settings)}
  })
}

export function listBananabreadwasmWallets(_requestJson) {
  return runJson(() => ({wallets: wallet.listUserWallets()}))
}

export function createBananabreadwasmGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const settings = getSettings()
    if (!settings.enabled) throw new Error('BananaBread arenas are disabled.')
    validateEnabledSettings(settings)
    const now = system.now()
    const game = {
      id: cleanId(request.id) || idValue(system.id('arena')),
      settings_id: settings.id,
      wallet_id: settings.wallet_id,
      gateway_url: settings.gateway_url,
      server_secret: settings.server_secret,
      name: cleanText(request.name, 80) || 'BananaBread public arena',
      join_amount: normalizeInteger(
        request.joinAmount ?? request.join_amount,
        MAX_JOIN_SATS,
        MIN_JOIN_SATS,
        MAX_JOIN_SATS
      ),
      haircut: normalizeInteger(
        request.haircut ?? settings.haircut,
        settings.haircut,
        0,
        100
      ),
      players_count: 0,
      max_players: MAX_PLAYERS,
      status: 'active',
      created_at: now,
      updated_at: now
    }
    storage.set(GAMES_TABLE, game)
    return {
      game: publicGame(game),
      publicUrl: '/bananabreadwasm/games/' + game.id
    }
  })
}

export function listBananabreadwasmGames(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const rowsPerPage = normalizePageSize(request.rowsPerPage)
    const page = normalizePage(request.page)
    const response = storage.getPaginated(GAMES_TABLE, {
      search: cleanText(request.search, 256),
      searchFields: GAME_SEARCH_FIELDS,
      sortBy: normalizeGameSortBy(request.sortBy),
      descending: request.descending === true || request.descending === 'true',
      limit: rowsPerPage,
      offset: (page - 1) * rowsPerPage
    })
    return {
      games: response.data.map(game => ownerGame(withFreshPlayerCount(game))),
      total: response.total
    }
  })
}

export function deleteBananabreadwasmGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    getGame(gameId)
    const players = playersForGame(gameId, 100)
    if (players.some(player => player.status === 'alive')) {
      throw new Error(
        'Remove or settle all live players before deleting this arena.'
      )
    }
    if (players.some(hasUnresolvedSettlement)) {
      throw new Error(
        'Retry or resolve all pending settlements before deleting this arena.'
      )
    }
    for (const player of players) storage.delete(PLAYERS_TABLE, player.id)
    storage.delete(GAMES_TABLE, gameId)
    return {deleted: true, gameId}
  })
}

export function getPublicBananabreadwasmGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const game = withFreshPlayerCount(getGame(gameId))
    const admissionsEnabled = getSettings().enabled === true
    const token = cleanText(request.playerToken ?? request.player_token, 128)
    const player = token ? playerForToken(game.id, token) : null
    return {
      game: publicGame(game),
      players: playersForGame(game.id, 100)
        .filter(item => ['alive', 'dead'].includes(item.status))
        .map(item => publicPlayer(item, false)),
      player: player ? publicPlayer(player, true, game) : null,
      canJoin:
        admissionsEnabled &&
        game.status === 'active' &&
        alivePlayersForGame(game.id).length < MAX_PLAYERS,
      admissionsEnabled,
      minimumJoinSats: MIN_JOIN_SATS,
      maximumJoinSats: MAX_JOIN_SATS,
      disconnectGraceSeconds: DISCONNECT_GRACE_SECONDS,
      serverTimeMs: system.now() * 1000
    }
  })
}

export function joinBananabreadwasmGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    if (!getSettings().enabled) {
      throw new Error('Arena admissions are disabled.')
    }
    if (game.status !== 'active') throw new Error('This arena is not active.')
    if (alivePlayersForGame(game.id).length >= MAX_PLAYERS) {
      throw new Error('This arena is full.')
    }
    const lnAddress = normalizeLnAddress(
      request.lnAddress ?? request.ln_address
    )
    const playerName = cleanText(request.name, 18) || 'PLAYER'
    const playerToken = idValue(system.id('player'))
    const invoice = wallet.createInvoicePublic({
      sourceId: game.id,
      amount: Number(game.join_amount),
      currency: 'sat',
      memo: 'BananaBread Arena entry for ' + playerName,
      extra: {
        game_id: game.id,
        ln_address: lnAddress,
        player_name: playerName,
        player_token: playerToken
      }
    })
    return {
      playerToken,
      paymentHash: invoice.paymentHash,
      paymentRequest: invoice.paymentRequest,
      checkingId: invoice.checkingId
    }
  })
}

export function recordBananabreadwasmPayment(eventJson) {
  return runJson(() => {
    const event = parseJsonObject(eventJson)
    const paymentHash = eventPaymentHash(event)
    if (!paymentHash) throw new Error('paymentHash is required.')
    const extra =
      event.extra?.extra_bananabreadwasm ||
      event.payment?.extra?.extra_bananabreadwasm ||
      {}
    const gameId = cleanText(
      extra.game_id || event.extra?.game_id || event.payment?.extra?.game_id,
      128
    )
    const lnAddress = normalizeLnAddress(
      extra.ln_address ||
        event.extra?.ln_address ||
        event.payment?.extra?.ln_address
    )
    const playerName =
      cleanText(
        extra.player_name ||
          event.extra?.player_name ||
          event.payment?.extra?.player_name,
        18
      ) || 'PLAYER'
    const playerToken = cleanText(
      extra.player_token ||
        event.extra?.player_token ||
        event.payment?.extra?.player_token ||
        paymentHash,
      128
    )
    const game = getGame(gameId)
    const existing = storage.get(PLAYERS_TABLE, paymentHash, null)
    if (existing) {
      return {
        game: publicGame(withFreshPlayerCount(game)),
        player: publicPlayer(existing, true, game),
        status: existing.status
      }
    }
    const paidAmount =
      Math.trunc(
        Math.abs(Number(event.amount || event.payment?.amount || 0)) / 1000
      ) || Number(game.join_amount)
    if (alivePlayersForGame(game.id).length >= MAX_PLAYERS) {
      const refused = makePlayer({
        paymentHash,
        game,
        lnAddress,
        playerName,
        playerToken,
        slot: 0,
        status: 'refund-processing',
        paidAmount
      })
      storage.set(PLAYERS_TABLE, refused)
      const payout = refundPlayer(
        game,
        refused,
        'Arena filled before payment settled.'
      )
      const refunded = applyRefund(refused, payout)
      storage.set(PLAYERS_TABLE, refunded)
      return {
        game: publicGame(withFreshPlayerCount(game)),
        player: publicPlayer(refunded, true, game),
        status: refunded.status,
        refund: payout
      }
    }
    const player = makePlayer({
      paymentHash,
      game,
      lnAddress,
      playerName,
      playerToken,
      slot: nextSlot(game.id),
      status: 'alive',
      paidAmount
    })
    storage.set(PLAYERS_TABLE, player)
    const updatedGame = withFreshPlayerCount({
      ...game,
      updated_at: system.now()
    })
    storage.set(GAMES_TABLE, updatedGame)
    return {
      game: publicGame(updatedGame),
      player: publicPlayer(player, true, game),
      status: 'alive'
    }
  })
}

export function admitBananabreadwasmPlayer(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    requireServerSecret(game, request)
    const token = requiredText(
      request.playerToken ?? request.player_token,
      'playerToken',
      128
    )
    const player = requireAlivePlayer(game.id, token)
    const connected = {
      ...player,
      connected_at: player.connected_at || system.now(),
      disconnected_at: null,
      last_seen_at: system.now()
    }
    storage.set(PLAYERS_TABLE, connected)
    return {
      admitted: true,
      gameId: game.id,
      roomKey: 'lnbits-' + game.id,
      playerId: player.id,
      playerName: player.name,
      maxPlayers: MAX_PLAYERS,
      disconnectGraceSeconds: DISCONNECT_GRACE_SECONDS,
      returnPath:
        '/ext/bananabreadwasm/games/' +
        encodeURIComponent(game.id) +
        '?playerToken=' +
        encodeURIComponent(token)
    }
  })
}

export function settleBananabreadwasmKill(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    requireServerSecret(game, request)
    const eventId = requiredText(
      request.eventId ?? request.event_id,
      'eventId',
      160
    )
    const killer = requirePlayerId(
      game.id,
      request.killerPlayerId ?? request.killer_player_id,
      'killerPlayerId'
    )
    const victim = requirePlayerId(
      game.id,
      request.victimPlayerId ?? request.victim_player_id,
      'victimPlayerId'
    )
    if (killer.id === victim.id) {
      throw new Error('Self kills cannot be paid out.')
    }
    if (victim.status !== 'alive') {
      if (victim.kill_event_id === eventId) {
        return {
          duplicate: true,
          killer: publicPlayer(killer, false),
          victim: publicPlayer(victim, false),
          payout: storedPayout(victim)
        }
      }
      throw new Error('Victim is not alive in this arena.')
    }
    if (killer.status !== 'alive') {
      throw new Error('Killer is not alive in this arena.')
    }
    if (alivePlayersForGame(game.id).length < 2) {
      throw new Error('Rewards require at least two paid live players.')
    }
    const paidAmount = Number(victim.paid_amount || game.join_amount)
    const payoutAmount = Math.max(
      0,
      Math.floor((paidAmount * (100 - Number(game.haircut || 0))) / 100)
    )
    const locked = {
      ...victim,
      status: 'dead',
      killer_id: killer.id,
      kill_event_id: eventId,
      payout_amount: payoutAmount,
      payout_status: payoutAmount > 0 ? 'processing' : 'withheld',
      payout_attempts: Number(victim.payout_attempts || 0),
      killed_at: system.now(),
      last_seen_at: system.now()
    }
    storage.set(PLAYERS_TABLE, locked)
    const payout =
      payoutAmount > 0 ? payKillReward(game, killer, locked) : withheldPayout()
    const killed = applyPayout(locked, payout)
    storage.set(PLAYERS_TABLE, killed)
    updateGameCount(game)
    return {
      duplicate: false,
      killer: publicPlayer(killer, false),
      victim: publicPlayer(killed, false),
      payout
    }
  })
}

export function expireBananabreadwasmDisconnect(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    requireServerSecret(game, request)
    const eventId = requiredText(
      request.eventId ?? request.event_id,
      'eventId',
      160
    )
    const player = requirePlayerId(
      game.id,
      request.playerId ?? request.player_id,
      'playerId'
    )
    if (player.status !== 'alive') {
      if (player.disconnect_event_id === eventId) {
        return {
          duplicate: true,
          player: publicPlayer(player, false),
          refund: storedRefund(player)
        }
      }
      throw new Error('Player is not alive in this arena.')
    }
    const locked = {
      ...player,
      status: 'refund-processing',
      disconnect_event_id: eventId,
      refund_amount: Number(player.paid_amount || game.join_amount),
      refund_status: 'processing',
      refund_attempts: Number(player.refund_attempts || 0),
      disconnected_at: system.now(),
      last_seen_at: system.now()
    }
    storage.set(PLAYERS_TABLE, locked)
    const refund = refundPlayer(game, locked, 'Disconnected for 60 seconds.')
    const expired = applyRefund(locked, refund)
    storage.set(PLAYERS_TABLE, expired)
    updateGameCount(game)
    return {
      duplicate: false,
      player: publicPlayer(expired, false),
      refund
    }
  })
}

export function settleBananabreadwasmPayout(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    const playerId = cleanText(request.playerId ?? request.player_id, 256)
    const kind = cleanText(request.kind || 'all', 16).toLowerCase()
    if (!['all', 'payout', 'refund'].includes(kind)) {
      throw new Error('kind must be all, payout, or refund.')
    }
    const candidates = playerId
      ? [requirePlayerId(game.id, playerId, 'playerId')]
      : playersForGame(game.id, 100)
    const settlements = []
    for (const player of candidates) {
      if (
        ['all', 'payout'].includes(kind) &&
        player.payout_status === 'failed'
      ) {
        const killer = requirePlayerId(
          game.id,
          player.killer_id,
          'killerPlayerId'
        )
        const locked = {...player, payout_status: 'processing'}
        storage.set(PLAYERS_TABLE, locked)
        const payout = payKillReward(game, killer, locked)
        const settled = applyPayout(locked, payout)
        storage.set(PLAYERS_TABLE, settled)
        settlements.push({
          kind: 'payout',
          playerId: player.id,
          result: payout
        })
      }
      const current = storage.get(PLAYERS_TABLE, player.id, player)
      if (
        ['all', 'refund'].includes(kind) &&
        current.refund_status === 'failed'
      ) {
        const locked = {
          ...current,
          status: 'refund-processing',
          refund_status: 'processing'
        }
        storage.set(PLAYERS_TABLE, locked)
        const refund = refundPlayer(
          game,
          locked,
          'Retrying failed disconnect refund.'
        )
        const settled = applyRefund(locked, refund)
        storage.set(PLAYERS_TABLE, settled)
        settlements.push({
          kind: 'refund',
          playerId: player.id,
          result: refund
        })
      }
    }
    return {
      settled: settlements.length > 0,
      settlements,
      unresolvedCount: settlementCounts(game.id).unresolved
    }
  })
}

function runJson(fn) {
  try {
    return JSON.stringify({ok: true, data: fn()})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return JSON.stringify({ok: false, error: message})
  }
}

function parseJsonObject(value) {
  if (!value) return {}
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request must be a JSON object.')
  }
  return parsed
}

function getSettings() {
  return storage.get(SETTINGS_TABLE, SETTINGS_ID, defaultSettings())
}

function defaultSettings() {
  const now = system.now()
  return {
    id: SETTINGS_ID,
    wallet_id: '',
    wallet_name: '',
    enabled: false,
    haircut: DEFAULT_HAIRCUT,
    gateway_url: '',
    server_secret: '',
    created_at: now,
    updated_at: now
  }
}

function validateEnabledSettings(settings) {
  if (!settings.wallet_id)
    throw new Error('BananaBread wallet is not configured.')
  if (!settings.gateway_url)
    throw new Error('BananaBread gateway is not configured.')
  if (String(settings.server_secret || '').length < 32) {
    throw new Error('BananaBread server secret is not configured.')
  }
}

function getGame(gameId) {
  const game = storage.get(GAMES_TABLE, gameId, null)
  if (!game) throw new Error('BananaBread arena not found.')
  return game
}

function playersForGame(gameId, limit = 25) {
  return storage.getPaginated(PLAYERS_TABLE, {
    filters: {game_id: gameId},
    sortBy: 'paid_at',
    descending: false,
    limit,
    offset: 0
  }).data
}

function alivePlayersForGame(gameId) {
  return storage.getPaginated(PLAYERS_TABLE, {
    filters: {game_id: gameId, status: 'alive'},
    sortBy: 'paid_at',
    descending: false,
    limit: MAX_PLAYERS,
    offset: 0
  }).data
}

function playerForToken(gameId, token) {
  return (
    storage.getPaginated(PLAYERS_TABLE, {
      filters: {game_id: gameId, player_token: token},
      limit: 1,
      offset: 0
    }).data[0] || null
  )
}

function requireAlivePlayer(gameId, token) {
  const player = playerForToken(gameId, token)
  if (!player || player.status !== 'alive') {
    throw new Error('A live paid player token is required.')
  }
  return player
}

function requirePlayerId(gameId, value, field) {
  const id = requiredText(value, field, 256)
  const player = storage.get(PLAYERS_TABLE, id, null)
  if (!player || player.game_id !== gameId) {
    throw new Error(field + ' is not a player in this arena.')
  }
  return player
}

function requireServerSecret(game, request) {
  const secret = requiredText(
    request.serverSecret ?? request.server_secret,
    'serverSecret',
    256
  )
  if (secret !== game.server_secret) {
    throw new Error('Invalid BananaBread server secret.')
  }
}

function makePlayer({
  paymentHash,
  game,
  lnAddress,
  playerName,
  playerToken,
  slot,
  status,
  paidAmount
}) {
  const now = system.now()
  return {
    id: paymentHash,
    game_id: game.id,
    name: playerName,
    ln_address: lnAddress,
    payment_hash: paymentHash,
    player_token: playerToken,
    slot,
    status,
    paid_amount: paidAmount,
    killer_id: '',
    kill_event_id: '',
    payout_amount: 0,
    payout_status: '',
    payout_attempts: 0,
    disconnect_event_id: '',
    refund_amount: status === 'refund-processing' ? paidAmount : 0,
    refund_status: '',
    refund_attempts: 0,
    created_at: now,
    paid_at: now,
    connected_at: null,
    disconnected_at: null,
    killed_at: null,
    last_seen_at: status === 'alive' ? now : null
  }
}

function nextSlot(gameId) {
  const used = new Set(
    alivePlayersForGame(gameId).map(player => Number(player.slot || 0))
  )
  for (let slot = 1; slot <= MAX_PLAYERS; slot += 1) {
    if (!used.has(slot)) return slot
  }
  return 0
}

function updateGameCount(game) {
  const updated = withFreshPlayerCount({
    ...game,
    updated_at: system.now()
  })
  storage.set(GAMES_TABLE, updated)
  return updated
}

function withFreshPlayerCount(game) {
  return {
    ...game,
    players_count: alivePlayersForGame(game.id).length,
    max_players: MAX_PLAYERS
  }
}

function payKillReward(game, killer, victim) {
  return payPlayer({
    walletId: game.wallet_id,
    lnAddress: killer.ln_address,
    amount: Number(victim.payout_amount || 0),
    comment: 'BananaBread kill reward',
    description: 'BananaBread kill reward in ' + game.name,
    extra: {
      bananabreadwasm_game_id: game.id,
      bananabreadwasm_event_id: victim.kill_event_id,
      bananabreadwasm_killer_id: killer.id,
      bananabreadwasm_victim_id: victim.id
    }
  })
}

function refundPlayer(game, player, reason) {
  return payPlayer({
    walletId: game.wallet_id,
    lnAddress: player.ln_address,
    amount: Number(player.refund_amount || player.paid_amount || 0),
    comment: 'BananaBread refund',
    description: 'BananaBread refund for ' + game.name,
    extra: {
      bananabreadwasm_game_id: game.id,
      bananabreadwasm_event_id: player.disconnect_event_id || '',
      bananabreadwasm_refund_reason: reason
    }
  })
}

function payPlayer({walletId, lnAddress, amount, comment, description, extra}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    return {
      ok: false,
      error: 'Settlement amount must be greater than zero.',
      amount
    }
  }
  if (!walletId) {
    return {ok: false, error: 'BananaBread wallet is not configured.', amount}
  }
  if (!lnAddress) {
    return {ok: false, error: 'Lightning address is missing.', amount}
  }
  const response = wallet.payLnurl({
    walletId,
    lnurl: lnAddress,
    amount,
    currency: 'sat',
    comment,
    maxSat: amount,
    description,
    extra
  })
  const amountMsat =
    Number(response.amountMsat ?? response.amount_msat ?? 0) || amount * 1000
  const feeMsat = Number(response.feeMsat ?? response.fee_msat ?? 0)
  return {
    ok: response.ok === true,
    error: response.error || '',
    amount,
    amountSat: amount,
    checkingId: response.checkingId || response.checking_id || '',
    paymentHash: response.paymentHash || response.payment_hash || '',
    status: response.status || '',
    pending: response.pending === true,
    success: response.success === true,
    amountMsat,
    amount_msat: amountMsat,
    feeMsat,
    fee_msat: feeMsat
  }
}

function settlementStatus(response) {
  if (response.pending === true) return 'pending'
  if (response.success === true || response.ok === true) return 'paid'
  return 'failed'
}

function applyPayout(player, payout) {
  return {
    ...player,
    payout_status: payout.withheld ? 'withheld' : settlementStatus(payout),
    payout_attempts: Number(player.payout_attempts || 0) + 1
  }
}

function applyRefund(player, refund) {
  const refundStatus = settlementStatus(refund)
  return {
    ...player,
    status:
      refundStatus === 'paid'
        ? 'left'
        : refundStatus === 'pending'
          ? 'refund-pending'
          : 'refund-failed',
    refund_status: refundStatus,
    refund_attempts: Number(player.refund_attempts || 0) + 1
  }
}

function withheldPayout() {
  return {
    ok: true,
    withheld: true,
    amount: 0,
    amountSat: 0,
    amountMsat: 0,
    amount_msat: 0,
    error: '',
    status: 'withheld'
  }
}

function storedPayout(player) {
  return {
    amount: Number(player.payout_amount || 0),
    status: player.payout_status || '',
    attempts: Number(player.payout_attempts || 0)
  }
}

function storedRefund(player) {
  return {
    amount: Number(player.refund_amount || 0),
    status: player.refund_status || '',
    attempts: Number(player.refund_attempts || 0)
  }
}

function hasUnresolvedSettlement(player) {
  return (
    ['processing', 'pending', 'failed'].includes(player.payout_status) ||
    ['processing', 'pending', 'failed'].includes(player.refund_status)
  )
}

function settlementCounts(gameId) {
  const players = playersForGame(gameId, 100)
  return {
    failed: players.filter(
      player =>
        player.payout_status === 'failed' || player.refund_status === 'failed'
    ).length,
    pending: players.filter(
      player =>
        ['processing', 'pending'].includes(player.payout_status) ||
        ['processing', 'pending'].includes(player.refund_status)
    ).length,
    unresolved: players.filter(hasUnresolvedSettlement).length
  }
}

function ownerSettings(settings) {
  return {
    id: settings.id,
    enabled: settings.enabled === true,
    haircut: Number(settings.haircut ?? DEFAULT_HAIRCUT),
    walletId: settings.wallet_id || '',
    walletName: settings.wallet_name || '',
    gatewayUrl: settings.gateway_url || '',
    serverSecret: settings.server_secret || '',
    createdAt: Number(settings.created_at || 0),
    updatedAt: Number(settings.updated_at || 0)
  }
}

function publicGame(game) {
  return {
    id: game.id,
    name: game.name,
    joinAmount: Number(game.join_amount || 0),
    haircut: Number(game.haircut || 0),
    playersCount: Number(game.players_count || 0),
    maxPlayers: Number(game.max_players || MAX_PLAYERS),
    gatewayUrl: game.gateway_url || '',
    status: game.status || 'active',
    createdAt: Number(game.created_at || 0),
    updatedAt: Number(game.updated_at || 0)
  }
}

function ownerGame(game) {
  return {...publicGame(game), settlements: settlementCounts(game.id)}
}

function publicPlayer(player, includePrivate, game = null) {
  const result = {
    id: includePrivate ? player.id : '',
    name: player.name || 'PLAYER',
    lnAddress: maskLnAddress(player.ln_address),
    slot: Number(player.slot || 0),
    status: player.status || 'pending',
    paidAmount: Number(player.paid_amount || 0),
    payoutAmount: Number(player.payout_amount || 0),
    payoutStatus: player.payout_status || '',
    refundAmount: Number(player.refund_amount || 0),
    refundStatus: player.refund_status || '',
    paidAt: Number(player.paid_at || 0),
    connectedAt: Number(player.connected_at || 0),
    disconnectedAt: Number(player.disconnected_at || 0),
    killedAt: Number(player.killed_at || 0)
  }
  if (includePrivate && game && player.status === 'alive') {
    result.enterUrl = buildEnterUrl(
      game.gateway_url,
      game.id,
      player.player_token
    )
  }
  return result
}

function buildEnterUrl(gatewayUrl, gameId, playerToken) {
  if (!gatewayUrl) return ''
  return (
    gatewayUrl.replace(/\/+$/, '') +
    '/lnbits/enter?game=' +
    encodeURIComponent(gameId) +
    '&ticket=' +
    encodeURIComponent(playerToken)
  )
}

function eventPaymentHash(event) {
  return cleanText(
    event.payment_hash ||
      event.paymentHash ||
      event.payment?.payment_hash ||
      event.payment?.paymentHash,
    256
  )
}

function normalizeLnAddress(value) {
  const text = requiredText(value, 'lnAddress', 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new Error('Enter a valid Lightning address.')
  }
  return text
}

function normalizeGatewayUrl(value) {
  const text = cleanText(value, 500).replace(/\/+$/, '')
  if (!text) return ''
  const match = text.match(/^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i)
  if (!match || match[2].includes('@')) {
    throw new Error('Enter a valid gateway URL.')
  }
  const hostname = match[2]
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
  const local =
    ['localhost', '127.0.0.1', '::1'].includes(hostname) &&
    match[1].toLowerCase() === 'http'
  if (match[1].toLowerCase() !== 'https' && !local) {
    throw new Error('gatewayUrl must use HTTPS (HTTP is allowed on localhost).')
  }
  return text
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback)
  const integer = Number.isFinite(number) ? Math.trunc(number) : fallback
  return Math.min(max, Math.max(min, integer))
}

function normalizePage(value) {
  return normalizeInteger(value, 1, 1, 1000000)
}

function normalizePageSize(value) {
  return normalizeInteger(value, 10, 1, 100)
}

function normalizeGameSortBy(value) {
  const field = cleanText(value, 80)
  const camelToSnake = {
    joinAmount: 'join_amount',
    playersCount: 'players_count',
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
  const clean = camelToSnake[field] || field
  return [
    'name',
    'join_amount',
    'players_count',
    'status',
    'created_at',
    'updated_at'
  ].includes(clean)
    ? clean
    : 'created_at'
}

function requiredText(value, field, maxLength) {
  const text = cleanText(value, maxLength)
  if (!text) throw new Error(field + ' is required.')
  return text
}

function cleanText(value, maxLength) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength)
}

function cleanId(value) {
  const text = cleanText(value, 128)
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : ''
}

function idValue(value) {
  return typeof value === 'string' ? value : value?.id || ''
}

function maskLnAddress(value) {
  const text = cleanText(value, 320)
  if (!text || !text.includes('@')) return text
  const [name, domain] = text.split('@')
  if (name.length <= 4) return name + '@' + domain
  return name.slice(0, 3) + '...@' + domain
}
