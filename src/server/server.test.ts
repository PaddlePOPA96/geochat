import { describe, it, expect } from 'vitest'
import { parseCoordinates, haversineDistance, calculateScore } from './index'

describe('Server Math Helpers', () => {
  it('should parse valid coordinates', () => {
    const coords = parseCoordinates('-6.2088, 106.8456')
    expect(coords).toEqual({ lat: -6.2088, lng: 106.8456 })
  })

  it('should return null on invalid coordinates', () => {
    const coords = parseCoordinates('hello world')
    expect(coords).toBeNull()
  })

  it('should calculate accurate haversine distance', () => {
    // Jakarta to Bandung (~120-150 km)
    const jkt = { lat: -6.2088, lng: 106.8456 }
    const bdg = { lat: -6.9175, lng: 107.6191 }
    const dist = haversineDistance(jkt, bdg)
    expect(dist).toBeGreaterThan(100)
    expect(dist).toBeLessThan(160)
  })

  it('should calculate 5000 points on exact location', () => {
    const score = calculateScore(0, 2000)
    expect(score).toBe(5000)
  })

  it('should scale down score on large distance', () => {
    const score = calculateScore(5000, 2000)
    expect(score).toBeLessThan(500)
  })
})
