import { EventEmitter } from 'events'
import http from 'http'
import https from 'https'

export interface GeoIndoDonation {
  id: string
  platform?: string
  donorName: string
  amount?: number
  message?: string
  createdAt?: number
  date?: string
  rawId?: string
  [key: string]: any
}

export interface GeoIndoUserData {
  'user-id': string
  'display-name': string
  username: string
  avatar?: string
  platform: 'geoindo' | string
  amount?: number
}

export default class GeoIndoBackend extends EventEmitter {
  #req: http.ClientRequest | null = null
  #connected = false
  #closing = false
  #reconnectTimer: NodeJS.Timeout | null = null
  #pollTimer: NodeJS.Timeout | null = null
  #lastProcessedIds = new Set<string>()

  uid: string
  baseUrl: string

  constructor(options: { uid: string; baseUrl?: string }) {
    super()
    this.uid = options.uid.trim()
    this.baseUrl = (options.baseUrl || 'https://www.geoindo.my.id').replace(/\/$/, '')
  }

  get streamTarget(): string {
    return this.uid
  }

  async connect(): Promise<boolean> {
    this.#closing = false

    if (!this.uid) {
      throw new Error('UID GeoIndo tidak boleh kosong!')
    }

    this.closeRequest()
    this.startSSE()
    this.startPollingFallback()
    return true
  }

  private startSSE() {
    if (this.#closing) return

    const streamUrl = `${this.baseUrl}/api/donations/stream?uid=${encodeURIComponent(this.uid)}`
    console.log(`[GeoIndo Stream] Connecting to SSE: ${streamUrl}`)

    try {
      const parsed = new URL(streamUrl)
      const client = parsed.protocol === 'https:' ? https : http

      const req = client.get(
        parsed,
        {
          headers: {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          }
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            const err = new Error(`HTTP Error ${res.statusCode} connecting to donation stream`)
            console.error('[GeoIndo Stream] HTTP Error:', err.message)
            this.emit('error', err)
            this.scheduleReconnect()
            return
          }

          this.#connected = true
          this.emit('connected', this.uid)
          console.log(`[GeoIndo Stream] Connected SSE stream for UID ${this.uid}`)

          let buffer = ''
          res.setEncoding('utf8')

          res.on('data', (chunk: string) => {
            buffer += chunk
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || trimmed.startsWith(':')) continue

              if (trimmed.startsWith('data:')) {
                const jsonStr = trimmed.slice(5).trim()
                if (jsonStr) {
                  this.handleIncomingRaw(jsonStr)
                }
              }
            }
          })

          res.on('end', () => {
            if (!this.#closing) {
              console.warn('[GeoIndo Stream] SSE stream ended by remote. Reconnecting...')
              this.scheduleReconnect()
            }
          })

          res.on('error', (err) => {
            if (!this.#closing) {
              console.error('[GeoIndo Stream] Response error:', err)
              this.emit('error', err)
              this.scheduleReconnect()
            }
          })
        }
      )

      req.on('error', (err) => {
        if (!this.#closing) {
          console.error('[GeoIndo Stream] Request error:', err.message)
          this.emit('error', err)
          this.scheduleReconnect()
        }
      })

      this.#req = req
    } catch (err: any) {
      this.emit('error', err)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (this.#closing || this.#reconnectTimer) return
    this.#connected = false
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      if (!this.#closing) {
        console.log('[GeoIndo Stream] Attempting SSE reconnect...')
        this.startSSE()
      }
    }, 5000)
  }

  private handleIncomingRaw(jsonStr: string) {
    try {
      const data = JSON.parse(jsonStr)
      if (data.status === 'connected') {
        return
      }
      this.processDonationItem(data)
    } catch (err) {
      console.warn('[GeoIndo Stream] Failed to parse SSE event JSON:', err)
    }
  }

  private processDonationItem(donation: GeoIndoDonation) {
    if (!donation) return
    const id = donation.id || donation.rawId || `${donation.donorName}-${donation.createdAt}`
    if (id && this.#lastProcessedIds.has(id)) {
      return
    }
    if (id) {
      this.#lastProcessedIds.add(id)
      if (this.#lastProcessedIds.size > 2000) {
        const arr = Array.from(this.#lastProcessedIds)
        for (let i = 0; i < 500; i++) {
          this.#lastProcessedIds.delete(arr[i])
        }
      }
    }

    const donorName = (donation.donorName || 'Donatur GeoIndo').trim()
    const msg = (donation.message || '').trim()

    // Cek tebakan !g <lokasi>
    if (/^!g\s+/i.test(msg)) {
      const userstate: GeoIndoUserData = {
        'user-id': `geoindo_${id}`,
        'display-name': donorName,
        username: donorName,
        avatar: '',
        platform: donation.platform || 'geoindo',
        amount: donation.amount
      }

      console.log(`[GeoIndo Guess] ${donorName} ($${donation.amount || 0}): ${msg}`)
      this.emit('guess', userstate, msg)
    }
  }

  private startPollingFallback() {
    if (this.#pollTimer) clearInterval(this.#pollTimer)

    const poll = async () => {
      if (this.#closing) return
      try {
        const url = `${this.baseUrl}/api/donations?uid=${encodeURIComponent(this.uid)}`
        const parsed = new URL(url)
        const client = parsed.protocol === 'https:' ? https : http

        client
          .get(parsed, (res) => {
            let body = ''
            res.on('data', (d) => (body += d))
            res.on('end', () => {
              try {
                const parsedData = JSON.parse(body)
                const list: GeoIndoDonation[] = Array.isArray(parsedData)
                  ? parsedData
                  : parsedData.donations || parsedData.data || []

                // Hanya cek 10 donasi terbaru
                const recent = list.slice(0, 10)
                for (const item of recent) {
                  this.processDonationItem(item)
                }
              } catch (_) {}
            })
          })
          .on('error', () => {})
      } catch (_) {}
    }

    // Jalankan segera sekali untuk pre-populate cache id agar donasi lama tidak membanjiri tebakan aktif
    this.prepopulateCache()

    // Polling setiap 7 detik sebagai fallback jika SSE terputus
    this.#pollTimer = setInterval(poll, 7000)
  }

  private prepopulateCache() {
    try {
      const url = `${this.baseUrl}/api/donations?uid=${encodeURIComponent(this.uid)}`
      const parsed = new URL(url)
      const client = parsed.protocol === 'https:' ? https : http

      client
        .get(parsed, (res) => {
          let body = ''
          res.on('data', (d) => (body += d))
          res.on('end', () => {
            try {
              const parsedData = JSON.parse(body)
              const list: GeoIndoDonation[] = Array.isArray(parsedData)
                ? parsedData
                : parsedData.donations || parsedData.data || []
              for (const item of list) {
                const id = item.id || item.rawId || `${item.donorName}-${item.createdAt}`
                if (id) this.#lastProcessedIds.add(id)
              }
              console.log(
                `[GeoIndo] Cached ${this.#lastProcessedIds.size} historic donations (will not trigger duplicate guesses)`
              )
            } catch (_) {}
          })
        })
        .on('error', () => {})
    } catch (_) {}
  }

  private closeRequest() {
    if (this.#req) {
      try {
        this.#req.destroy()
      } catch (_) {}
      this.#req = null
    }
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
  }

  close() {
    this.#closing = true
    this.closeRequest()
    if (this.#connected) {
      this.#connected = false
      this.emit('disconnected', true)
    }
  }
}
