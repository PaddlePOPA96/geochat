import { EventEmitter } from 'events'
// @ts-ignore
import { Innertube, UniversalCache } from 'youtubei.js'

export function parseYouTubeInput(input: string): { liveId?: string; channelId?: string; handle?: string } {
  input = input.trim()
  if (!input) return {}

  // Match /watch?v=VIDEO_ID
  const watchMatch = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
  if (watchMatch) return { liveId: watchMatch[1] }

  // Match youtu.be/VIDEO_ID or /live/VIDEO_ID
  const shortMatch = input.match(/(?:youtu\.be\/|\/live\/)([a-zA-Z0-9_-]{11})/)
  if (shortMatch) return { liveId: shortMatch[1] }

  // Match 11 char video id directly
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return { liveId: input }
  }

  // Match channel ID (starts with UC and 24 chars)
  const channelMatch = input.match(/(?:channel\/)?(UC[a-zA-Z0-9_-]{22})/)
  if (channelMatch) return { channelId: channelMatch[1] }

  // Match handle: @channel or /@channel
  const handleMatch = input.match(/@([a-zA-Z0-9_.-]+)/)
  if (handleMatch) return { handle: '@' + handleMatch[1] }

  // Fallback: if starts with UC
  if (input.startsWith('UC')) {
    return { channelId: input }
  }

  return { liveId: input }
}

export default class YouTubeBackend extends EventEmitter {
  #yt: any = null
  #liveChat: any = null
  #connected = false
  #closing = false
  #reconnectTimer: NodeJS.Timeout | null = null
  #reconnectAttempts = 0
  #lastGuessTimestamp: Map<string, number> = new Map()

  streamInput = ''
  liveId: string | undefined
  channelId: string | undefined
  handle: string | undefined

  constructor(options: { streamInput: string }) {
    super()
    this.streamInput = options.streamInput.trim()
    const parsed = parseYouTubeInput(this.streamInput)
    this.liveId = parsed.liveId
    this.channelId = parsed.channelId
    this.handle = parsed.handle
  }

  get botUsername(): string {
    return this.liveId || this.handle || this.channelId || 'YouTubeStream'
  }

  get channelName(): string {
    return this.liveId || this.handle || this.channelId || ''
  }

  get streamTarget(): string {
    return this.liveId || this.handle || this.channelId || this.streamInput
  }

  async connect(): Promise<boolean> {
    this.#closing = false
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }

