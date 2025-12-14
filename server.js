// server.js (ESM)

import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV VARS YOU MUST SET IN RENDER
 * --------------------------------
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 *
 * POLAR_CLIENT_ID
 * POLAR_CLIENT_SECRET
 * POLAR_REDIRECT_URI   (EXACTLY: https://workout-agent.onrender.com/auth/polar/callback)
 */

// ====== Supabase ======
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL || "", SUPABASE_SERVICE_ROLE_KEY || "");

// ====== Polar OAuth ======
const POLAR_CLIENT_ID = process.env.POLAR_CLIENT_ID;
const POLAR_CLIENT_SECRET = process.env.POLAR_CLIENT_SECRET;
const POLAR_REDIRECT_URI = process.env.POLAR_REDIRECT_URI;

// helper
function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

// ====== Health check ======
app.get("/", (req, res) => {
  res.status(200).send("Workout Agent is running ✅");
});

// ====== Debug: GET insert test (easy browser test) ======
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

    if (error) return res.status(500).json({ ok: false, error });
    return res.json({ ok: true, inserted: data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// ====== Debug: POST insert (lets you send JSON) ======
app.post("/debug/insert", async (req, res) => {
  try {
    const payload = req.body ?? {};
    const { data, error } = await supabase
      .from("polar_sessions")
      .insert([
        {
          session_start: new Date().toISOString(),
          duration_sec: payload.duration_sec ?? 3600,
          avg_hr: payload.avg_hr ?? 140,
          max_hr: payload.max_hr ?? 175,
          calories: payload.calories ?? null,
          cardio_load: payload.cardio_load ?? null,
          raw: payload,
        },
      ])
      .select()
      .single();

    if (error) return res.status(500).json({ ok: false, error });
    return res.json({ ok: true, inserted: data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Unknown error" });
  }
});

// ======================================================
// POLAR OAUTH FLOW
// ======================================================

// STEP 1: Redirect user to Polar login
app.get("/auth/polar", (req, res) => {
  try {
    requireEnv("POLAR_CLIENT_ID", POLAR_CLIENT_ID);
    requireEnv("POLAR_REDIRECT_URI", POLAR_REDIRECT_URI);

    const authUrl =
      "https://flow.polar.com/oauth2/authorization" +
      "?response_type=code" +
      `&client_id=${encodeURIComponent(POLAR_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(POLAR_REDIRECT_URI)}`;

    return res.redirect(authUrl);
  } catch (e) {
    return res.status(500).send(`❌ /auth/polar error: ${e.message}`);
  }
});

// STEP 2: Polar redirects BACK with ?code=...
app.get("/auth/polar/callback", async (req, res) => {
  try {
    requireEnv("POLAR_CLIENT_ID", POLAR_CLIENT_ID);
    requireEnv("POLAR_CLIENT_SECRET", POLAR_CLIENT_SECRET);
    requireEnv("POLAR_REDIRECT_URI", POLAR_REDIRECT_URI);

    const code = req.query.code;
    const err = req.query.error;

    if (err) {
      return res.status(400).send(`❌ Polar returned error: ${err}`);
    }
    if (!code) {
      return res.status(400).send("❌ Missing authorization code (?code=...)");
    }

    // Exchange code -> token
    const tokenRes = await fetch("https://polarremote.com/v2/oauth2/token", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: POLAR_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error("❌ Polar token error:", tokenData);
      return res.status(500).json({
        ok: false,
        message: "Polar token exchange failed",
        tokenData,
      });
    }

    // Store token securely in Supabase (table: polar_tokens)
    // Create this table if you haven't:
    // - id bigint generated always as identity primary key
    // - created_at timestamptz default now()
    // - access_token text
    // - refresh_token text
    // - expires_in int
    // - token_type text
    const { error: dbErr } = await supabase.from("polar_tokens").insert([
      {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        token_type: tokenData.token_type ?? null,
      },
    ]);

    if (dbErr) {
      console.error("❌ Supabase token insert error:", dbErr);
      return res.status(500).json({ ok: false, message: "Failed to store token", dbErr });
    }

    return res.send("✅ Polar connected successfully. You can close this tab.");
  } catch (e) {
    console.error("❌ /auth/polar/callback error:", e);
    return res.status(500).send(`❌ Callback error: ${e.message}`);
  }
});

// ======================================================
// PLACEHOLDER WEBHOOK ENDPOINTS (FOR LATER)
// ======================================================
app.post("/webhooks/polar", async (req, res) => {
  try {
    const raw = req.body ?? {};
    const { error } = await supabase.from("polar_sessions").insert([
      { session_start: new Date().toISOString(), raw },
    ]);

    if (error) return res.status(500).json({ ok: false, error });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

app.post("/webhooks/pushpress", async (req, res) => {
  try {
    const raw = req.body ?? {};
    const { error } = await supabase.from("pushpress_attendance").insert([
      {
        class_start: new Date().toISOString(),
        class_name: raw?.class_name ?? null,
        location: raw?.location ?? null,
        raw,
      },
    ]);

    if (error) return res.status(500).json({ ok: false, error });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// ====== Start server ======
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server listening on port ${port}`));
