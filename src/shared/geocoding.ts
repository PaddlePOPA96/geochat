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

// In-memory cache for fast repeated place queries
const geocodeCache = new Map<string, LatLng>()

/**
 * Resolves coordinates from either:
 * 1. Raw coordinates: "-6.2088, 106.8456"
 * 2. Country name in Indonesian or English (offline instant dictionary):
 *    - "rusia", "russia", "inggris", "england", "korsel", "south korea", "as", "usa", "prancis", "france", etc.
 * 3. City or regional query via OpenStreetMap Nominatim (with Indonesian & English language support).
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

  // 4. Forward geocode using OpenStreetMap Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(trimmed)}&format=json&limit=1`
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'ChatGuessr-YouTube-Bot/1.0 (https://chatguessr.com)',
        'Accept-Language': 'id,en;q=0.9'
      },
      timeout: 5000
    })

    if (Array.isArray(res.data) && res.data.length > 0) {
      const first = res.data[0]
      const result: LatLng = {
        lat: parseFloat(first.lat),
        lng: parseFloat(first.lon)
      }
      geocodeCache.set(cacheKey, result)
      return result
    }
  } catch (err: any) {
    console.warn(`[Geocoding] Could not geocode "${trimmed}":`, err?.message || err)
  }

  return null
}

export function clearGeocodeCache() {
  geocodeCache.clear()
}
