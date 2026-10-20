import express from 'express'
import http from 'http'
import { Server as SocketIOServer } from 'socket.io'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { exec } from 'child_process'
import YouTubeBackend from '../main/utils/useYouTubeChat'
import TikTokBackend from '../main/utils/useTikTokChat'
import GeoIndoBackend from '../main/utils/useGeoIndoChat'
import { resolveLocation, parseCoordinates } from '../shared/geocoding'
import { embeddedDashboardHtml, embeddedOverlayHtml, embeddedUserscript } from './embeddedTemplates'

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

  geoindoBackend: GeoIndoBackend | null = null
  geoindoUid = ''
  geoindoStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  geoindoError = ''

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

  // Batch queue for incoming guesses to prevent socket flood
  guessBatchQueue: PlayerGuess[] = []
  batchIntervalTimer: NodeJS.Timeout | null = null
  stateBroadcastTimer: NodeJS.Timeout | null = null

  constructor() {
    // Start flush timer: Flush guess batches every 250ms
    this.batchIntervalTimer = setInterval(() => {
      this.flushGuessBatch()
    }, 250)

    // Periodically clean stale rate-limit timestamps (every 5 minutes)
    setInterval(() => {
      const now = Date.now()
      for (const [uid, time] of Object.entries(this.userLastGuessTime)) {
        if (now - time > 120000) {
          delete this.userLastGuessTime[uid]
        }
      }
    }, 300000)
  }

  flushGuessBatch() {
    if (this.guessBatchQueue.length === 0) return
    const batch = this.guessBatchQueue.splice(0)
    io.emit('guesses-batch', {
      guesses: batch,
      totalGuesses: Object.keys(this.roundGuesses).length
    })
    // Also emit guess-added with the latest guess for backward compatibility
    const latest = batch[batch.length - 1]
    io.emit('guess-added', {
      guess: latest,
      totalGuesses: Object.keys(this.roundGuesses).length
    })
  }

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

    // Clean username (handle URLs like https://www.tiktok.com/@mygnuga/live or @mygnuga)
    let cleanUser = username.trim()
    const urlMatch = cleanUser.match(/tiktok\.com\/@([^/?#]+)/i)
    if (urlMatch && urlMatch[1]) {
      cleanUser = urlMatch[1]
    } else {
      cleanUser = cleanUser.replace(/^@/, '').split('/')[0].split('?')[0].trim()
    }

    this.tiktokUsername = cleanUser
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

  connectGeoIndo(uidOrUrl: string) {
    if (this.geoindoBackend) {
      this.geoindoBackend.close()
      this.geoindoBackend = null
    }

    let cleanUid = uidOrUrl.trim()
    const urlMatch = cleanUid.match(/uid=([a-zA-Z0-9_-]+)/i)
    if (urlMatch && urlMatch[1]) {
      cleanUid = urlMatch[1]
    }

    this.geoindoUid = cleanUid
    if (!this.geoindoUid) {
      this.geoindoStatus = 'disconnected'
      this.broadcastState()
      return
    }

    this.geoindoStatus = 'connecting'
    this.geoindoError = ''
    this.broadcastState()

    try {
      this.geoindoBackend = new GeoIndoBackend({ uid: this.geoindoUid })

      this.geoindoBackend.on('connected', (uid: string) => {
        this.geoindoStatus = 'connected'
        console.log(`[Server] GeoIndo Donation Stream connected for UID ${uid}`)
        this.broadcastState()
      })

      this.geoindoBackend.on('disconnected', () => {
        this.geoindoStatus = 'disconnected'
        console.log(`[Server] GeoIndo Donation Stream disconnected`)
        this.broadcastState()
      })

      this.geoindoBackend.on('error', (err: any) => {
        this.geoindoStatus = 'error'
        this.geoindoError = err?.message || String(err)
        console.error(`[Server] GeoIndo Stream error:`, err)
        this.broadcastState()
      })

      this.geoindoBackend.on('guess', (userstate, message) => {
        this.handleChatGuess(userstate, message).catch((err) => {
          console.error('[Server] Error handling GeoIndo donation guess:', err)
        })
      })

      this.geoindoBackend.connect().catch((err) => {
        this.geoindoStatus = 'error'
        this.geoindoError = err?.message || String(err)
        this.broadcastState()
      })
    } catch (err: any) {
      this.geoindoStatus = 'error'
      this.geoindoError = err?.message || String(err)
      this.broadcastState()
    }
  }

  disconnectGeoIndo() {
    if (this.geoindoBackend) {
      this.geoindoBackend.close()
      this.geoindoBackend = null
    }
    this.geoindoStatus = 'disconnected'
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
    this.guessBatchQueue.push(playerGuess)

    // Trigger throttled state update so clients get live scores smoothly
    this.throttleBroadcastState()

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

    // Reset nilai tebakan streamer untuk ronde yang baru berjalan
    this.streamerStats.roundScore = 0
    this.streamerStats.roundDistance = 0

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
      geoindoUid: this.geoindoUid,
      geoindoStatus: this.geoindoStatus,
      geoindoError: this.geoindoError,
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

  throttleBroadcastState() {
    if (this.stateBroadcastTimer) return
    this.stateBroadcastTimer = setTimeout(() => {
      this.stateBroadcastTimer = null
      this.broadcastState()
    }, 400)
  }

  broadcastState() {
    if (this.stateBroadcastTimer) {
      clearTimeout(this.stateBroadcastTimer)
      this.stateBroadcastTimer = null
    }
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

// GeoIndo Donation Stream Connect
app.post('/api/geoindo/connect', (req, res) => {
  const { uid } = req.body
  if (!uid) {
    res.status(400).json({ error: 'uid is required' })
    return
  }
  manager.connectGeoIndo(uid)
  res.json({ success: true, state: manager.getState() })
})

app.post('/api/geoindo/disconnect', (_req, res) => {
  manager.disconnectGeoIndo()
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

// Serve Userscript directly so Tampermonkey can auto-update or @require it live
app.get(['/chatguessr.user.js', '/userscript'], (_req, res) => {
  const scriptCandidates = [
    path.resolve(__dirname, '../../userscript/chatguessr-connector.user.js'),
    path.join(process.cwd(), 'userscript/chatguessr-connector.user.js'),
    path.resolve(__dirname, 'userscript/chatguessr-connector.user.js')
  ]
  const targetPath = scriptCandidates.find((p) => fs.existsSync(p))
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  if (targetPath) {
    res.sendFile(targetPath)
  } else if (embeddedUserscript) {
    res.send(embeddedUserscript)
  } else {
    res.status(404).send('// Userscript not found on disk')
  }
})

app.get('/', (_req, res) => {
  res.redirect('/dashboard')
})

export const APP_VERSION = '3.2.0'
export const GITHUB_REPO = 'PaddlePOPA96/geochat'

export interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  releaseUrl: string
  downloadUrl: string
  releaseNotes: string
  checkedAt: number
}

let cachedUpdateInfo: UpdateInfo = {
  hasUpdate: false,
  currentVersion: APP_VERSION,
  latestVersion: APP_VERSION,
  releaseUrl: `https://github.com/${GITHUB_REPO}/releases`,
  downloadUrl: `https://github.com/${GITHUB_REPO}/releases/latest`,
  releaseNotes: '',
  checkedAt: 0
}

function compareSemVer(v1: string, v2: string): number {
  const clean1 = v1.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  const clean2 = v2.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  const maxLen = Math.max(clean1.length, clean2.length)
  for (let i = 0; i < maxLen; i++) {
    const a = clean1[i] || 0
    const b = clean2[i] || 0
    if (a > b) return 1
    if (a < b) return -1
  }
  return 0
}

export async function checkForAppUpdates(): Promise<UpdateInfo> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MabarBang-App',
        Accept: 'application/vnd.github.v3+json'
      }
    })
    clearTimeout(timer)

    if (res.ok) {
      const data: any = await res.json()
      const latestTag = (data.tag_name || '').replace(/^v/, '').trim()
      const releaseUrl = data.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`
      let downloadUrl = releaseUrl

      if (Array.isArray(data.assets) && data.assets.length > 0) {
        const exeAsset = data.assets.find((a: any) =>
          typeof a.name === 'string' && (a.name.endsWith('.exe') || a.name.endsWith('.zip'))
        )
        if (exeAsset?.browser_download_url) {
          downloadUrl = exeAsset.browser_download_url
        }
      }

      const isNewer = latestTag && compareSemVer(latestTag, APP_VERSION) > 0
      cachedUpdateInfo = {
        hasUpdate: Boolean(isNewer),
        currentVersion: APP_VERSION,
        latestVersion: latestTag || APP_VERSION,
        releaseUrl,
        downloadUrl,
        releaseNotes: (data.body || '').slice(0, 300),
        checkedAt: Date.now()
      }
      return cachedUpdateInfo
    }
  } catch (_err) {
    // Offline / timeout: abaikan dan lanjut
  }

  cachedUpdateInfo.checkedAt = Date.now()
  return cachedUpdateInfo
}

// REST route for checking update
app.get('/api/update-info', (_req, res) => {
  res.json(cachedUpdateInfo)
})

// Socket.IO Events
io.on('connection', (socket) => {
  // Send current state immediately on connection
  socket.emit('state-update', manager.getState())
  socket.emit('update-info', cachedUpdateInfo)

  socket.on('request-state', () => {
    socket.emit('state-update', manager.getState())
    socket.emit('update-info', cachedUpdateInfo)
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

  function printNeofetchBanner() {
    const cpus = os.cpus() || []
    const rawCpu = cpus.length > 0 ? cpus[0].model.replace(/\s+/g, ' ').trim() : 'Unknown CPU'
    const totalMemGB = (os.totalmem() / 1024 ** 3).toFixed(2)
    const freeMemGB = (os.freemem() / 1024 ** 3).toFixed(2)
    const usedMemGB = ((os.totalmem() - os.freemem()) / 1024 ** 3).toFixed(2)
    const memPercent = (((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1)
    
    const uptimeSec = os.uptime()
    const uptimeDays = Math.floor(uptimeSec / 86400)
    const uptimeHours = Math.floor((uptimeSec % 86400) / 3600)
    const uptimeMins = Math.floor((uptimeSec % 3600) / 60)
    const uptimeStr = uptimeDays > 0 
      ? `${uptimeDays}d ${uptimeHours}h ${uptimeMins}m`
      : `${uptimeHours}h ${uptimeMins}m`

    let osName = os.type()
    if (osName === 'Windows_NT') osName = 'Windows'
    else if (osName === 'Darwin') osName = 'macOS'

    const cCyan = '\x1b[36m'
    const cYellow = '\x1b[33m'
    const cGreen = '\x1b[32m'
    const cMagenta = '\x1b[35m'
    const cReset = '\x1b[0m'
    const cBold = '\x1b[1m'
    const cDim = '\x1b[2m'

    const cBlue = '\x1b[38;2;122;162;255m'
    const cBlue2 = '\x1b[38;2;140;153;253m'
    const cBlue3 = '\x1b[38;2;149;148;252m'
    const cBlue4 = '\x1b[38;2;158;144;251m'
    const cPurple = '\x1b[38;2;167;139;250m'
    const cLine = '\x1b[38;2;145;151;253m'

    console.log(`
${cBlue}███╗   ███╗  █████╗  ██████╗   █████╗  ██████╗ ${cReset}
${cBlue2}████╗ ████║ ██╔══██╗ ██╔══██╗ ██╔══██╗ ██╔══██╗${cReset}
${cBlue2}██╔████╔██║ ███████║ ██████╔╝ ███████║ ██████╔╝${cReset}
${cBlue3}██║╚██╔╝██║ ██╔══██║ ██╔══██╗ ██╔══██║ ██╔══██╗${cReset}
${cBlue4}██║ ╚═╝ ██║ ██║  ██║ ██████╔╝ ██║  ██║ ██║  ██║${cReset}
${cPurple}╚═╝     ╚═╝ ╚═╝  ╚═╝ ╚═════╝  ╚═╝  ╚═╝ ╚═╝  ╚═╝${cReset}
${cLine}┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄${cReset}
${cPurple}geoguessr interactive program${cReset}

  ${cBold}${cCyan}OS${cReset}      : ${osName} ${os.release()} (${os.arch()})
  ${cBold}${cCyan}Host${cReset}    : ${os.hostname()}
  ${cBold}${cCyan}CPU${cReset}     : ${rawCpu} (${cpus.length} threads)
  ${cBold}${cCyan}RAM${cReset}     : ${usedMemGB} GB / ${totalMemGB} GB ${cDim}(${memPercent}% used, ${freeMemGB} GB free)${cReset}
  ${cBold}${cCyan}Uptime${cReset}  : ${uptimeStr}
  ${cBold}${cCyan}Node.js${cReset} : ${process.version} (${process.platform})
`)
  }

  // Check update first, then start server & open port
  ;(async () => {
    printNeofetchBanner()

    console.log(`================================================================================`)
    console.log(`⚡ MabarBang v${APP_VERSION} (kikobooo x arvana prod)`)
    console.log(`🔍 Memeriksa pembaruan di GitHub Releases...`)
    
    const update = await checkForAppUpdates()
    if (update.hasUpdate) {
      console.log(`🔔 UPDATE TERSEDIA: v${update.latestVersion} (Versi saat ini: v${update.currentVersion})`)
      console.log(`📥 Download Link  : ${update.downloadUrl}`)
      console.log(`🔗 Catatan Rilis  : ${update.releaseUrl}`)

      // Otomatis download & update installer di background jika user memakai Windows (dengan auto-delete tanpa sampah)
      if (process.platform === 'win32' && update.downloadUrl.endsWith('.exe')) {
        console.log(`🚀 Men-download update otomatis di background...`)
        try {
          const tempDir = os.tmpdir()
          const installerPath = path.join(tempDir, `MabarBang-Update-${update.latestVersion}.exe`)
          
          // Bersihkan file installer lama di folder temp agar tidak menumpuk
          try {
            const files = fs.readdirSync(tempDir)
            for (const file of files) {
              if (file.startsWith('MabarBang-Update-') && file.endsWith('.exe') && file !== path.basename(installerPath)) {
                try { fs.unlinkSync(path.join(tempDir, file)) } catch (_) {}
              }
            }
          } catch (_) {}

          fetch(update.downloadUrl).then(async (downloadRes) => {
            if (!downloadRes.ok) throw new Error(`HTTP ${downloadRes.status}`)
            const buffer = Buffer.from(await downloadRes.arrayBuffer())
            fs.writeFileSync(installerPath, buffer)
            console.log(`\n================================================================================`)
            console.log(`✨ UPDATE v${update.latestVersion} SIAP DI-INSTALL!`)
            console.log(`💡 Menjalankan installer dan membersihkan file sementara otomatis...`)
            console.log(`================================================================================\n`)
            
            // Jalankan installer /VERYSILENT /SUPPRESSMSGBOXES lalu otomatis hapus file installer setelah selesai
            exec(`start /wait "" "${installerPath}" /VERYSILENT /SUPPRESSMSGBOXES && del /f /q "${installerPath}"`, () => {
              try {
                if (fs.existsSync(installerPath)) {
                  fs.unlinkSync(installerPath)
                }
              } catch (_) {}
            })
          }).catch(err => {
            console.warn(`⚠️ Gagal download update otomatis (${err.message}). Silakan unduh manual: ${update.downloadUrl}`)
          })
        } catch (e) {
          // ignore background update error
        }
      }
    } else {
      console.log(`✅ Aplikasi sudah menggunakan versi terbaru (v${APP_VERSION})`)
    }
    console.log(`================================================================================`)

    server.listen(PORT, () => {
      console.log(`🚀 MabarBang Server: Online (Port ${PORT})`)
      console.log(`📱 Streamer Dashboard : http://localhost:${PORT}/dashboard`)
      console.log(`📺 OBS Studio Overlay : http://localhost:${PORT}/overlay`)
      console.log(`================================================================================`)

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
  })()

  // Keep console process alive on Windows/macOS
  process.stdin.resume()
}
