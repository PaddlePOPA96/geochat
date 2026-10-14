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

  it('should resolve Indonesian country names instantly via offline dictionary', async () => {
    const rusia = await resolveLocation('rusia')
    expect(rusia).toEqual({ lat: 55.7558, lng: 37.6173 })

    const inggris = await resolveLocation('inggris')
    expect(inggris).toEqual({ lat: 51.5074, lng: -0.1278 })

    const korsel = await resolveLocation('korsel')
    expect(korsel).toEqual({ lat: 37.5665, lng: 126.9780 })

    const prancis = await resolveLocation('prancis')
    expect(prancis).toEqual({ lat: 48.8566, lng: 2.3522 })

    const belanda = await resolveLocation('belanda')
    expect(belanda).toEqual({ lat: 52.3676, lng: 4.9041 })

    const jepang = await resolveLocation('jepang')
    expect(jepang).toEqual({ lat: 35.6762, lng: 139.6503 })

    const as = await resolveLocation('as')
    expect(as).toEqual({ lat: 38.8951, lng: -77.0364 })
  })

  it('should resolve English/international country names instantly', async () => {
    const russia = await resolveLocation('russia')
    expect(russia).toEqual({ lat: 55.7558, lng: 37.6173 })

    const england = await resolveLocation('england')
    expect(england).toEqual({ lat: 51.5074, lng: -0.1278 })

    const uk = await resolveLocation('uk')
    expect(uk).toEqual({ lat: 51.5074, lng: -0.1278 })

    const southKorea = await resolveLocation('south korea')
    expect(southKorea).toEqual({ lat: 37.5665, lng: 126.9780 })

    const france = await resolveLocation('france')
    expect(france).toEqual({ lat: 48.8566, lng: 2.3522 })

    const usa = await resolveLocation('usa')
    expect(usa).toEqual({ lat: 38.8951, lng: -77.0364 })
  })
})
