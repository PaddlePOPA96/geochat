import express from 'express'
import http from 'http'
import { Server as SocketIOServer } from 'socket.io'
import cors from 'cors'
import path from 'path'
import YouTubeBackend from '../main/utils/useYouTubeChat'
import { resolveLocation, parseCoordinates } from '../shared/geocoding'

export { resolveLocation, parseCoordinates }

const app = express()
const server = http.createServer(app)
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

app.use(cors())
app.use(express.json())

// Serve static frontend files
const publicDir = path.resolve(__dirname, '../../public')
app.use(express.static(publicDir))

export function haversineDistance(
  mk1: { lat: number; lng: number },
  mk2: { lat: number; lng: number }
): number {
  const R = 6371.071
  const rlat1 = mk1.lat * (Math.PI / 180)
  const rlat2 = mk2.lat * (Math.PI / 180)
  const difflat = rlat2 - rlat1
  const difflon = (mk2.lng - mk1.lng) * (Math.PI / 180)
  return (
    2 *
    R *
    Math.asin(
      Math.sqrt(
        Math.sin(difflat / 2) ** 2 + Math.cos(rlat1) * Math.cos(rlat2) * Math.sin(difflon / 2) ** 2
      )
    )
  )
}

export function calculateScore(
  distance: number,
  mapScale = 2000,
  maxErrorDistance?: number
): number {
  if (maxErrorDistance && maxErrorDistance > 0) {
    if (distance <= 0.025) return 5000
    return Math.max(0, Math.round(5000 * Math.exp(-10 * (distance / maxErrorDistance))))
  }
  return Math.max(0, Math.round(5000 * Math.pow(0.99866017, (distance * 1000) / mapScale)))
}

// State structures
export interface PlayerGuess {
  userId: string
  username: string
  avatar: string
  position: { lat: number; lng: number }
  distance: number // km
  score: number // 0-5000
  time: number
}

export interface LeaderboardEntry {
  userId: string
  username: string
  avatar: string
  totalScore: number
  totalDistance: number
  roundsCount: number
}

class GameServerManager {
  youtubeBackend: YouTubeBackend | null = null
  youtubeStreamTarget = ''
  youtubeStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  youtubeError = ''

  token: string | null = null
  mapName = 'GeoGuessr Map'
  mapScale = 2000
  maxErrorDistance?: number
  round = 1
  roundLocation: { lat: number; lng: number } | null = null
  guessesOpen = false
  isFinished = false

  roundGuesses: Record<string, PlayerGuess> = {}
  gameLeaderboard: Record<string, LeaderboardEntry> = {}

  // History of rounds in current game
  roundsHistory: {
    round: number
    location: { lat: number; lng: number }
    guesses: PlayerGuess[]
  }[] = []

  connectYouTube(streamInput: string) {
    if (this.youtubeBackend) {
      this.youtubeBackend.close()
      this.youtubeBackend = null
    }

    this.youtubeStreamTarget = streamInput.trim()
    if (!this.youtubeStreamTarget) {
      this.youtubeStatus = 'disconnected'
      this.broadcastState()
      return
    }

    this.youtubeStatus = 'connecting'
    this.broadcastState()

    try {
      this.youtubeBackend = new YouTubeBackend({ streamInput: this.youtubeStreamTarget })

      this.youtubeBackend.on('connected', (liveId: string) => {
        this.youtubeStatus = 'connected'
        console.log(`[Server] YouTube Live chat connected for ${liveId}`)
        this.broadcastState()
      })

      this.youtubeBackend.on('disconnected', (_requested, reason) => {
        this.youtubeStatus = 'disconnected'
        console.log(`[Server] YouTube Live chat disconnected: ${reason}`)
        this.broadcastState()
      })

      this.youtubeBackend.on('error', (err: any) => {
        this.youtubeStatus = 'error'
        this.youtubeError = err?.message || String(err)
        console.error(`[Server] YouTube Live chat error:`, err)
        this.broadcastState()
      })

      this.youtubeBackend.on('guess', (userstate, message) => {
        this.handleChatGuess(userstate, message).catch((err) => {
          console.error('[Server] Error handling guess:', err)
        })
      })

      this.youtubeBackend.connect().catch((err) => {
        this.youtubeStatus = 'error'
        this.youtubeError = err?.message || String(err)
        this.broadcastState()
      })
    } catch (err: any) {
      this.youtubeStatus = 'error'
      this.youtubeError = err?.message || String(err)
      this.broadcastState()
    }
  }

