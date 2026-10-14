import { EventEmitter } from 'events'
import { LiveChat } from 'youtube-chat'

export function parseYouTubeInput(input: string): { liveId?: string; channelId?: string } {
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

  constructor(options: { streamInput: string }) {
    super()

    const parsed = parseYouTubeInput(options.streamInput)
    this.liveId = parsed.liveId
    this.channelId = parsed.channelId

    if (this.channelId) {
      this.#liveChat = new LiveChat({ channelId: this.channelId })
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

    this.#liveChat.on('error', (err) => {
      this.emit('error', err)
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

      if (messageText.startsWith('!g')) {
        this.emit('guess', userstate, messageText)
      } else if (messageText.startsWith('!')) {
        this.emit('message', userstate, messageText)
      }
    })

    const ok = await this.#liveChat.start()
    if (!ok) {
      this.#connected = false
      throw new Error('Failed to start YouTube live chat fetcher')
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
