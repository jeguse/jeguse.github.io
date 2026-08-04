// Cloudflare Worker — Spotify search + queue proxy.
//
// Routes:
//   GET  /api/search?q=...   -> app-only token, public catalog search (low stakes)
//   POST /api/queue          -> your refresh token, writes to YOUR playback queue (sensitive)
//
// Required setup (see README.md):
//   - wrangler.toml vars:    CLIENT_ID, ALLOWED_ORIGIN
//   - wrangler secret:       CLIENT_SECRET        (put CLIENT_SECRET)
//   - KV namespace binding:  SPOTIFY_KV           (holds refresh_token, authorized_at)
//   - KV keys pre-populated: refresh_token, authorized_at   (from get-refresh-token.js)

const TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]{22}$/;
const QUEUE_LIMIT = 5; // max queue additions per IP per window
const QUEUE_WINDOW_SECONDS = 86400; // one day
const PLAYLIST_ID = "2AOY94Z26hRzJFPy43Jwfy"

// Cached in module scope — reused across requests while this isolate stays warm.
let cachedAppToken = null; // { token, expiresAt }
let cachedUserToken = null;

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
  });
}

async function getAppToken(env) {
  const now = Date.now();
  if (cachedAppToken && cachedAppToken.expiresAt > now + 30_000) {
    return cachedAppToken.token;
  }

  const basic = btoa(`${env.CLIENT_ID}:${env.CLIENT_SECRET}`);
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  if (!res.ok) {
    throw new Error(`Client credentials request failed: ${res.status}`);
  }

  const data = await res.json();
  cachedAppToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  return cachedAppToken.token;
}

async function getUserAccessToken(env) {
  const now = Date.now();
  if (cachedUserToken && cachedUserToken.expiresAt > now + 30_000) {
    return cachedUserToken.token;
  }

  const refreshToken = await env.SPOTIFY_KV.get("refresh_token");
  if (!refreshToken) {
    throw new Error("No refresh token stored in KV yet — run get-refresh-token.mjs first.");
  }

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.CLIENT_ID,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    if (data.error === "invalid_grant") {
      // The 6-month refresh token lifetime has expired. Re-run get-refresh-token.js
      // and store the new refresh_token in KV to fix this.
      throw new Error("REAUTH_REQUIRED");
    }
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }

  // Spotify may rotate the refresh token on use — persist the new one if given.
  if (data.refresh_token) {
    await env.SPOTIFY_KV.put("refresh_token", data.refresh_token);
  }

  // Cache the new access token to improve efficiency of multiple calls
  cachedUserToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  return cachedUserToken.token;
}

async function handleSearch(request, env) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  if (!q || q.trim().length === 0) {
    return json({ ok: false, message: "Missing search query." }, 400, env);
  }

  const token = await getAppToken(env);
  const searchUrl = new URL("https://api.spotify.com/v1/search");
  searchUrl.searchParams.set("q", q);
  searchUrl.searchParams.set("type", "track");
  searchUrl.searchParams.set("limit", "7");

  const res = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    return json({ ok: false, message: "Search failed." }, 502, env);
  }

  const data = await res.json();
  const tracks = (data.tracks?.items || []).map((t) => ({
    uri: t.uri,
    name: t.name,
    artist: t.artists.map((a) => a.name).join(", "),
    album: t.album?.name,
    image: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null,
  }));

  return json({ ok: true, tracks }, 200, env);
}

async function checkRateLimit(env, ip) {
  const key = `ratelimit:${ip}`;
  const current = await env.SPOTIFY_KV.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= QUEUE_LIMIT) {
    return false;
  }

  await env.SPOTIFY_KV.put(key, String(count + 1), {
    expirationTtl: QUEUE_WINDOW_SECONDS,
  });
  return true;
}

