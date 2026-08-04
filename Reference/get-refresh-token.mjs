// Instructions: (DO THIS ONCE TO SET UP THIS FEATURE)
//   1. Change CLIENT_ID below to match your Spotify Client ID
//   2. Add your desired scopes to SCOPE as a space-separated list
//   3. In your Spotify app dashboard, add this exact redirect URI:
//        http://127.0.0.1:8888/callback
//   4. Run:  node get-refresh-token.mjs
//   5. Your browser opens automatically. Log in and click "Agree".
//   6. The script prints your refresh_token and an authorized_at timestamp.
//      Save both — you'll store them in Cloudflare KV in the next step.

import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";

const CLIENT_ID = "c72b2fba6066479aae8dbf7d34dde38a";
const REDIRECT_URI = "http://127.0.0.1:8888/callback";
const SCOPE = "playlist-modify-private playlist-modify-public playlist-read-private \
  user-modify-playback-state user-read-currently-playing user-read-playback-state user-top-read";

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {
    // If this fails (headless machine, etc.), the URL is printed below anyway.
  });
}

const codeVerifier = base64url(crypto.randomBytes(64));
const codeChallenge = base64url(
  crypto.createHash("sha256").update(codeVerifier).digest()
);
const state = base64url(crypto.randomBytes(16));

const authUrl = new URL("https://accounts.spotify.com/authorize");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("scope", SCOPE);
authUrl.searchParams.set("code_challenge_method", "S256");
authUrl.searchParams.set("code_challenge", codeChallenge);
authUrl.searchParams.set("state", state);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
    console.error("Authorization failed:", error);
    server.close();
    process.exit(1);
  }

  if (returnedState !== state) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>State mismatch — aborting</h1>");
    console.error("State mismatch. Aborting for safety.");
    server.close();
    process.exit(1);
  }

  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
      }),
    });

    const data = await tokenRes.json();

    if (!tokenRes.ok) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`<h1>Token exchange failed</h1><pre>${JSON.stringify(data, null, 2)}</pre>`);
      console.error("Token exchange failed:", data);
      server.close();
      process.exit(1);
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Done</h1><p>You can close this tab and go back to your terminal.</p>");

    console.log("\nSuccess. Save these two values — you'll store them in Cloudflare KV:\n");
    console.log("refresh_token:", data.refresh_token);
    console.log("authorized_at:", new Date().toISOString());
    console.log(
      "\n(access_token from this response is only valid 1 hour — the worker will fetch its own, ignore it.)\n"
    );
  } catch (err) {
    console.error("Unexpected error during token exchange:", err);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 250);
  }
});

server.listen(8888, () => {
  console.log("Opening your browser to authorize with Spotify...");
  console.log("If it doesn't open automatically, visit this URL:\n");
  console.log(authUrl.toString());
  console.log("");
  openBrowser(authUrl.toString());
});
