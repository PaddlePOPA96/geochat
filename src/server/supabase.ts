import { LeaderboardEntry } from './index'

const getSupabaseUrl = () => process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
const getSupabaseKey = () =>
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  ''


export async function verifySupabaseUser(token: string) {
  if (!token) return null
  const supabaseUrl = getSupabaseUrl()
  const supabaseKey = getSupabaseKey()
  if (!supabaseUrl || !supabaseKey) {
    console.warn('[Supabase] Missing SUPABASE_URL or SUPABASE_KEY in environment')
    return null
  }

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${token}`
      }
    })
    if (!res.ok) return null
    return await res.json()
  } catch (err) {
    console.error('[Supabase] Auth verify error:', err)
    return null
  }
}

/**
 * Helper to interact with Supabase REST API without external client bloat
 */
export async function saveSessionLeaderboard(
  sessionCode: string,
  mapName: string,
  leaderboard: LeaderboardEntry[],
  totalRounds: number = 5,
  streamerId?: string
) {
  if (!sessionCode || !leaderboard || leaderboard.length === 0) return
  const supabaseUrl = getSupabaseUrl()
  const supabaseKey = getSupabaseKey()
  if (!supabaseUrl || !supabaseKey) return

  try {
    // 1. Upsert Game Session (with streamer_id if provided)
    const sessionPayload: Record<string, any> = {
      session_code: sessionCode,
      map_name: mapName,
      total_rounds: totalRounds
    }
    if (streamerId && streamerId !== 'default') {
      sessionPayload.streamer_id = streamerId
    }

    let sessionRes = await fetch(`${supabaseUrl}/rest/v1/game_sessions`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(sessionPayload)
    })

    // If column streamer_id does not exist yet in Supabase, retry without streamer_id gracefully
    if (!sessionRes.ok && sessionPayload.streamer_id) {
      delete sessionPayload.streamer_id
      sessionRes = await fetch(`${supabaseUrl}/rest/v1/game_sessions`, {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(sessionPayload)
      })
    }

    let sessionId: string | null = null
    if (sessionRes.ok) {
      const sessionData = (await sessionRes.json()) as any[]
      sessionId = sessionData?.[0]?.id || null
    }

    // 2. Prepare leaderboards rows
    const rows = leaderboard.map((entry, index) => {
      const row: Record<string, any> = {
        session_code: sessionCode,
        session_id: sessionId,
        user_id: entry.userId,
        username: entry.username,
        avatar: entry.avatar || null,
        total_score: entry.totalScore,
        total_distance: entry.totalDistance,
        rounds_count: entry.roundsCount,
        rank: index + 1
      }
      if (streamerId && streamerId !== 'default') {
        row.streamer_id = streamerId
      }
      return row
    })

    // Upsert into leaderboards (conflict on session_code, user_id)
    let lbRes = await fetch(`${supabaseUrl}/rest/v1/leaderboards`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify(rows)
    })

    // If column streamer_id does not exist yet in leaderboards, retry without streamer_id
    if (!lbRes.ok && rows[0]?.streamer_id) {
      const fallbackRows = rows.map((r) => {
        const { streamer_id, ...rest } = r
        return rest
      })
      lbRes = await fetch(`${supabaseUrl}/rest/v1/leaderboards`, {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify(fallbackRows)
      })
    }

    if (!lbRes.ok) {
      const errText = await lbRes.text()
      console.error(`[Supabase] Failed to save leaderboard:`, errText)
    } else {
      console.log(
        `[Supabase] Leaderboard saved successfully for session ${sessionCode} (${rows.length} players)`
      )
    }
  } catch (err) {
    console.error(`[Supabase] Error saving session leaderboard:`, err)
  }
}

export async function getStreamerLeaderboardHistory(streamerId: string) {
  if (!streamerId) return []
  const supabaseUrl = getSupabaseUrl()
  const supabaseKey = getSupabaseKey()
  if (!supabaseUrl || !supabaseKey) return []

  try {
    // 1. Try querying with streamer_id filter first
    let res = await fetch(
      `${supabaseUrl}/rest/v1/leaderboards?streamer_id=eq.${encodeURIComponent(streamerId)}&select=session_code,username,user_id,avatar,total_score,total_distance,rounds_count,rank,created_at&order=total_score.desc&limit=100`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`
        }
      }
    )

    // 2. If streamer_id column is not present or returns error, fallback to session_code pattern
    if (!res.ok) {
      res = await fetch(
        `${supabaseUrl}/rest/v1/leaderboards?session_code=like.session_${encodeURIComponent(streamerId)}_*&select=session_code,username,user_id,avatar,total_score,total_distance,rounds_count,rank,created_at&order=total_score.desc&limit=100`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`
          }
        }
      )
    }

    if (!res.ok) {
      const err = await res.text()
      console.error('[Supabase] Failed to fetch streamer leaderboard:', err)
      return []
    }
    return await res.json()
  } catch (err) {
    console.error('[Supabase] Error getting streamer leaderboard history:', err)
    return []
  }
}