async function handleQueue(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const allowed = await checkRateLimit(env, ip);
  if (!allowed) {
    return json(
      { ok: false, message: "You have reached your limit for queueing songs today. Come back tomorrow!" },
      429,
      env
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid request body." }, 400, env);
  }

  const uri = body?.uri;
  if (!uri || !TRACK_URI_RE.test(uri)) {
    return json({ ok: false, message: "Invalid track URI." }, 400, env);
  }

  let accessToken;
  try {
    accessToken = await getUserAccessToken(env);
  } catch (err) {
    if (err.message === "REAUTH_REQUIRED") {
      return json(
        { ok: false, message: "Sorry, our token has expired and Jonah needs to re-authorize Spotify access." },
        503,
        env
      );
    }
    return json({ ok: false, message: "Could not refresh Spotify access." }, 502, env);
  }

  const queueUrl = new URL("https://api.spotify.com/v1/me/player/queue");
  queueUrl.searchParams.set("uri", uri);

  const playlistUrl = new URL(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/items`);
  playlistUrl.searchParams.set("uris", uri);

  let output = "";

  const res = await fetch(queueUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    return json({ ok: false, message: "Sorry, our token has expired and Jonah must re-authorize Spotify access."}, 503, env);
  }

  if (res.status === 403) {
    return json({ ok: false, message: "Jonah granted the wrong Spotify access for this lol."}, 502, env);
  }

  if (res.status === 429) {
    return json({ ok: false, message: "Too many people (or, sigh, bots) are abusing this feature. We have been rate-limited."}, 503, env);
  }

  if (res.status === 404) {
    output += "Cannot be added to queue because Jonah is not currently active on Spotify.";
  } else if (res.status === 204) {
    output += "Track added to queue.";
  } else {
    output += "Track successfully added to queue.";
  }

  const res2 = await fetch(playlistUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res2.status === 201) {
    output += " Track successfully added to recommendations playlist.";
    return json({ ok: true, message: output }, 200, env);
  }

  if (res2.status === 401) {
    return json({ ok: false, message: output + " Sorry, our token has expired and Jonah must re-authorize Spotify access."}, 503, env);
  }

  if (res2.status === 403) {
    return json({ ok: false, message: output + " Adding to this playlist is currently out-of-scope."}, 502, env);
  }

  if (res2.status === 404) {
    return json({ ok: false, message: output + " Unknown 404 error occurred while adding track to playlist."}, 502, env);
  }

  if (res2.status === 429) {
    return json({ ok: false, message: output + " Too many people (or, sigh, bots) are abusing this feature. We have been rate-limited."}, 503, env);
  }

  output += " An error occurred while adding track to recommendations playlist.";
  return json({ ok: false, message: output }, 502, env);
}

async function handleTopArtists(request, env) {
  let accessToken;
  try {
    accessToken = await getUserAccessToken(env);
  } catch (err) {
    if (err.message === "REAUTH_REQUIRED") {
      return json(
        { ok: false, message: "Sorry, our token has expired and Jonah needs to re-authorize Spotify access." },
        503,
        env
      );
    }
    return json({ ok: false, message: "Could not refresh Spotify access." }, 502, env);
  }

  const artistUrl = new URL("https://api.spotify.com/v1/me/top/artists");
  artistUrl.searchParams.set("limit", "6");
  
  const res = await fetch(artistUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    return json({ ok: false, message: "Failed to access Jonah's top artists." }, 502, env);
  }

  const data = await res.json();
  const artists = (data.items || []).map((a) => ({
    uri: a.uri,
    name: a.name,
    image: a.images?.[2]?.url || a.images?.[0]?.url || null,
  }));

  return json({ ok: true, artists }, 200, env);
}

async function handleTopTracks(request, env) {
  let accessToken;
  try {
    accessToken = await getUserAccessToken(env);
  } catch (err) {
    if (err.message === "REAUTH_REQUIRED") {
      return json(
        { ok: false, message: "Sorry, our token has expired and Jonah needs to re-authorize Spotify access." },
        503,
        env
      );
    }
    return json({ ok: false, message: "Could not refresh Spotify access." }, 502, env);
  }

  const trackUrl = new URL("https://api.spotify.com/v1/me/top/tracks");
  trackUrl.searchParams.set("time_range", "short_term");
  trackUrl.searchParams.set("limit", "6");
  
  const res = await fetch(trackUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    return json({ ok: false, message: "Failed to access Jonah's top tracks." }, 502, env);
  }

  const data = await res.json();
  const tracks = (data.items || []).map((t) => ({
    uri: t.uri,
    name: t.name,
    artist: t.artists.map((a) => a.name).join(", "),
    album: t.album?.name,
    image: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null
  }));

  return json({ ok: true, tracks }, 200, env);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/search" && request.method === "GET") {
        return await handleSearch(request, env);
      }
      if (url.pathname === "/api/queue" && request.method === "POST") {
        return await handleQueue(request, env);
      }
      if (url.pathname === "/api/artists" && request.method === "GET") {
        return await handleTopArtists(request, env);
      }
      if (url.pathname === "/api/tracks" && request.method === "GET") {
        return await handleTopTracks(request, env);
      }
    } catch (err) {
      return json({ ok: false, message: "Unexpected server error." }, 500, env);
    }

    return json({ ok: false, message: "Not found." }, 404, env);
  },
};