  disconnectYouTube() {
    if (this.youtubeBackend) {
      this.youtubeBackend.close()
      this.youtubeBackend = null
    }
    this.youtubeStatus = 'disconnected'
    this.broadcastState()
  }

  async handleChatGuess(userstate: any, message: string) {
    if (!this.guessesOpen || !this.roundLocation) {
      return
    }

    const clean = message.replace(/^!g\s+/, '').trim()
    const coords = await resolveLocation(clean)
    if (!coords) return

    const distance = haversineDistance(coords, this.roundLocation)
    const score = calculateScore(distance, this.mapScale, this.maxErrorDistance)

    const userId = userstate['user-id'] || userstate.username || 'unknown'
    const username = userstate['display-name'] || userstate.username || 'Anonymous'
    const avatar = userstate.avatar || ''

    const isNewPlayer = !this.roundGuesses[userId]

    const playerGuess: PlayerGuess = {
      userId,
      username,
      avatar,
      position: coords,
      distance: Math.round(distance * 100) / 100,
      score,
      time: Date.now()
    }

    this.roundGuesses[userId] = playerGuess

    io.emit('guess-added', {
      guess: playerGuess,
      isNewPlayer,
      totalGuesses: Object.keys(this.roundGuesses).length
    })

    console.log(
      `[Guess] ${username} [${clean}]: ${playerGuess.distance} km -> ${playerGuess.score} pts`
    )
  }

  startNewRound(roundNumber: number, location: { lat: number; lng: number }) {
    this.round = roundNumber
    this.roundLocation = location
    this.roundGuesses = {}
    this.guessesOpen = true
    this.isFinished = false

    io.emit('round-started', {
      round: this.round,
      location: this.roundLocation,
      mapName: this.mapName
    })

    this.broadcastState()
    console.log(
      `[Server] Round ${this.round} started at lat: ${location.lat}, lng: ${location.lng}`
    )
  }

  finishRound() {
    this.guessesOpen = false

    // Record round guesses into leaderboard
    const currentRoundGuesses = Object.values(this.roundGuesses)
    for (const guess of currentRoundGuesses) {
      if (!this.gameLeaderboard[guess.userId]) {
        this.gameLeaderboard[guess.userId] = {
          userId: guess.userId,
          username: guess.username,
          avatar: guess.avatar,
          totalScore: 0,
          totalDistance: 0,
          roundsCount: 0
        }
      }
      this.gameLeaderboard[guess.userId].totalScore += guess.score
      this.gameLeaderboard[guess.userId].totalDistance += guess.distance
      this.gameLeaderboard[guess.userId].roundsCount += 1
    }

    if (this.roundLocation) {
      this.roundsHistory.push({
        round: this.round,
        location: this.roundLocation,
        guesses: currentRoundGuesses
      })
    }

    // Sort round results by score desc, distance asc
    const sortedRoundResults = [...currentRoundGuesses].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.distance - b.distance
    })

    io.emit('round-finished', {
      round: this.round,
      location: this.roundLocation,
      results: sortedRoundResults,
      leaderboard: this.getSortedLeaderboard()
    })

    this.broadcastState()
    console.log(
      `[Server] Round ${this.round} finished. Total guesses: ${sortedRoundResults.length}`
    )
  }

  finishGame() {
    this.finishRound()
    this.isFinished = true
    io.emit('game-finished', {
      rounds: this.roundsHistory,
      leaderboard: this.getSortedLeaderboard()
    })
    this.broadcastState()
  }

  resetGame() {
    this.round = 1
    this.roundGuesses = {}
    this.gameLeaderboard = {}
    this.roundsHistory = []
    this.guessesOpen = false
    this.isFinished = false
    this.broadcastState()
  }

  getSortedLeaderboard(): LeaderboardEntry[] {
    return Object.values(this.gameLeaderboard).sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore
      return a.totalDistance - b.totalDistance
    })
  }

  getState() {
    return {
      youtubeStreamTarget: this.youtubeStreamTarget,
      youtubeStatus: this.youtubeStatus,
      youtubeError: this.youtubeError,
      token: this.token,
      mapName: this.mapName,
      round: this.round,
      roundLocation: this.roundLocation,
      guessesOpen: this.guessesOpen,
      isFinished: this.isFinished,
      roundGuesses: Object.values(this.roundGuesses).sort((a, b) => b.score - a.score),
      leaderboard: this.getSortedLeaderboard()
    }
  }

  broadcastState() {
    io.emit('state-update', this.getState())
  }
}

