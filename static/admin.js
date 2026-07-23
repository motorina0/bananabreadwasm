const client = window.createLNbitsExtensionClient({
  extensionId: 'bananabreadwasm'
})
const MIN_JOIN_SATS = 50
const MAX_JOIN_SATS = 100

const app = Vue.createApp({
  data() {
    return {
      loading: false,
      saving: false,
      creating: false,
      authorizingPayouts: false,
      retryingGameId: '',
      deletingGameId: '',
      deleteDialog: {show: false, game: null},
      settings: {
        enabled: false,
        haircut: 10,
        walletId: '',
        gatewayUrl: '',
        serverSecret: ''
      },
      gameForm: {name: 'BananaBread public arena', joinAmount: 100},
      wallets: [],
      games: [],
      pagination: {
        sortBy: 'createdAt',
        descending: true,
        page: 1,
        rowsPerPage: 10,
        rowsNumber: 0
      },
      columns: [
        {
          name: 'name',
          label: 'Arena',
          field: 'name',
          align: 'left',
          sortable: true
        },
        {
          name: 'joinAmount',
          label: 'Join sats',
          field: 'joinAmount',
          align: 'right',
          sortable: true
        },
        {
          name: 'haircut',
          label: 'Haircut',
          field: 'haircut',
          align: 'right',
          sortable: true
        },
        {
          name: 'players',
          label: 'Alive',
          field: 'playersCount',
          align: 'left',
          sortable: false
        },
        {
          name: 'settlements',
          label: 'Settlement',
          field: 'settlements',
          align: 'left',
          sortable: false
        },
        {
          name: 'status',
          label: 'Status',
          field: 'status',
          align: 'left',
          sortable: true
        },
        {
          name: 'actions',
          label: '',
          field: 'id',
          align: 'right',
          sortable: false
        }
      ]
    }
  },
  computed: {
    selectedWalletName() {
      return (
        this.wallets.find(wallet => wallet.id === this.effectiveWalletId)
          ?.name || ''
      )
    },
    effectiveWalletId() {
      return this.settings.walletId || this.wallets[0]?.id || ''
    },
    canSave() {
      return (
        !this.settings.enabled ||
        (!!this.effectiveWalletId &&
          (/^https:\/\//i.test(this.settings.gatewayUrl || '') ||
            /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(
              this.settings.gatewayUrl || ''
            )) &&
          String(this.settings.serverSecret || '').length >= 32)
      )
    },
    canCreate() {
      return (
        this.settings.enabled &&
        this.effectiveWalletId &&
        this.gameForm.name &&
        Number.isSafeInteger(Number(this.gameForm.joinAmount)) &&
        Number(this.gameForm.joinAmount) >= MIN_JOIN_SATS &&
        Number(this.gameForm.joinAmount) <= MAX_JOIN_SATS
      )
    },
    canAuthorizePayouts() {
      return this.settings.enabled && this.effectiveWalletId
    }
  },
  async mounted() {
    this.loading = true
    try {
      await Promise.all([
        this.fetchWallets(),
        this.fetchSettings(),
        this.fetchGames()
      ])
    } finally {
      this.loading = false
    }
  },
  methods: {
    async fetchWallets() {
      try {
        this.wallets = (await client.listWallets()).wallets || []
      } catch (error) {
        this.showError(error)
      }
    },
    async fetchSettings() {
      try {
        this.settings = {
          ...this.settings,
          ...((await client.getSettings()).settings || {})
        }
        if (!this.settings.walletId && this.wallets.length)
          this.settings.walletId = this.wallets[0].id
      } catch (error) {
        this.showError(error)
      }
    },
    async saveSettings() {
      if (!this.canSave) return
      this.saving = true
      try {
        this.settings = (
          await client.saveSettings({
            enabled: this.settings.enabled,
            walletId: this.effectiveWalletId,
            walletName: this.selectedWalletName,
            haircut: Number(this.settings.haircut ?? 10),
            gatewayUrl: this.settings.gatewayUrl,
            serverSecret: this.settings.serverSecret
          })
        ).settings
        this.notify('BananaBread settings saved.', 'positive')
      } catch (error) {
        this.showError(error)
      } finally {
        this.saving = false
      }
    },
    async createGame() {
      if (!this.canCreate) return
      this.creating = true
      try {
        await this.ensurePayoutPermission()
        await client.createGame({
          name: this.gameForm.name,
          joinAmount: Number(this.gameForm.joinAmount)
        })
        this.notify('Arena created.', 'positive')
        await this.fetchGames()
      } catch (error) {
        this.showError(error)
      } finally {
        this.creating = false
      }
    },
    payoutPermissionGrant() {
      return {
        walletId: this.effectiveWalletId,
        maxAmount: MAX_JOIN_SATS,
        destinationPolicy: 'external_allowed'
      }
    },
    generateServerSecret() {
      const bytes = new Uint8Array(32)
      window.crypto.getRandomValues(bytes)
      this.settings.serverSecret = Array.from(bytes, byte =>
        byte.toString(16).padStart(2, '0')
      ).join('')
    },
    async ensurePayoutPermission(options = {}) {
      return await client.requestBackgroundPaymentPermission(
        this.payoutPermissionGrant(),
        options
      )
    },
    async authorizePayouts() {
      if (!this.canAuthorizePayouts) return
      this.authorizingPayouts = true
      try {
        await this.ensurePayoutPermission({forcePrompt: true})
        this.notify('Payout permission saved.', 'positive')
      } catch (error) {
        this.showError(error)
      } finally {
        this.authorizingPayouts = false
      }
    },
    async fetchGames(props = {}) {
      const pagination = props.pagination || this.pagination
      try {
        const response = await client.listGames({
          page: pagination.page,
          rowsPerPage: pagination.rowsPerPage,
          sortBy: pagination.sortBy,
          descending: pagination.descending
        })
        this.games = response.games || []
        this.pagination = {...pagination, rowsNumber: response.total || 0}
      } catch (error) {
        this.showError(error)
      }
    },
    publicUrl(game) {
      return new URL(
        '/ext/bananabreadwasm/games/' + encodeURIComponent(game.id),
        window.location.href
      ).href
    },
    async copyGame(game) {
      await navigator.clipboard?.writeText(this.publicUrl(game))
      this.notify('Arena link copied.', 'positive')
    },
    async retrySettlements(game) {
      this.retryingGameId = game.id
      try {
        const result = await client.settleGame(game.id, {kind: 'all'})
        const count = result.settlements?.length || 0
        this.notify(
          count
            ? 'Retried ' + count + ' failed settlement(s).'
            : 'No failed settlements to retry.',
          count ? 'positive' : 'info'
        )
        await this.fetchGames()
      } catch (error) {
        this.showError(error)
      } finally {
        this.retryingGameId = ''
      }
    },
    requestDeleteGame(game) {
      this.deleteDialog = {show: true, game}
    },
    async deleteGame(game) {
      this.deletingGameId = game.id
      try {
        await client.deleteGame(game.id)
        this.deleteDialog = {show: false, game: null}
        await this.fetchGames()
      } catch (error) {
        this.showError(error)
      } finally {
        this.deletingGameId = ''
      }
    },
    notify(message, type = 'info') {
      client
        .notify(message, type)
        .catch(() => Quasar.Notify.create({type, message}))
    },
    showError(error) {
      this.notify(error?.message || String(error), 'negative')
    }
  },
  render() {
    const h = Vue.h
    const q = name => Quasar[name]
    return h('main', {class: 'admin-shell q-pa-md'}, [
      h(
        q('QDialog'),
        {
          modelValue: this.deleteDialog.show,
          'onUpdate:modelValue': v => (this.deleteDialog.show = v)
        },
        () => [
          h(
            q('QCard'),
            {dark: true, style: 'width: min(420px, calc(100vw - 32px))'},
            () => [
              h(q('QCardSection'), () => [
                h(
                  'h2',
                  {class: 'text-h6 text-weight-bold q-my-none'},
                  'Delete Arena'
                )
              ]),
              h(
                q('QCardSection'),
                {class: 'q-pt-none'},
                () =>
                  'Delete "' +
                  (this.deleteDialog.game?.name || 'this arena') +
                  '"?'
              ),
              h(q('QCardActions'), {align: 'right'}, () => [
                h(q('QBtn'), {
                  flat: true,
                  color: 'primary',
                  label: 'Cancel',
                  onClick: () => (this.deleteDialog = {show: false, game: null})
                }),
                h(q('QBtn'), {
                  unelevated: true,
                  color: 'negative',
                  label: 'Delete',
                  loading: this.deletingGameId === this.deleteDialog.game?.id,
                  onClick: () => this.deleteGame(this.deleteDialog.game)
                })
              ])
            ]
          )
        ]
      ),
      h('header', {class: 'row items-center q-gutter-md q-mb-md'}, [
        h('div', {class: 'streetfighter-mark'}, 'BB'),
        h('div', [
          h(
            'h1',
            {class: 'text-h4 text-weight-bold q-my-none'},
            'BananaBread Arena'
          ),
          h(
            'p',
            {class: 'text-subtitle2 text-grey-5 q-my-none'},
            'Paid deathmatch rooms, five players at a time.'
          )
        ])
      ]),
      h('div', {class: 'row q-col-gutter-md'}, [
        h('div', {class: 'col-12 col-md-5 q-gutter-y-md'}, [
          h(q('QCard'), {dark: true}, () =>
            h(q('QCardSection'), () => [
              h(
                'h2',
                {class: 'text-h6 text-weight-bold q-my-none q-mb-md'},
                'Settings'
              ),
              h(q('QToggle'), {
                modelValue: this.settings.enabled,
                'onUpdate:modelValue': v => (this.settings.enabled = v),
                label: 'Enable paid arenas',
                color: 'primary'
              }),
              h(q('QSelect'), {
                class: 'q-mt-md',
                modelValue: this.effectiveWalletId,
                'onUpdate:modelValue': v => (this.settings.walletId = v),
                options: this.wallets.map(w => ({label: w.name, value: w.id})),
                label: 'Wallet',
                filled: true,
                dense: true,
                dark: true,
                optionsDark: true,
                emitValue: true,
                mapOptions: true
              }),
              h(q('QInput'), {
                class: 'q-mt-sm',
                modelValue: this.settings.haircut,
                'onUpdate:modelValue': v => (this.settings.haircut = v),
                type: 'number',
                label: 'Arena fee percent',
                hint: 'Default: 10%. The killer receives the rest of the victim stake.',
                filled: true,
                dense: true,
                dark: true,
                min: 0,
                max: 100
              }),
              h(q('QInput'), {
                class: 'q-mt-sm',
                modelValue: this.settings.gatewayUrl,
                'onUpdate:modelValue': v => (this.settings.gatewayUrl = v),
                type: 'url',
                label: 'Public Sour gateway URL',
                hint: 'HTTPS required except localhost.',
                filled: true,
                dense: true,
                dark: true,
                placeholder: 'https://arena.example.com'
              }),
              h(q('QInput'), {
                class: 'q-mt-sm',
                modelValue: this.settings.serverSecret,
                'onUpdate:modelValue': v => (this.settings.serverSecret = v),
                type: 'password',
                label: 'Gateway shared secret',
                hint: 'Use the same value in BANANABREAD_SERVER_SECRET.',
                filled: true,
                dense: true,
                dark: true
              }),
              h(
                q('QBtn'),
                {
                  class: 'q-mt-sm',
                  flat: true,
                  color: 'primary',
                  onClick: this.generateServerSecret
                },
                () => 'Generate Secret'
              ),
              h(
                q('QBtn'),
                {
                  class: 'q-mt-md',
                  color: 'primary',
                  loading: this.saving,
                  disable: !this.canSave,
                  onClick: this.saveSettings
                },
                () => 'Save Settings'
              )
            ])
          ),
          h(q('QCard'), {dark: true}, () =>
            h(q('QCardSection'), () => [
              h(
                'h2',
                {class: 'text-h6 text-weight-bold q-my-none q-mb-md'},
                'New Arena'
              ),
              h(q('QInput'), {
                modelValue: this.gameForm.name,
                'onUpdate:modelValue': v => (this.gameForm.name = v),
                label: 'Title',
                filled: true,
                dense: true,
                dark: true
              }),
              h(q('QInput'), {
                class: 'q-mt-sm',
                modelValue: this.gameForm.joinAmount,
                'onUpdate:modelValue': v => (this.gameForm.joinAmount = v),
                type: 'number',
                label: 'Join sats (50–100)',
                hint: 'Experimental beta cap: 100 sats.',
                filled: true,
                dense: true,
                dark: true,
                min: MIN_JOIN_SATS,
                max: MAX_JOIN_SATS
              }),
              h(
                q('QBtn'),
                {
                  class: 'q-mt-md',
                  color: 'primary',
                  loading: this.creating,
                  disable: !this.canCreate,
                  onClick: this.createGame
                },
                () => 'Create Arena'
              )
            ])
          )
        ]),
        h('div', {class: 'col-12 col-md-7'}, [
          h(q('QCard'), {dark: true}, () =>
            h(q('QCardSection'), () => [
              h('div', {class: 'row items-center justify-between q-mb-md'}, [
                h(
                  'h2',
                  {class: 'text-h6 text-weight-bold q-my-none'},
                  'Arenas'
                ),
                h(
                  q('QBtn'),
                  {
                    color: 'primary',
                    outline: true,
                    loading: this.authorizingPayouts,
                    disable: !this.canAuthorizePayouts,
                    onClick: this.authorizePayouts
                  },
                  () => 'Authorize Payouts'
                )
              ]),
              h(
                q('QTable'),
                {
                  dark: true,
                  flat: true,
                  rows: this.games,
                  columns: this.columns,
                  rowKey: 'id',
                  pagination: this.pagination,
                  loading: this.loading,
                  onRequest: this.fetchGames
                },
                {
                  'body-cell-players': props =>
                    h(q('QTd'), {props}, () => props.row.playersCount + ' / 5'),
                  'body-cell-haircut': props =>
                    h(q('QTd'), {props}, () => props.row.haircut + '%'),
                  'body-cell-settlements': props =>
                    h(q('QTd'), {props}, () => {
                      const failed = Number(props.row.settlements?.failed || 0)
                      const pending = Number(
                        props.row.settlements?.pending || 0
                      )
                      if (failed) return failed + ' failed'
                      if (pending) return pending + ' pending'
                      return 'clear'
                    }),
                  'body-cell-actions': props =>
                    h(q('QTd'), {props, class: 'q-gutter-xs'}, () => [
                      h(q('QBtn'), {
                        flat: true,
                        round: true,
                        dense: true,
                        icon: 'content_copy',
                        onClick: () => this.copyGame(props.row)
                      }),
                      h(q('QBtn'), {
                        flat: true,
                        round: true,
                        dense: true,
                        color: 'warning',
                        icon: 'refresh',
                        title: 'Retry failed settlements',
                        disable: !props.row.settlements?.failed,
                        loading: this.retryingGameId === props.row.id,
                        onClick: () => this.retrySettlements(props.row)
                      }),
                      h(q('QBtn'), {
                        flat: true,
                        round: true,
                        dense: true,
                        color: 'negative',
                        icon: 'delete',
                        loading: this.deletingGameId === props.row.id,
                        onClick: () => this.requestDeleteGame(props.row)
                      })
                    ])
                }
              )
            ])
          )
        ])
      ])
    ])
  }
})
app.use(Quasar)
app.mount('#bananabreadwasm-admin-app')
