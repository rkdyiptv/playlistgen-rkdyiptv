// ============================================================
//  RKDYIPTV — Public Ad Progress Tracker
//  File: functions/api/public/ad-progress.js
//  GET  -> start new ad-watch session (blocked during cooldown)
//  POST -> increment watched-ad count (server verified)
// ============================================================

const REQUIRED_ADS = 5;
const SESSION_TTL = 480; // 8 min window to finish watching ads

// 3 ad sets × 5 zones. The set is selected from the user's successful
// generation count, so repeated generations use different zone IDs.
const AD_ZONE_SETS = [
  ['11341413', '11771716', '11771705', '11771730', '11771737'],
  ['11880810', '11880813', '11880817', '11880825', '11880830'],
  ['11880834', '11880839', '11880842', '11880847', '11880854'],
];

function generateSessionId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequest(context) {
  const { request, env } = context;
  const commonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (!env.TOKENS) {
    return new Response(JSON.stringify({ success: false, error: 'KV binding TOKENS missing' }), {
      status: 500, headers: commonHeaders,
    });
  }

  // ── Start new session ──
  if (request.method === 'GET') {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';

    // Respect the 15-minute cooldown after a successful generation
    const cooldownRaw = await env.TOKENS.get(`cooldown:${ip}`);
    if (cooldownRaw) {
      const cooldownExpiresAt = parseInt(cooldownRaw, 10);
      const remainingMs = cooldownExpiresAt - Date.now();
      if (remainingMs > 0) {
        return new Response(JSON.stringify({
          success: false,
          cooldown: true,
          remainingMs,
          error: 'Please wait before starting a new playlist request.',
        }), { status: 429, headers: commonHeaders });
      }
    }

    // The public-token rate-limit counter represents successful generations.
    // 0 => set 1, 1 => set 2, 2 => set 3, 3 => set 1, etc.
    const generationRaw = await env.TOKENS.get(`ratelimit:public-token:${ip}`);
    const generationCount = generationRaw ? parseInt(generationRaw, 10) || 0 : 0;
    const adSetIndex = generationCount % AD_ZONE_SETS.length;
    const adZones = AD_ZONE_SETS[adSetIndex];

    const sessionId = generateSessionId();
    const sessionData = {
      count: 0,
      createdAt: Date.now(),
      ip,
      generationCount,
      adSetIndex,
      adZones,
    };
    await env.TOKENS.put(`adsession:${sessionId}`, JSON.stringify(sessionData), {
      expirationTtl: SESSION_TTL,
    });
    return new Response(JSON.stringify({
      success: true,
      sessionId,
      required: REQUIRED_ADS,
      adSetIndex,
      adZones,
    }), {
      status: 200, headers: commonHeaders,
    });
  }

  // ── Mark one ad as watched ──
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const sessionId = body.sessionId;
      if (!sessionId || typeof sessionId !== 'string') {
        return new Response(JSON.stringify({ success: false, error: 'Invalid session' }), {
          status: 400, headers: commonHeaders,
        });
      }

      const raw = await env.TOKENS.get(`adsession:${sessionId}`);
      if (!raw) {
        return new Response(JSON.stringify({ success: false, error: 'Session expired, please reload the page' }), {
          status: 400, headers: commonHeaders,
        });
      }

      const sessionData = JSON.parse(raw);
      sessionData.count = Math.min((sessionData.count || 0) + 1, REQUIRED_ADS);

      await env.TOKENS.put(`adsession:${sessionId}`, JSON.stringify(sessionData), {
        expirationTtl: SESSION_TTL,
      });

      return new Response(JSON.stringify({ success: true, count: sessionData.count, required: REQUIRED_ADS }), {
        status: 200, headers: commonHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 500, headers: commonHeaders,
      });
    }
  }

  return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
    status: 405, headers: commonHeaders,
  });
}