const manager = new GameServerManager()

// REST API Endpoints
app.get('/api/state', (_req, res) => {
  res.json(manager.getState())
})

// YouTube Connect
app.post('/api/youtube/connect', (req, res) => {
  const { streamUrl } = req.body
  if (!streamUrl) {
    res.status(400).json({ error: 'streamUrl is required' })
    return
  }
  manager.connectYouTube(streamUrl)
  res.json({ success: true, state: manager.getState() })
  return
})

app.post('/api/youtube/disconnect', (_req, res) => {
  manager.disconnectYouTube()
  res.json({ success: true, state: manager.getState() })
})

// GeoGuessr Userscript Bridge Endpoint
app.post('/api/geoguessr/update', (req, res) => {
  const { token, mapName, round, location, bounds, maxErrorDistance, roundFinished, gameFinished } =
    req.body

  if (mapName) manager.mapName = mapName
  if (token) manager.token = token
  if (bounds) {
    const scale = haversineDistance(bounds.min, bounds.max) / 7.458421
    manager.mapScale = scale || 2000
  }
  if (maxErrorDistance) manager.maxErrorDistance = maxErrorDistance

  if (gameFinished) {
    manager.finishGame()
  } else if (roundFinished) {
    manager.finishRound()
  } else if (location && round) {
    manager.startNewRound(round, location)
  }

  res.json({ success: true, state: manager.getState() })
})

// Manual Controls
app.post('/api/game/open-guesses', (_req, res) => {
  manager.guessesOpen = true
  manager.broadcastState()
  res.json({ success: true })
})

app.post('/api/game/close-guesses', (_req, res) => {
  manager.guessesOpen = false
  manager.broadcastState()
  res.json({ success: true })
})

app.post('/api/game/reset', (_req, res) => {
  manager.resetGame()
  res.json({ success: true })
})

// Serve Dashboard & Overlay HTML routes
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(publicDir, 'dashboard/index.html'))
})

app.get('/overlay', (_req, res) => {
  res.sendFile(path.join(publicDir, 'overlay/index.html'))
})

app.get('/', (_req, res) => {
  res.redirect('/dashboard')
})

// Socket.IO Events
io.on('connection', (socket) => {
  // Send current state immediately on connection
  socket.emit('state-update', manager.getState())

  socket.on('request-state', () => {
    socket.emit('state-update', manager.getState())
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`===============================================`)
  console.log(`🚀 ChatGuessr Standalone Server running on port ${PORT}`)
  console.log(`📱 Streamer Dashboard : http://localhost:${PORT}/dashboard`)
  console.log(`📺 OBS Studio Overlay: http://localhost:${PORT}/overlay`)
  console.log(`===============================================`)
})
