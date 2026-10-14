import { describe, it, expect } from 'vitest'
import { parseYouTubeInput } from './useYouTubeChat'

describe('parseYouTubeInput', () => {
  it('should parse standard YouTube watch URL', () => {
    const input = 'https://www.youtube.com/watch?v=jfKfPfyJRdk'
    const result = parseYouTubeInput(input)
    expect(result).toEqual({ liveId: 'jfKfPfyJRdk' })
  })

  it('should parse short youtu.be URL', () => {
    const input = 'https://youtu.be/jfKfPfyJRdk'
    const result = parseYouTubeInput(input)
    expect(result).toEqual({ liveId: 'jfKfPfyJRdk' })
  })

  it('should parse youtube.com/live/ URL', () => {
    const input = 'https://www.youtube.com/live/jfKfPfyJRdk'
    const result = parseYouTubeInput(input)
    expect(result).toEqual({ liveId: 'jfKfPfyJRdk' })
  })

  it('should parse raw 11-char video ID', () => {
    const input = 'jfKfPfyJRdk'
    const result = parseYouTubeInput(input)
    expect(result).toEqual({ liveId: 'jfKfPfyJRdk' })
  })

  it('should parse channel URL with UC channel ID', () => {
    const input = 'https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw'
    const result = parseYouTubeInput(input)
    expect(result).toEqual({ channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' })
  })

  it('should parse raw UC channel ID', () => {
    const input = 'UC_x5XG1OV2P6uZZ5FSM9Ttw'
    const result = parseYouTubeInput(input)
    expect(result).toEqual({ channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' })
  })

  it('should parse channel handle with @', () => {
    const input = 'https://www.youtube.com/@geoguessr/live'
    const result = parseYouTubeInput(input)
    expect(result).toEqual({ handle: '@geoguessr' })
  })

  it('should parse raw @handle', () => {
    const input = '@dutahad'
    const result = parseYouTubeInput(input)
    expect(result).toEqual({ handle: '@dutahad' })
  })

  it('should return empty object on empty string', () => {
    const input = '   '
    const result = parseYouTubeInput(input)
    expect(result).toEqual({})
  })
})
