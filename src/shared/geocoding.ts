import axios from 'axios'
import { COUNTRY_MAP, LatLng } from './countryMap'

export type { LatLng }

/**
 * Checks if input is raw coordinates: "-6.2088, 106.8456"
 */
export function parseCoordinates(coordinates: string): LatLng | null {
  const regex =
    /^(?<lat>[-+]?(?:[1-8]?\d(?:\.\d+)?|90(?:\.0+)?)),\s*(?<lng>[-+]?(?:180(?:\.0+)?|(?:(?:1[0-7]\d)|(?:[1-9]?\d))(?:\.\d+)?))$/
  const m = regex.exec(coordinates.trim())
  if (m?.groups) {
    return { lat: parseFloat(m.groups.lat), lng: parseFloat(m.groups.lng) }
  }
  return null
}

// In-memory cache for fast repeated place queries (capped at 2000 entries to prevent memory leaks)
const geocodeCache = new Map<string, LatLng>()

// Queue & Rate Limiter for external Nominatim OSM calls (1 request per second to prevent 429 IP Bans)
let lastNominatimRequestTime = 0
const NOMINATIM_INTERVAL_MS = 1000

interface QueuedGeocode {
  query: string
  cacheKey: string
  resolve: (val: LatLng | null) => void
}
const nominatimQueue: QueuedGeocode[] = []
let isProcessingQueue = false

async function processNominatimQueue() {
  if (isProcessingQueue) return
  isProcessingQueue = true

  while (nominatimQueue.length > 0) {
    const item = nominatimQueue.shift()
    if (!item) break

    // If item was already populated into cache while waiting in queue
    if (geocodeCache.has(item.cacheKey)) {
      item.resolve(geocodeCache.get(item.cacheKey)!)
      continue
    }

    const elapsed = Date.now() - lastNominatimRequestTime
    if (elapsed < NOMINATIM_INTERVAL_MS) {
      await new Promise((res) => setTimeout(res, NOMINATIM_INTERVAL_MS - elapsed))
    }

    lastNominatimRequestTime = Date.now()
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(item.query)}&format=json&limit=1`
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'MabarBang/3.3.0 (https://geoindo.my.id)',
          'Accept-Language': 'id,en;q=0.9'
        },
        timeout: 4000
      })

      if (Array.isArray(res.data) && res.data.length > 0) {
        const first = res.data[0]
        const result: LatLng = {
          lat: parseFloat(first.lat),
          lng: parseFloat(first.lon)
        }
        if (geocodeCache.size > 2000) {
          const firstKey = geocodeCache.keys().next().value
          if (firstKey) geocodeCache.delete(firstKey)
        }
        geocodeCache.set(item.cacheKey, result)
        item.resolve(result)
      } else {
        item.resolve(null)
      }
    } catch (err: any) {
      console.warn(`[Geocoding] Nominatim lookup failed for "${item.query}":`, err?.message || err)
      item.resolve(null)
    }
  }

  isProcessingQueue = false
}

/**
 * Resolves coordinates from either:
 * 1. Raw coordinates: "-6.2088, 106.8456"
 * 2. Country / City Dictionary (offline instant 0ms lookup):
 *    - "rusia", "russia", "inggris", "england", "korsel", "tokyo", "jakarta", etc.
 * 3. In-memory cache (0ms lookup)
 * 4. Queued & Rate-limited OpenStreetMap Nominatim with 1 req/sec throttle (non-blocking fallback)
 */
export async function resolveLocation(query: string): Promise<LatLng | null> {
  const trimmed = query.trim()
  if (!trimmed) return null

  // 1. Check if raw coordinates
  const coords = parseCoordinates(trimmed)
  if (coords) return coords

  // 2. Normalize for Country / City Dictionary (remove spaces, punctuation)
  const normalizedKey = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (COUNTRY_MAP[normalizedKey]) {
    return COUNTRY_MAP[normalizedKey]
  }

  // 3. Check in-memory cache
  const cacheKey = trimmed.toLowerCase()
  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey)!
  }

  // 4. Rate-limited Queue for external Nominatim Geocoding
  // If queue is overflowing (> 50 items), drop old to protect latency and memory
  if (nominatimQueue.length > 50) {
    const dropped = nominatimQueue.shift()
    if (dropped) dropped.resolve(null)
  }

  return new Promise<LatLng | null>((resolve) => {
    nominatimQueue.push({
      query: trimmed,
      cacheKey,
      resolve
    })
    processNominatimQueue()
  })
}

export function clearGeocodeCache() {
  geocodeCache.clear()
}
