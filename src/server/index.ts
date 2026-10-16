import express from 'express'
import http from 'http'
import { Server as SocketIOServer } from 'socket.io'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { exec } from 'child_process'
import YouTubeBackend from '../main/utils/useYouTubeChat'
import TikTokBackend from '../main/utils/useTikTokChat'
import { resolveLocation, parseCoordinates } from '../shared/geocoding'
import { embeddedDashboardHtml, embeddedOverlayHtml } from './embeddedTemplates'

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

// Allow embedding overlay in GeoGuessr
app.use((_req, res, next) => {
  res.removeHeader('X-Frame-Options')
  res.setHeader('Content-Security-Policy', "frame-ancestors *")
  next()
})

// Serve static frontend files (if directory exists on disk)
const publicDir = fs.existsSync(path.resolve(__dirname, '../../public'))
  ? path.resolve(__dirname, '../../public')
  : (fs.existsSync(path.join(process.cwd(), 'public'))
    ? path.join(process.cwd(), 'public')
    : path.resolve(__dirname, 'public'))

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir))
}

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

  tiktokBackend: TikTokBackend | null = null
  tiktokUsername = ''
  tiktokStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  tiktokError = ''

  token: string | null = null
  mapName = 'GeoGuessr Map'
  mapScale = 2000
  maxErrorDistance?: number
  round = 1
  roundLocation: { lat: number; lng: number } | null = null
  guessesOpen = false
  isFinished = false

  // Streamer Score & Stats
  streamerStats: {
    roundScore: number
    roundDistance: number
    totalScore: number
    totalDistance: number
    roundsCount: number
    history: { round: number; score: number; distance: number }[]
  } = {
    roundScore: 0,
    roundDistance: 0,
    totalScore: 0,
    totalDistance: 0,
    roundsCount: 0,
    history: []
  }

  roundGuesses: Record<string, PlayerGuess> = {}
  gameLeaderboard: Record<string, LeaderboardEntry> = {}
  userLastGuessTime: Record<string, number> = {}

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
    this.youtubeError = ''
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

  connectTikTok(username: string) {
    if (this.tiktokBackend) {
      this.tiktokBackend.close()
      this.tiktokBackend = null
    }

    this.tiktokUsername = username.trim().replace(/^@/, '')
    if (!this.tiktokUsername) {
      this.tiktokStatus = 'disconnected'
      this.broadcastState()
      return
    }

    this.tiktokStatus = 'connecting'
    this.tiktokError = ''
    this.broadcastState()

    try {
      this.tiktokBackend = new TikTokBackend({ username: this.tiktokUsername })

      this.tiktokBackend.on('connected', (user: string) => {
        this.tiktokStatus = 'connected'
        console.log(`[Server] TikTok Live connected for @${user}`)
        this.broadcastState()
      })

      this.tiktokBackend.on('disconnected', (_closing: boolean) => {
        this.tiktokStatus = 'disconnected'
        console.log(`[Server] TikTok Live disconnected`)
        this.broadcastState()
      })

      this.tiktokBackend.on('error', (err: any) => {
        this.tiktokStatus = 'error'
        this.tiktokError = err?.message || String(err)
        console.error(`[Server] TikTok Live error:`, err)
        this.broadcastState()
      })

      this.tiktokBackend.on('guess', (userstate, message) => {
        this.handleChatGuess(userstate, message).catch((err) => {
          console.error('[Server] Error handling TikTok guess:', err)
        })
      })

      this.tiktokBackend.connect().catch((err) => {
        this.tiktokStatus = 'error'
        this.tiktokError = err?.message || String(err)
        this.broadcastState()
      })
    } catch (err: any) {
      this.tiktokStatus = 'error'
      this.tiktokError = err?.message || String(err)
      this.broadcastState()
    }
  }

  disconnectTikTok() {
    if (this.tiktokBackend) {
      this.tiktokBackend.close()
      this.tiktokBackend = null
    }
    this.tiktokStatus = 'disconnected'
    this.broadcastState()
  }

  async handleChatGuess(userstate: any, message: string) {
    if (!this.guessesOpen) {
      console.log(`[Guess Ignored] Guesses are closed: "${message}"`)
      return
    }

    const userId = userstate['user-id'] || userstate.username || 'unknown'
    const now = Date.now()
    const lastGuess = this.userLastGuessTime[userId] || 0
    if (now - lastGuess < 5000) {
      console.log(`[Guess Rate-Limited] ${userId} sent guess within 5 seconds`)
      return
    }
    this.userLastGuessTime[userId] = now

    const clean = message.replace(/^!g\s*/i, '').trim()
    const coords = await resolveLocation(clean)
    if (!coords) {
      console.log(`[Guess Ignored] Could not resolve coordinates for: "${clean}"`)
      return
    }

    const targetLoc = this.roundLocation || { lat: -6.2088, lng: 106.8456 }
    const distance = Math.round(haversineDistance(coords, targetLoc) * 100) / 100
    const score = this.roundLocation
      ? calculateScore(distance, this.mapScale, this.maxErrorDistance)
      : Math.max(1, 5000 - Math.round(distance * 2))

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
    // Check if this round is already active with the same location
    if (
      this.round === roundNumber &&
      this.roundLocation &&
      this.roundLocation.lat === location.lat &&
      this.roundLocation.lng === location.lng &&
      this.guessesOpen
    ) {
      return
    }

    const hadTemporaryGuesses =
      this.round === roundNumber &&
      this.roundLocation === null &&
      Object.keys(this.roundGuesses).length > 0

    this.round = roundNumber
    this.roundLocation = location
    this.guessesOpen = true
    this.isFinished = false

    if (hadTemporaryGuesses) {
      console.log(
        `[Server] Round ${this.round} location received (${location.lat}, ${location.lng}). Recalculating ${Object.keys(this.roundGuesses).length} pre-round guesses!`
      )
      for (const [userId, guess] of Object.entries(this.roundGuesses)) {
        const distance = Math.round(haversineDistance(guess.position, this.roundLocation) * 100) / 100
        const score = calculateScore(distance, this.mapScale, this.maxErrorDistance)
        this.roundGuesses[userId] = {
          ...guess,
          distance,
          score
        }
      }
    } else {
      this.roundGuesses = {}
    }

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
    this.streamerStats = {
      roundScore: 0,
      roundDistance: 0,
      totalScore: 0,
      totalDistance: 0,
      roundsCount: 0,
      history: []
    }
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
      tiktokUsername: this.tiktokUsername,
      tiktokStatus: this.tiktokStatus,
      tiktokError: this.tiktokError,
      token: this.token,
      mapName: this.mapName,
      round: this.round,
      roundLocation: this.roundLocation,
      streamerStats: this.streamerStats,
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

// TikTok Connect
app.post('/api/tiktok/connect', (req, res) => {
  const { username } = req.body
  if (!username) {
    res.status(400).json({ error: 'username is required' })
    return
  }
  manager.connectTikTok(username)
  res.json({ success: true, state: manager.getState() })
})

app.post('/api/tiktok/disconnect', (_req, res) => {
  manager.disconnectTikTok()
  res.json({ success: true, state: manager.getState() })
})

// GeoGuessr Userscript Bridge Endpoint
app.post('/api/geoguessr/update', (req, res) => {
  const {
    token,
    mapName,
    round,
    location,
    bounds,
    maxErrorDistance,
    streamerGuess,
    roundFinished,
    gameFinished
  } = req.body

  if (mapName) manager.mapName = mapName
  if (token && manager.token && token !== manager.token) {
    console.log(`[Server] New game detected (${manager.token} -> ${token}), resetting game state`)
    manager.resetGame()
  }
  if (token) manager.token = token
  if (bounds) {
    const scale = haversineDistance(bounds.min, bounds.max) / 7.458421
    manager.mapScale = scale || 2000
  }
  if (maxErrorDistance) manager.maxErrorDistance = maxErrorDistance

  if (streamerGuess) {
    const rScore = typeof streamerGuess.score === 'number' ? streamerGuess.score : 0
    const rDist = typeof streamerGuess.distance === 'number' ? streamerGuess.distance : 0
    const currentR = round || manager.round

    manager.streamerStats.roundScore = rScore
    manager.streamerStats.roundDistance = rDist
    manager.streamerStats.totalScore = typeof streamerGuess.totalScore === 'number'
      ? streamerGuess.totalScore
      : manager.streamerStats.totalScore + rScore
    manager.streamerStats.totalDistance = typeof streamerGuess.totalDistance === 'number'
      ? streamerGuess.totalDistance
      : manager.streamerStats.totalDistance + rDist
    manager.streamerStats.roundsCount = currentR
    manager.streamerStats.history.push({
      round: currentR,
      score: rScore,
      distance: rDist
    })

    // Masukkan jawaban streamer langsung ke daftar tebakan (PlayerGuess)
    const streamerPosition = (typeof streamerGuess.lat === 'number' && typeof streamerGuess.lng === 'number')
      ? { lat: streamerGuess.lat, lng: streamerGuess.lng }
      : (manager.roundLocation || { lat: 0, lng: 0 })

    manager.roundGuesses['streamer'] = {
      userId: 'streamer',
      username: '👑 Streamer',
      avatar: '',
      position: streamerPosition,
      distance: rDist,
      score: rScore,
      time: Date.now()
    }

    console.log(
      `[Server] Streamer Guess inserted into answers: ${rScore} pts (${rDist} km).`
    )
  }

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
app.get(['/dashboard', '/dashboard/'], (_req, res) => {
  const filePath = path.join(publicDir, 'dashboard/index.html')
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath)
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8').send(embeddedDashboardHtml)
  }
})

app.get(['/overlay', '/overlay/'], (_req, res) => {
  const filePath = path.join(publicDir, 'overlay/index.html')
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath)
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8').send(embeddedOverlayHtml)
  }
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

const PORT = process.env.PORT || 5050
if (process.env.NODE_ENV !== 'test') {
  // Global error handler so console window doesn't crash or auto-close
  process.on('uncaughtException', (err) => {
    console.error('\n===============================================')
    console.error('❌ TERJADI KESALAHAN PADA SERVER:')
    console.error(err)
    console.error('===============================================')
    console.log('\nTekan tombol ENTER untuk keluar...')
    process.stdin.resume()
    process.stdin.on('data', () => process.exit(1))
    setTimeout(() => {}, 86400000)
  })

  process.on('unhandledRejection', (reason) => {
    console.warn('⚠️ Warning (Unhandled Rejection):', reason)
  })

  server.on('error', (err: any) => {
    console.error(`\n===============================================`)
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ PORT ${PORT} SUDAH DIGUNAKAN OLEH APLIKASI LAIN!`)
      console.error(`Silakan tutup aplikasi lain atau instance MabarBang lain yang memakai port ${PORT}.`)
    } else {
      console.error(`❌ Gagal memulai server di port ${PORT}:`, err.message || err)
    }
    console.error(`===============================================`)
    console.log(`\nTekan tombol ENTER untuk keluar...`)
    process.stdin.resume()
    process.stdin.on('data', () => process.exit(1))
    setTimeout(() => {}, 86400000)
  })

  server.listen(PORT, () => {
    console.log(`===============================================`)
    console.log(`🚀 MabarBang Server: Online (Port ${PORT})`)
    console.log(`📱 Streamer Dashboard : http://localhost:${PORT}/dashboard`)
    console.log(`📺 OBS Studio Overlay: http://localhost:${PORT}/overlay`)
    console.log(`===============================================`)

    // Auto-open browser on desktop if not in CI
    if (!process.env.CI) {
      const url = `http://localhost:${PORT}/dashboard`
      if (process.platform === 'win32') {
        exec(`cmd /c start "" "${url}"`, () => {})
      } else if (process.platform === 'darwin') {
        exec(`open "${url}"`, () => {})
      } else {
        exec(`xdg-open "${url}"`, () => {})
      }
    }
  })

  // Keep console process alive on Windows/macOS
  process.stdin.resume()
}
