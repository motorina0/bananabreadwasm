import {
  createInvoice,
  createInvoicePublic,
  extensionApiRequest,
  httpRequest,
  listUserWallets,
  log,
  now,
  payInvoice,
  payLnurl,
  randomId,
  storageAppendPublic,
  storageDelete,
  storageGet,
  storageGetPublic,
  storageGetPublicPaginated,
  storageGetPaginated,
  storageSet,
  websocketPublish
} from 'lnbits:extension/host'
import {
  convert as utilsCurrenciesConvert,
  fiatToSats as utilsCurrenciesFiatToSats,
  listCurrencies as utilsCurrenciesList,
  rate as utilsCurrenciesRate,
  satsToFiat as utilsCurrenciesSatsToFiat
} from 'lnbits:extension/utils-currencies'
import {
  decodeInvoice as utilsLightningDecodeInvoice,
  invoiceAmountMsat as utilsLightningInvoiceAmountMsat,
  invoiceExpiry as utilsLightningInvoiceExpiry,
  invoiceMemo as utilsLightningInvoiceMemo,
  invoicePaymentHash as utilsLightningInvoicePaymentHash,
  randomSecretAndHash as utilsLightningRandomSecretAndHash,
  validateInvoice as utilsLightningValidateInvoice,
  verifyPreimage as utilsLightningVerifyPreimage
} from 'lnbits:extension/utils-lightning'
import {health as utilsServerHealth} from 'lnbits:extension/utils-server'

export const extensionApi = {
  storage: {
    get(input) {
      return storageGet(input)
    },

    getPublic(input) {
      return storageGetPublic(input)
    },

    set(input) {
      return storageSet({
        table: input.table,
        dataJson: JSON.stringify(input.data || {})
      })
    },

    appendPublic(input) {
      return storageAppendPublic({
        table: input.table,
        sourceId: input.sourceId,
        dataJson: JSON.stringify(input.data || {})
      })
    },

    getPaginated(input) {
      return storageGetPaginated({
        table: input.table,
        filtersJson: JSON.stringify(input.filters || {}),
        search: input.search || '',
        searchFields: input.searchFields || [],
        sortBy: input.sortBy || '',
        descending: input.descending === true,
        limit: input.limit || 25,
        offset: input.offset || 0
      })
    },

    getPublicPaginated(input) {
      return storageGetPublicPaginated({
        table: input.table,
        sourceId: input.sourceId,
        filtersJson: JSON.stringify(input.filters || {}),
        search: input.search || '',
        searchFields: input.searchFields || [],
        sortBy: input.sortBy || '',
        descending: input.descending === true,
        limit: input.limit || 25,
        offset: input.offset || 0
      })
    },

    delete(input) {
      return storageDelete(input)
    }
  },

  wallet: {
    createInvoice(input) {
      return createInvoice({
        ...input,
        amount: Number(input.amount),
        extra: Object.entries(input.extra || {}).map(([key, value]) => [
          key,
          String(value)
        ])
      })
    },

    createInvoicePublic(input) {
      return createInvoicePublic({
        sourceId: input.sourceId,
        amount: Number(input.amount),
        currency: input.currency || 'sat',
        memo: input.memo || '',
        extra: Object.entries(input.extra || {}).map(([key, value]) => [
          key,
          String(value)
        ])
      })
    },

    listUserWallets() {
      return listUserWallets()
    },

    payInvoice(input) {
      return payInvoice({
        walletId: input.walletId,
        paymentRequest: input.paymentRequest,
        maxSat:
          input.maxSat === null || input.maxSat === undefined
            ? undefined
            : BigInt(input.maxSat),
        description: input.description || '',
        extra: Object.entries(input.extra || {}).map(([key, value]) => [
          key,
          String(value)
        ])
      })
    },

    payLnurl(input) {
      return payLnurl({
        walletId: input.walletId,
        lnurl: input.lnurl,
        amount: Number(input.amount),
        currency: input.currency || 'sat',
        comment: input.comment || undefined,
        maxSat: input.maxSat > 0 ? BigInt(input.maxSat) : undefined,
        description: input.description || '',
        extra: Object.entries(input.extra || {}).map(([key, value]) => [
          key,
          String(value)
        ])
      })
    }
  },

  websocket: {
    publish(input) {
      return websocketPublish({
        itemId: input.itemId,
        dataJson: JSON.stringify(input.data || {})
      })
    }
  },

  http: {
    request(input) {
      return httpRequest({
        method: input.method || 'GET',
        url: input.url,
        headers: Object.entries(input.headers || {}).map(([key, value]) => [
          key,
          String(value)
        ]),
        body: input.body ?? undefined
      })
    }
  },

  extension: {
    request(input) {
      return extensionApiRequest({
        extensionId: input.extensionId,
        method: input.method || 'GET',
        path: input.path,
        body: input.body ?? undefined
      })
    }
  },

  utils: {
    currencies: {
      list() {
        return utilsCurrenciesList()
      },

      rate(input) {
        return utilsCurrenciesRate(input)
      },

      convert(input) {
        return utilsCurrenciesConvert(input)
      },

      fiatToSats(input) {
        return utilsCurrenciesFiatToSats(input)
      },

      satsToFiat(input) {
        return utilsCurrenciesSatsToFiat(input)
      }
    },

    server: {
      health() {
        return utilsServerHealth()
      }
    },

    lightning: {
      decodeInvoice(input) {
        return utilsLightningDecodeInvoice(input)
      },

      validateInvoice(input) {
        return utilsLightningValidateInvoice(input)
      },

      invoicePaymentHash(input) {
        return utilsLightningInvoicePaymentHash(input)
      },

      invoiceAmountMsat(input) {
        return utilsLightningInvoiceAmountMsat(input)
      },

      invoiceExpiry(input) {
        return utilsLightningInvoiceExpiry(input)
      },

      invoiceMemo(input) {
        return utilsLightningInvoiceMemo(input)
      },

      verifyPreimage(input) {
        return utilsLightningVerifyPreimage(input)
      },

      randomSecretAndHash(input) {
        return utilsLightningRandomSecretAndHash(input)
      }
    }
  },

  system: {
    id(input) {
      return randomId(typeof input === 'string' ? {prefix: input} : input)
    },

    now() {
      const response = now()
      const timestamp =
        response && typeof response === 'object'
          ? (response.timestamp ?? response['timestamp'] ?? response.value)
          : response
      const number = Number(timestamp)
      if (!Number.isFinite(number) || number <= 0) {
        return Math.floor(Date.now() / 1000)
      }
      return Math.trunc(number)
    },

    log(input) {
      return log(
        typeof input === 'string' ? {level: 'info', message: input} : input
      )
    }
  }
}

