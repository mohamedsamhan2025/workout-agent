import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV you must set on Render:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - POLAR_CLIENT_ID
 * - POLAR_CLIENT_SECRET
 * - POLAR_REDIRECT_URI   (EXACT match with Polar admin redirect URL)
 */

const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "POLAR_CLIENT_ID",
  "POLAR_CLIENT_SECRET",
  "POLAR_REDIRECT_URI",
];

for (const k of requiredEnv) {
  if (!process.env[k]) console.warn(`⚠️ Missing env var: ${k}`);
}

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

// ============== BASIC ROUTES ==============

app.get("/", (req, res) => res.status(200).send("Workout Agent is running ✅"));

// Safe env check (does NOT leak secrets)
app.get("/debug/env", (req, res) => {
  res.json({
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    POLAR_CLIENT_ID: !!process.env.POLAR_CLIENT_ID,
    POLAR_CLIENT_SECRET: !!process.env.POLAR_CLIENT_SECRET,
    POLAR_REDIRECT_URI: process.env.POLAR_REDIRECT_URI || null,
  });
});

// FREE browser test: inserts one row into Supabase
app.get("/debug/insert-test", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("polar_sessions")
      .insert([
        {
          session_start: new Date().toISOString(),
          avg_hr: 145,
          max_hr: 182,
          cardio_load: 120,
        },
      ])
      .select()
      .single();

    if (error) return res.status(500).json(error);
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// ============== POLAR OAUTH "DOOR" ==============
// Polar authorization endpoint is:
// GET https://flow.polar.com/oauth2/authorization :contentReference[oaicite:3]{index=3}
// Use response_type=code, client_id, and (optionally) redirect_uri & scope & state. :contentReference[oaicite:4]{index=4}

app.get("/auth/polar", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");

  // Optional but recommended: store state temporarily (cookie/db).
  // For simple testing, we’ll just pass it through.
  const redirectUri = process.env.POLAR_REDIRECT_URI;

  const url = new URL("https://flow.polar.com/oauth2/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.POLAR_CLIENT_ID);
  // If you send redirect_uri here, it MUST match Polar admin exactly. :contentReference[oaicite:5]{index=5}
  url.searchParams.set("redirect_uri", redirectUri);
  // If not provided, Polar will request all scopes linked to your client. :contentReference[oaicite:6]{index=6}
  url.searchParams.set("scope", "accesslink.read_all");
  url.searchParams.set("state", state);

  return res.redirect(url.toString());
});

// Polar redirects back to your redirect_uri with:
// - code=... (success) or
// - error=... (failure) :contentReference[oaicite:7]{index=7}
app.get("/auth/polar/callback", async (req, res) => {
  try {
    const { code, error, state } = req.query;

    if (error) {
      return res
        .status(400)
        .send(`Polar returned error: ${error} (state=${state ?? "none"})`);
    }

    if (!code) return res.status(400).send("Missing authorization code");

    // Token endpoint:
    // POST https://polarremote.com/v2/oauth2/token :contentReference[oaicite:8]{index=8}
    // Content-Type x-www-form-urlencoded, Authorization Basic base64(client_id:client_secret) :contentReference[oaicite:9]{index=9}
    // redirect_uri must be specified if it was passed earlier :contentReference[oaicite:10]{index=10}
    const basicAuth = Buffer.from(
      `${process.env.POLAR_CLIENT_ID}:${process.env.POLAR_CLIENT_SECRET}`
    ).toString("base64");

    const tokenRes = await fetch("https://polarremote.com/v2/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json;charset=UTF-8",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: process.env.POLAR_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      return res.status(400).json({
        message: "Token exchange failed",
        status: tokenRes.status,
        tokenData,
      });
    }

    // tokenData includes access_token + x_user_id, etc. :contentReference[oaicite:11]{index=11}

    // Store token
    await supabase.from("polar_tokens").insert([
      {
        access_token: tokenData.access_token,
        token_type: tokenData.token_type,
        expires_in: tokenData.expires_in,
        x_user_id: tokenData.x_user_id,
        raw: tokenData,
      },
    ]);

    // Register user (required before accessing user data) :contentReference[oaicite:12]{index=12}
    // POST /v3/users with Authorization Bearer <access_token> :contentReference[oaicite:13]{index=13}
    const memberId = `mo-${tokenData.x_user_id}`; // must be unique per user

    const registerRes = await fetch("https://www.polaraccesslink.com/v3/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ "member-id": memberId }),
    });

    // 409 means already registered (not fatal) :contentReference[oaicite:14]{index=14}
    if (!registerRes.ok && registerRes.status !== 409) {
      const text = await registerRes.text();
      return res.status(400).send(`User register failed: ${registerRes.status} ${text}`);
    }

    return res.send("✅ Polar connected successfully. You can close this page.");
  } catch (e) {
    return res.status(500).send(`Server error: ${e.message}`);
  }
});

// ============== WEBHOOK "MAILBOX" PLACEHOLDER ==============
// Webhook: AccessLink will POST to your URL and expects HTTP 200. :contentReference[oaicite:15]{index=15}
app.post("/webhooks/polar", async (req, res) => {
  // For now, just store whatever Polar sends
  const raw = req.body ?? {};
  const { error } = await supabase.from("polar_sessions").insert([
    { session_start: new Date().toISOString(), raw },
  ]);
  if (error) return res.status(500).json({ ok: false, error });
  return res.status(200).json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
