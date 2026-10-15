import { EventEmitter } from 'events'
// @ts-ignore
import { TikTokLiveConnection } from 'tiktok-live-connector'

export interface TikTokUserData {
  'user-id': string
  'display-name': string
  username: string
  avatar?: string
  platform: 'tiktok'
}

export default class TikTokBackend extends EventEmitter {
  #tiktokLive: any = null
  #connected = false
  #closing = false
  #lastGuessTimestamp: Map<string, number> = new Map()

  tiktokUsername = ''

  constructor(options: { username: string }) {
    super()
    this.tiktokUsername = options.username.trim().replace(/^@/, '')
  }

  get streamTarget(): string {
    return this.tiktokUsername ? `@${this.tiktokUsername}` : ''
  }

  async connect(): Promise<boolean> {
    this.#closing = false

    if (!this.tiktokUsername) {
      throw new Error('Username TikTok tidak boleh kosong!')
    }

    if (this.#tiktokLive) {
      try {
        this.#tiktokLive.disconnect()
      } catch (_) {}
      this.#tiktokLive = null
    }

    this.#tiktokLive = new TikTokLiveConnection(this.tiktokUsername, {})

    this.#tiktokLive.on('connected', (state: any) => {
      this.#connected = true
      console.log(`[TikTok Live] Connected to @${this.tiktokUsername} (Room ID: ${state?.roomId || 'ok'})`)
      this.emit('connected', this.tiktokUsername)
    })

    this.#tiktokLive.on('disconnected', () => {
      this.#connected = false
      console.log(`[TikTok Live] Disconnected from @${this.tiktokUsername}`)
      this.emit('disconnected', this.#closing)
    })

    this.#tiktokLive.on('error', (err: any) => {
      console.error(`[TikTok Live Error]:`, err)
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
    })

    this.#tiktokLive.on('chat', (data: any) => {
      const comment = (data.comment || '').trim()
      const username = data.nickname || data.uniqueId || 'TikTokUser'
      const userId = `tt_${data.userId || data.uniqueId}`
      const avatar = data.profilePictureUrl || ''

      const userstate: TikTokUserData = {
        'user-id': userId,
        'display-name': `${username} (TikTok)`,
        username: username,
        avatar: avatar,
        platform: 'tiktok'
      }

      // Check guess format: !g <nama negara / koordinat>
      if (/^!g(\s|$)/i.test(comment)) {
        const now = Date.now()
        const lastGuess = this.#lastGuessTimestamp.get(userId) || 0

        // Rate limit 5s per user
        if (now - lastGuess < 5000) {
          return
        }

        this.#lastGuessTimestamp.set(userId, now)
        this.emit('guess', userstate, comment)
      } else if (comment.startsWith('!')) {
        this.emit('message', userstate, comment)
      }
    })

    try {
      await this.#tiktokLive.connect()
      this.#connected = true
      return true
    } catch (err: any) {
      this.#connected = false
      const errorMsg = err?.message || String(err)
      console.error(`[TikTok Live Connect Error]:`, errorMsg)
      throw new Error(errorMsg)
    }
  }

  async close() {
    this.#closing = true
    this.#connected = false
    if (this.#tiktokLive) {
      try {
        this.#tiktokLive.disconnect()
      } catch (_) {}
      this.#tiktokLive = null
    }
    this.emit('disconnected', true)
  }

  isConnected() {
    return this.#connected
  }
}
