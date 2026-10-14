import { EventEmitter } from 'events'
import { LiveChat } from 'youtube-chat'
import axios from 'axios'

// Set browser headers & consent cookie to avoid Google Consent & Datacenter block
axios.defaults.headers.common['User-Agent'] =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
axios.defaults.headers.common['Accept-Language'] = 'en-US,en;q=0.9'
axios.defaults.headers.common['Accept'] =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
axios.defaults.headers.common['Cookie'] =
  'SOCS=CAESEwgDEgk2ODE3ODg0MjAaAmVuIAEaBgiA_LyaBg; CONSENT=YES+cb.20210328-17-p0.en+FX+100;'

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
  #liveChat: LiveChat | null = null
  #connected = false
  #closing = false

  liveId: string | undefined
  channelId: string | undefined
  handle: string | undefined

  constructor(options: { streamInput: string }) {
    super()

    const parsed = parseYouTubeInput(options.streamInput)
    this.liveId = parsed.liveId
    this.channelId = parsed.channelId
    this.handle = parsed.handle

    if (this.channelId) {
      this.#liveChat = new LiveChat({ channelId: this.channelId })
    } else if (this.handle) {
      this.#liveChat = new LiveChat({ handle: this.handle })
    } else if (this.liveId) {
      this.#liveChat = new LiveChat({ liveId: this.liveId })
    }
  }

  get botUsername(): string {
    return this.liveId || this.channelId || 'YouTubeStream'
  }

  get channelName(): string {
    return this.liveId || this.channelId || ''
  }

  get streamTarget(): string {
    return this.liveId || this.channelId || ''
  }

  async connect(): Promise<boolean> {
    if (!this.#liveChat) {
      throw new Error('No valid YouTube live ID or channel ID provided')
    }

    this.#closing = false

    this.#liveChat.on('start', (liveId) => {
      this.#connected = true
      this.liveId = liveId
      this.emit('connected', liveId)
    })

    this.#liveChat.on('end', (reason) => {
      this.#connected = false
      this.emit('disconnected', this.#closing, reason)
    })

    let lastError: Error | null = null
    this.#liveChat.on('error', (err) => {
      lastError = err instanceof Error ? err : new Error(String(err))
      this.emit('error', lastError)
    })

    this.#liveChat.on('chat', (chatItem) => {
      const messageText = (chatItem.message || [])
        .map((m: any) => ('text' in m ? m.text : m.emojiText || ''))
        .join('')
        .trim()

      const userstate: UserData = {
        'user-id': chatItem.author.channelId,
        'display-name': chatItem.author.name,
        username: chatItem.author.name,
        avatar: chatItem.author.thumbnail?.url,
        color: chatItem.superchat?.color || '#FFFFFF',
        badges: {
          broadcaster: chatItem.isOwner ? '1' : undefined,
          moderator: chatItem.isModerator ? '1' : undefined,
          subscriber: chatItem.isMembership ? '1' : undefined
        }
      }

      if (/^!g(\s|$)/i.test(messageText)) {
        this.emit('guess', userstate, messageText)
      } else if (messageText.startsWith('!')) {
        this.emit('message', userstate, messageText)
      }
    })

    const ok = await this.#liveChat.start()
    if (!ok) {
      this.#connected = false
      throw lastError || new Error('Failed to start YouTube live chat fetcher')
    }

    return true
  }

  async close() {
    this.#closing = true
    this.#connected = false
    if (this.#liveChat) {
      this.#liveChat.stop()
      this.#liveChat = null
    }
    this.emit('disconnected', true)
  }

  isConnected() {
    return this.#connected
  }

  async sendMessage(message: string, _options: { system?: boolean } = {}) {
    console.log(`[YouTube Bot Message]: ${message}`)
  }
}