export const storage = {
  get(table, id, fallback = null) {
    const {dataJson} = extensionApi.storage.get({table, id})
    if (!dataJson) return fallback
    return JSON.parse(dataJson)
  },

  getPublic(table, id, fallback = null) {
    const {dataJson} = extensionApi.storage.getPublic({table, id})
    if (!dataJson) return fallback
    return JSON.parse(dataJson)
  },

  set(table, data) {
    extensionApi.storage.set({table, data})
    return data
  },

  appendPublic(table, sourceId, data) {
    return extensionApi.storage.appendPublic({table, sourceId, data})
  },

  getPaginated(table, options = {}) {
    const {rowsJson, total} = extensionApi.storage.getPaginated({
      table,
      filters: options.filters || {},
      search: options.search || '',
      searchFields: options.searchFields || [],
      sortBy: options.sortBy || '',
      descending: options.descending === true,
      limit: options.limit || 25,
      offset: options.offset || 0
    })
    return {
      data: JSON.parse(rowsJson || '[]'),
      total: Number(total || 0)
    }
  },

  getPublicPaginated(table, options = {}) {
    const {rowsJson, total} = extensionApi.storage.getPublicPaginated({
      table,
      sourceId: options.sourceId || '',
      filters: options.filters || {},
      search: options.search || '',
      searchFields: options.searchFields || [],
      sortBy: options.sortBy || '',
      descending: options.descending === true,
      limit: options.limit || 25,
      offset: options.offset || 0
    })
    return {
      data: JSON.parse(rowsJson || '[]'),
      total: Number(total || 0)
    }
  },

  delete(table, id) {
    extensionApi.storage.delete({table, id})
  }
}

