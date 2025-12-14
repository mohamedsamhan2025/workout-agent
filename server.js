// server.js (ESM) — clean + production-friendly for Render + Supabase + Polar OAuth
// Requires env vars (Render):
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// POLAR_CLIENT_ID
// POLAR_CLIENT_SECRET
// POLAR_REDIRECT_URI   (example: https://workout-agent.onrender.com/auth/polar/callback)

import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// --------------------
// Supabase setup
// --------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL || "", SUPABASE_SERVICE_ROLE_KEY || "");

// --------------------
// Polar OAuth config
// --------------------
const POLAR_CLIENT_ID = process.env.POLAR_CLIENT_ID;
const POLAR_CLIENT_SECRET = process.env.POLAR_CLIENT_SECRET;
const POLAR_REDIRECT_URI = process.env.POLAR_REDIRECT_URI;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

// Node 18+ has global fetch. Render often uses Node 18+.
// If your Render runtime is older, set it to 18+ in Render settings.
const hasFetch = typeof fetch === "function";

// --------------------
// Health check
// --------------------
app.get("/", (req, res) => {
  res.status(200).send("Workout Agent is running ✅");
});

// --------------------
// Debug: quick insert to confirm Supabase works
// --------------------
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
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// Debug: POST insert with custom payload
// --------------------
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
          calories: payload.calories ?? 500,
          cardio_load: payload.cardio_load ?? 100,
          raw: payload,
        },
      ])
      .select()
      .single();

    if (error) return res.status(500).json({ ok: false, error });
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Unknown error" });
  }
});

// --------------------
// (Optional) placeholder endpoints for future webhooks
// NOTE: Polar AccessLink is mostly "pull" + notifications; this is placeholder.
// --------------------
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

// --------------------
// POLAR OAUTH — Step 1: "Door" to Polar login
// GET /auth/polar
// --------------------
app.get("/auth/polar", (req, res) => {
  try {
    requireEnv("POLAR_CLIENT_ID", POLAR_CLIENT_ID);
    requireEnv("POLAR_REDIRECT_URI", POLAR_REDIRECT_URI);

    // Polar Flow authorization endpoint
    // NOTE: Some Polar docs show flow.polar.com for auth and polaraccesslink.com for API calls.
    const url =
      "https://flow.polar.com/oauth2/authorization" +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(POLAR_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(POLAR_REDIRECT_URI)}` +
      `&scope=${encodeURIComponent("accesslink.read_all")}`;

    return res.redirect(url);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

// --------------------
// POLAR OAUTH — Step 2: callback door
// Polar redirects here with ?code=...
// GET /auth/polar/callback
// --------------------
app.get("/auth/polar/callback", async (req, res) => {
  try {
    requireEnv("POLAR_CLIENT_ID", POLAR_CLIENT_ID);
    requireEnv("POLAR_CLIENT_SECRET", POLAR_CLIENT_SECRET);
    requireEnv("POLAR_REDIRECT_URI", POLAR_REDIRECT_URI);

    if (!hasFetch) {
      return res
        .status(500)
        .send("This server runtime has no global fetch. Use Node 18+ on Render.");
    }

    const code = req.query.code;
    if (!code) return res.status(400).send("Missing authorization code");

    // Exchange code for access token (Polar token endpoint)
    // Some docs list:
    // POST https://polarremote.com/v2/oauth2/token
    // Authorization: Basic base64(client_id:client_secret)
    const basic = Buffer.from(`${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`).toString("base64");

    const tokenRes = await fetch("https://polarremote.com/v2/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: POLAR_REDIRECT_URI,
      }),
    });

    const tokenText = await tokenRes.text();
    let tokenData;
    try {
      tokenData = JSON.parse(tokenText);
    } catch {
      tokenData = { raw: tokenText };
    }

    if (!tokenRes.ok) {
      return res.status(400).json({
        ok: false,
        message: "Token exchange failed",
        status: tokenRes.status,
        tokenData,
      });
    }

    // Store tokens in Supabase
    // Make sure you have a table: polar_tokens
    // Recommended columns:
    // id bigserial pk, access_token text, refresh_token text, expires_in int, token_type text, scope text, created_at timestamptz default now()
    const { error } = await supabase.from("polar_tokens").insert([
      {
        access_token: tokenData.access_token ?? null,
        refresh_token: tokenData.refresh_token ?? null,
        expires_in: tokenData.expires_in ?? null,
        token_type: tokenData.token_type ?? null,
        scope: tokenData.scope ?? null,
        raw: tokenData, // optional if you have a jsonb column named raw
      },
    ]);

    if (error) {
      return res.status(500).json({ ok: false, message: "Saved token failed", error });
    }

    return res.send("✅ Polar connected successfully. You can close this page.");
  } catch (e) {
    return res.status(500).send(`Callback error: ${e.message}`);
  }
});

// --------------------
// Polar: fetch last saved token (debug)
// --------------------
app.get("/debug/polar-token", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("polar_tokens")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error) return res.status(500).json({ ok: false, error });
    return res.json({ ok: true, data: { ...data, access_token: "****", refresh_token: "****" } });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// Polar: pull exercises list (simple smoke test)
// GET /polar/fetch-exercises
// --------------------
app.get("/polar/fetch-exercises", async (req, res) => {
  try {
    if (!hasFetch) {
      return res
        .status(500)
        .send("This server runtime has no global fetch. Use Node 18+ on Render.");
    }

    const { data: tokenRow, error: tokenErr } = await supabase
      .from("polar_tokens")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (tokenErr || !tokenRow?.access_token) {
      return res.status(400).json({ ok: false, message: "No Polar token found. Connect Polar first." });
    }

    // Polar AccessLink API host (commonly polaraccesslink.com)
    // v3 exercises endpoint
    const polarRes = await fetch("https://www.polaraccesslink.com/v3/exercises", {
      headers: {
        Authorization: `Bearer ${tokenRow.access_token}`,
      },
    });

    const text = await polarRes.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    if (!polarRes.ok) {
      return res.status(400).json({
        ok: false,
        message: "Polar API call failed",
        status: polarRes.status,
        json,
      });
    }

    return res.json({ ok: true, data: json });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// Start server
// --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
