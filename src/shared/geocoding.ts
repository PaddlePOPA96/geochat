import axios from 'axios'

export interface LatLng {
  lat: number
  lng: number
}

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
 * Resolves coordinates from either raw coordinates OR city/country text query.
 * Example queries:
 * - "-6.2088, 106.8456"
 * - "Jakarta"
 * - "Tokyo, Japan"
 * - "Indonesia"
 * - "Paris, France"
 */
export async function resolveLocation(query: string): Promise<LatLng | null> {
  const trimmed = query.trim()
  if (!trimmed) return null

  // 1. Check if raw coordinates
  const coords = parseCoordinates(trimmed)
  if (coords) return coords

  // 2. Check in-memory cache
  const cacheKey = trimmed.toLowerCase()
  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey)!
  }

  // 3. Forward geocode using OpenStreetMap Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(trimmed)}&format=json&limit=1`
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'ChatGuessr-YouTube-Bot/1.0 (https://chatguessr.com)'
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