export const wallet = {
  listUserWallets() {
    return extensionApi.wallet.listUserWallets().wallets || []
  },

  createInvoice({walletId, amount, currency = 'sat', memo, tag, extra = {}}) {
    const invoiceExtra = {
      tag,
      ...extra
    }

    return extensionApi.wallet.createInvoice({
      walletId,
      amount,
      currency,
      memo,
      tag,
      extra: invoiceExtra
    })
  },

  createInvoicePublic({
    sourceId,
    amount,
    currency = 'sat',
    memo = '',
    extra = {}
  }) {
    return extensionApi.wallet.createInvoicePublic({
      sourceId,
      amount,
      currency,
      memo,
      extra
    })
  },

  payInvoice({
    walletId,
    paymentRequest,
    maxSat = null,
    description = '',
    extra = {}
  }) {
    return extensionApi.wallet.payInvoice({
      walletId,
      paymentRequest,
      maxSat,
      description,
      extra
    })
  },

  payLnurl({
    walletId,
    lnurl,
    amount,
    currency = 'sat',
    comment = '',
    maxSat = 0,
    description = '',
    extra = {}
  }) {
    return extensionApi.wallet.payLnurl({
      walletId,
      lnurl,
      amount,
      currency,
      comment,
      maxSat,
      description,
      extra
    })
  }
}

export const websocket = {
  publish(itemId, data) {
    return extensionApi.websocket.publish({itemId, data})
  }
}

export const http = {
  request({method = 'GET', url, headers = {}, body = undefined}) {
    const response = extensionApi.http.request({
      method,
      url,
      headers,
      body
    })
    return {
      statusCode: Number(response.statusCode || 0),
      headers: Object.fromEntries(response.headers || []),
      body: response.body || ''
    }
  }
}

export const extension = {
  request({extensionId, method = 'GET', path, body = undefined}) {
    const response = extensionApi.extension.request({
      extensionId,
      method,
      path,
      body
    })
    return {
      statusCode: Number(response.statusCode || 0),
      headers: Object.fromEntries(response.headers || []),
      body: response.body || ''
    }
  }
}

export const utils = {
  currencies: {
    list() {
      return ['sat', ...(extensionApi.utils.currencies.list().currencies || [])]
    },

    rate(currency) {
      return extensionApi.utils.currencies.rate({currency})
    },

    convert({amount, from, to}) {
      const response = extensionApi.utils.currencies.convert({
        amount,
        fromCurrency: from,
        to
      })
      return Object.fromEntries(response.amounts || [])
    },

    fiatToSats(amount, currency) {
      return Number(
        extensionApi.utils.currencies.fiatToSats({
          amount,
          currency
        }).amountSat || 0
      )
    },

    satsToFiat(amount, currency) {
      return Number(
        extensionApi.utils.currencies.satsToFiat({
          amount,
          currency
        }).amount || 0
      )
    }
  },

  server: {
    health() {
      return extensionApi.utils.server.health()
    }
  },

  lightning: {
    decodeInvoice(bolt11) {
      return extensionApi.utils.lightning.decodeInvoice({bolt11})
    },

    validateInvoice(bolt11) {
      return extensionApi.utils.lightning.validateInvoice({bolt11})
    },

    invoicePaymentHash(bolt11) {
      return extensionApi.utils.lightning.invoicePaymentHash({bolt11})
        .paymentHash
    },

    invoiceAmountMsat(bolt11) {
      return Number(
        extensionApi.utils.lightning.invoiceAmountMsat({bolt11}).amountMsat || 0
      )
    },

    invoiceExpiry(bolt11) {
      return Number(
        extensionApi.utils.lightning.invoiceExpiry({bolt11}).expiresAt || 0
      )
    },

    invoiceMemo(bolt11) {
      return extensionApi.utils.lightning.invoiceMemo({bolt11}).memo || ''
    },

    verifyPreimage(preimage, paymentHash) {
      return extensionApi.utils.lightning.verifyPreimage({
        preimage,
        paymentHash
      }).valid
    },

    randomSecretAndHash(length = 32) {
      return extensionApi.utils.lightning.randomSecretAndHash({length})
    }
  }
}

export const system = {
  id(prefix) {
    return extensionApi.system.id({prefix}).id
  },

  now() {
    const response = extensionApi.system.now()
    const timestamp =
      response && typeof response === 'object'
        ? (response.timestamp ?? response['timestamp'] ?? response.value)
        : response
    const number = Number(timestamp)
    if (!Number.isFinite(number) || number <= 0) {
      return Math.floor(Date.now() / 1000)
    }
    return Math.trunc(number)
  },

  log(message, level = 'info') {
    extensionApi.system.log({level, message})
  }
}
