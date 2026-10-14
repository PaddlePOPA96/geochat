import { describe, it, expect, beforeEach } from 'vitest'
import { parseCoordinates, resolveLocation, clearGeocodeCache } from './geocoding'

describe('geocoding helper', () => {
  beforeEach(() => {
    clearGeocodeCache()
  })

  it('should parse raw coordinates correctly', async () => {
    const res = await resolveLocation('-6.2088, 106.8456')
    expect(res).toEqual({ lat: -6.2088, lng: 106.8456 })
  })

  it('should parse raw coordinates with positive signs and spaces', async () => {
    const res = parseCoordinates('  48.8566,   2.3522 ')
    expect(res).toEqual({ lat: 48.8566, lng: 2.3522 })
  })

  it('should return null for empty or invalid query', async () => {
    const res = await resolveLocation('    ')
    expect(res).toBeNull()
  })

  it('should resolve a real world city (Jakarta) via geocoding', async () => {
    const res = await resolveLocation('Jakarta')
    expect(res).not.toBeNull()
    if (res) {
      expect(res.lat).toBeCloseTo(-6.175, 0)
      expect(res.lng).toBeCloseTo(106.82, 0)
    }
  }, 10000)

  it('should resolve a country (Japan) via geocoding', async () => {
    const res = await resolveLocation('Japan')
    expect(res).not.toBeNull()
    if (res) {
      expect(res.lat).toBeGreaterThan(30)
      expect(res.lng).toBeGreaterThan(130)
    }
  }, 10000)
})
