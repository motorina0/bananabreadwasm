;(function () {
  const POLL_MS = 1500
  const client = window.createLNbitsExtensionClient({
    extensionId: 'bananabreadwasm'
  })
  const state = {
    gameId: '',
    game: null,
    player: null,
    playerToken: '',
    paymentRequest: '',
    paymentUnsubscribe: null,
    pollTimer: null
  }

  const elements = {
    name: document.querySelector('#arena-name'),
    summary: document.querySelector('#arena-summary'),
    error: document.querySelector('#arena-error'),
    joinPanel: document.querySelector('#join-panel'),
    joinForm: document.querySelector('#join-form'),
    joinButton: document.querySelector('#join-button'),
    playerName: document.querySelector('#player-name'),
    lnAddress: document.querySelector('#ln-address'),
    invoicePanel: document.querySelector('#invoice-panel'),
    invoiceQr: document.querySelector('#invoice-qr'),
    copyInvoice: document.querySelector('#copy-invoice'),
    paymentStatus: document.querySelector('#payment-status'),
    admittedPanel: document.querySelector('#admitted-panel'),
    admittedCopy: document.querySelector('#admitted-copy'),
    enterArena: document.querySelector('#enter-arena'),
    settledPanel: document.querySelector('#settled-panel'),
    settledEyebrow: document.querySelector('#settled-eyebrow'),
    settledTitle: document.querySelector('#settled-title'),
    settledCopy: document.querySelector('#settled-copy'),
    playAgain: document.querySelector('#play-again'),
    playerCount: document.querySelector('#player-count'),
    playerList: document.querySelector('#player-list')
  }

  elements.joinForm.addEventListener('submit', joinArena)
  elements.copyInvoice.addEventListener('click', copyInvoice)
  elements.playAgain.addEventListener('click', showJoin)
  window.addEventListener('pagehide', cleanup)

  init().catch(showError)

  async function init() {
    const context = await client.context()
    state.gameId = String(context.routeParams?.gameId || '')
    if (!state.gameId) throw new Error('Arena id is missing from this link.')
    const queryToken = String(context.query?.playerToken || '')
    const remembered = await client.getSessionValue(sessionKey())
    state.playerToken = queryToken || remembered.value || ''
    if (state.playerToken) {
      await client.setSessionValue(sessionKey(), state.playerToken)
    }
    await refresh()
    state.pollTimer = window.setInterval(() => {
      refresh().catch(showError)
    }, POLL_MS)
  }

  async function joinArena(event) {
    event.preventDefault()
    clearError()
    elements.joinButton.disabled = true
    elements.joinButton.textContent = 'CREATING INVOICE…'
    try {
      const response = await client.joinGame(state.gameId, {
        name: elements.playerName.value,
        lnAddress: elements.lnAddress.value
      })
      state.playerToken = String(response.playerToken || '')
      state.paymentRequest = String(response.paymentRequest || '')
      if (!state.playerToken || !state.paymentRequest) {
        throw new Error('LNbits returned an incomplete admission invoice.')
      }
      await client.setSessionValue(sessionKey(), state.playerToken)
      elements.invoiceQr.src = window.BananaBread_QR_DATA_URI(
        state.paymentRequest
      )
      showOnly(elements.invoicePanel)
      subscribeToPayment(response.paymentHash)
      await refresh()
    } catch (error) {
      showError(error)
      elements.joinButton.disabled = false
      elements.joinButton.textContent = 'CREATE JOIN INVOICE'
    }
  }

  async function subscribeToPayment(paymentHash) {
    if (state.paymentUnsubscribe) state.paymentUnsubscribe()
    state.paymentUnsubscribe = null
    try {
      state.paymentUnsubscribe = await client.subscribePayment(
        paymentHash,
        () => refresh().catch(showError)
      )
    } catch (_error) {
      elements.paymentStatus.textContent =
        'Invoice created. Waiting for LNbits to confirm settlement…'
    }
  }

  async function refresh() {
    clearError()
    const response = await client.getPublicGame(state.gameId, state.playerToken)
    state.game = response.game || null
    state.player = response.player || null
    render(response)
  }

  function render(response) {
    if (!state.game) return
    elements.name.textContent = state.game.name
    elements.summary.textContent =
      state.game.joinAmount +
      ' sats to enter · ' +
      state.game.haircut +
      '% arena fee · winner receives the remainder'
    elements.playerCount.textContent =
      state.game.playersCount + ' / ' + state.game.maxPlayers
    renderPlayers(response.players || [])

    if (state.player?.status === 'alive') {
      elements.admittedCopy.textContent =
        'Paid as ' +
        state.player.name +
        '. Your ' +
        state.player.paidAmount +
        '-sat stake is live.'
      elements.enterArena.href = state.player.enterUrl || '#'
      elements.enterArena.toggleAttribute(
        'aria-disabled',
        !state.player.enterUrl
      )
      showOnly(elements.admittedPanel)
      return
    }
    if (state.player?.status === 'dead') {
      elements.settledEyebrow.textContent = 'ELIMINATED'
      elements.settledTitle.textContent = 'Your stake was claimed'
      elements.settledCopy.textContent = payoutCopy(state.player)
      showOnly(elements.settledPanel)
      return
    }
    if (
      state.player &&
      ['left', 'refund-pending', 'refund-failed'].includes(state.player.status)
    ) {
      elements.settledEyebrow.textContent = 'DISCONNECTED'
      elements.settledTitle.textContent = refundTitle(state.player)
      elements.settledCopy.textContent = refundCopy(state.player)
      showOnly(elements.settledPanel)
      return
    }
    if (state.paymentRequest) {
      showOnly(elements.invoicePanel)
      return
    }
    elements.joinButton.disabled = response.canJoin !== true
    elements.joinButton.textContent =
      response.canJoin === true ? 'CREATE JOIN INVOICE' : 'ARENA FULL'
    showOnly(elements.joinPanel)
  }

  function renderPlayers(players) {
    elements.playerList.replaceChildren()
    const live = players.filter(player => player.status === 'alive')
    if (!live.length) {
      const empty = document.createElement('li')
      empty.className = 'player-empty'
      empty.textContent = 'No paid players yet.'
      elements.playerList.append(empty)
      return
    }
    for (const player of live) {
      const item = document.createElement('li')
      const identity = document.createElement('span')
      const status = document.createElement('span')
      identity.textContent = player.name
      status.className = 'player-status'
      status.textContent = player.connectedAt ? 'IN GAME' : 'PAID'
      item.append(identity, status)
      elements.playerList.append(item)
    }
  }

  function payoutCopy(player) {
    if (player.payoutStatus === 'paid') {
      return (
        player.payoutAmount +
        ' sats from your stake were paid to the killer. Pay again to respawn.'
      )
    }
    if (player.payoutStatus === 'withheld') {
      return 'No reward was due for this elimination. Pay again to respawn.'
    }
    return (
      'The ' +
      player.payoutAmount +
      '-sat reward is ' +
      (player.payoutStatus || 'being processed') +
      '. The arena owner can retry a failed payment.'
    )
  }

  function refundTitle(player) {
    if (player.refundStatus === 'paid') return 'Your stake was refunded'
    if (player.refundStatus === 'failed') return 'Refund needs attention'
    return 'Refund is pending'
  }

  function refundCopy(player) {
    return (
      (player.refundAmount || player.paidAmount) +
      ' sats: ' +
      (player.refundStatus || 'processing') +
      '. You may pay again for a new admission.'
    )
  }

  function showJoin() {
    state.playerToken = ''
    state.player = null
    state.paymentRequest = ''
    client.setSessionValue(sessionKey(), '').catch(() => {})
    elements.joinButton.disabled = false
    elements.joinButton.textContent = 'CREATE JOIN INVOICE'
    showOnly(elements.joinPanel)
  }

  function showOnly(panel) {
    for (const candidate of [
      elements.joinPanel,
      elements.invoicePanel,
      elements.admittedPanel,
      elements.settledPanel
    ]) {
      candidate.hidden = candidate !== panel
    }
  }

  async function copyInvoice() {
    if (!state.paymentRequest) return
    try {
      await navigator.clipboard.writeText(state.paymentRequest)
      elements.paymentStatus.textContent = 'Invoice copied.'
    } catch (_error) {
      elements.paymentStatus.textContent = state.paymentRequest
    }
  }

  function sessionKey() {
    return 'arena.' + state.gameId + '.ticket'
  }

  function showError(error) {
    elements.error.textContent = error?.message || String(error)
    elements.error.hidden = false
  }

  function clearError() {
    elements.error.hidden = true
    elements.error.textContent = ''
  }

  function cleanup() {
    if (state.pollTimer) window.clearInterval(state.pollTimer)
    if (state.paymentUnsubscribe) state.paymentUnsubscribe()
  }
})()