    try {
      if (!this.#yt) {
        this.#yt = await Innertube.create({
          cache: new UniversalCache(false),
          generate_session_locally: true
        })
      }

      let targetVideoId = this.liveId

      // If handle or channelId provided, find the active live stream
      if (!targetVideoId) {
        if (this.handle || this.channelId) {
          const target = this.handle || this.channelId
          console.log(`[YouTube] Looking up active live stream for ${target}...`)
          const channel = await this.#yt.getChannel(target)
          const liveTab = await channel.getLiveStreams().catch(() => null)
          const activeLive = liveTab?.videos?.find((v: any) => v.is_live) || channel.videos?.find((v: any) => v.is_live)
          if (activeLive && activeLive.id) {
            targetVideoId = activeLive.id
            console.log(`[YouTube] Found active live stream: ${targetVideoId}`)
          }
        }
      }

      if (!targetVideoId) {
        targetVideoId = this.streamInput.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 11)
      }

      if (!targetVideoId) {
        throw new Error('Video ID YouTube tidak ditemukan!')
      }

      console.log(`[YouTube] Fetching live stream info for: ${targetVideoId}...`)
      const videoInfo = await this.#yt.getInfo(targetVideoId)
      
      const liveChat = videoInfo.getLiveChat()
      if (!liveChat) {
        throw new Error(`Live stream ${targetVideoId} tidak memiliki live chat atau sudah berakhir!`)
      }

      this.#liveChat = liveChat
      this.liveId = targetVideoId

      this.#liveChat.on('chat-update', (action: any) => {
        // Handle normal text message or superchat
        try {
          const item = action.item || action
          const authorObj = item.author || action.author
          const authorName = authorObj?.name?.toString() || 'YouTubeUser'
          const authorId = authorObj?.id?.toString() || authorObj?.channel_id?.toString() || authorName
          const avatar = authorObj?.thumbnails?.[0]?.url || ''
          const messageText = item.message?.toString()?.trim() || action.message?.toString()?.trim() || ''

          if (!messageText) return

          console.log(`[YouTube Live Chat] ${authorName}: "${messageText}"`)

          const userstate: UserData = {
            'user-id': `yt_${authorId}`,
            'display-name': authorName,
            username: authorName,
            avatar: avatar,
            badges: {
              broadcaster: authorObj?.is_owner ? '1' : undefined,
              moderator: authorObj?.is_moderator ? '1' : undefined,
              subscriber: authorObj?.is_sponsor ? '1' : undefined
            }
          }

          if (/^!g(\s|$)/i.test(messageText)) {
            const now = Date.now()
            const lastGuess = this.#lastGuessTimestamp.get(authorId) || 0

            // Rate limiting 5 detik per penonton
            if (now - lastGuess < 5000) {
              console.log(`[YouTube Guess Ignored] ${authorName} rate-limited (5s)`)
              return
            }

            this.#lastGuessTimestamp.set(authorId, now)
            console.log(`[YouTube Guess Detected] ${authorName}: "${messageText}"`)
            this.emit('guess', userstate, messageText)
          } else if (messageText.startsWith('!')) {
            this.emit('message', userstate, messageText)
          }
        } catch (err) {
          console.error('[YouTube] Error processing chat action:', err)
        }
      })

      this.#liveChat.on('end', () => {
        console.log(`[YouTube] Live Chat ended for ${this.liveId}`)
        this.#connected = false
        this.emit('disconnected', this.#closing)
        if (!this.#closing) {
          this.#scheduleReconnect('Live chat ended')
        }
      })

      this.#liveChat.on('error', (err: any) => {
        const errorMsg = err?.info || err?.message || String(err)
        const isBadRequest =
          String(err).includes('400') ||
          String(err).includes('INVALID_ARGUMENT') ||
          String(errorMsg).includes('INVALID_ARGUMENT')
        
        if (isBadRequest) {
          console.warn(`[YouTube Live] Stream tidak aktif / live chat berakhir (${this.liveId}). Menghentikan koneksi.`)
          this.close()
          this.emit('error', new Error('Live stream tidak aktif atau video ID tidak valid.'))
          return
        }

        console.error(`[YouTube Live Error]:`, err?.message || err)
        const errorObj = err instanceof Error ? err : new Error(String(err))
        this.emit('error', errorObj)
      })

      // Start live chat streaming
      this.#liveChat.start()
      this.#connected = true
      this.#reconnectAttempts = 0
      console.log(`[YouTube Live] Successfully connected to live stream: ${targetVideoId}`)
      this.emit('connected', targetVideoId)
      return true
    } catch (err: any) {
      this.#connected = false
      const errorMsg = err?.message || String(err)
      const isBadRequest =
        String(err).includes('400') ||
        String(err).includes('INVALID_ARGUMENT') ||
        String(errorMsg).includes('INVALID_ARGUMENT')

      console.warn(`[YouTube Connect Warn]:`, errorMsg)
      this.emit('error', new Error(errorMsg))

      // Jangan reconnect jika video ID salah / 400 Bad Request
      if (!this.#closing && !isBadRequest && this.#reconnectAttempts < 3) {
        this.#scheduleReconnect(errorMsg)
      } else if (isBadRequest) {
        this.close()
      }
      throw new Error(errorMsg)
    }
  }

  #scheduleReconnect(reason?: string) {
    if (this.#closing || this.#reconnectTimer) return
    if (this.#reconnectAttempts >= 3) {
      console.warn(`[YouTube Auto-Reconnect] Telah mencapai batas maksimal (3x). Menghentikan percobaan.`)
      return
    }

    // Exponential backoff: 5s, 10s, 20s
    this.#reconnectAttempts++
    const delay = Math.min(5000 * Math.pow(2, this.#reconnectAttempts - 1), 30000)

    console.log(
      `[YouTube Auto-Reconnect] Attempt #${this.#reconnectAttempts}/3 in ${delay / 1000}s. Reason: ${reason || 'Disconnected'}`
    )

    this.#reconnectTimer = setTimeout(async () => {
      this.#reconnectTimer = null
      if (this.#closing) return
      try {
        await this.connect()
      } catch (err: any) {
        console.warn(`[YouTube Auto-Reconnect] Percobaan #${this.#reconnectAttempts} gagal: ${err?.message || err}`)
      }
    }, delay)
  }

  async close() {
    this.#closing = true
    this.#connected = false
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    if (this.#liveChat) {
      try {
        this.#liveChat.stop()
      } catch (_) {}
      this.#liveChat = null
    }
    this.emit('disconnected', true)
  }

  isConnected() {
    return this.#connected
  }
}
