import { LeaderboardEntry } from './index'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://REDACTED_PROJECT.supabase.co'
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'REDACTED_SERVICE_KEY'

/**
 * Helper to interact with Supabase REST API without external client bloat
 */
export async function saveSessionLeaderboard(
  sessionCode: string,
  mapName: string,
  leaderboard: LeaderboardEntry[],
  totalRounds: number = 5
) {
  if (!sessionCode || !leaderboard || leaderboard.length === 0) return

  try {
    // 1. Upsert Game Session
    const sessionRes = await fetch(`${SUPABASE_URL}/rest/v1/game_sessions`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify({
        session_code: sessionCode,
        map_name: mapName,
        total_rounds: totalRounds
      })
    })

    let sessionId: string | null = null
    if (sessionRes.ok) {
      const sessionData = (await sessionRes.json()) as any[]
      sessionId = sessionData?.[0]?.id || null
    }

    // 2. Prepare leaderboards rows
    const rows = leaderboard.map((entry, index) => ({
      session_code: sessionCode,
      session_id: sessionId,
      user_id: entry.userId,
      username: entry.username,
      avatar: entry.avatar || null,
      total_score: entry.totalScore,
      total_distance: entry.totalDistance,
      rounds_count: entry.roundsCount,
      rank: index + 1
    }))

    // Upsert into leaderboards (conflict on session_code, user_id)
    const lbRes = await fetch(`${SUPABASE_URL}/rest/v1/leaderboards`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates'
      },
      body: JSON.stringify(rows)
    })

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
