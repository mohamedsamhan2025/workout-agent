// server.js
import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------------------------
// Supabase
// ---------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL || "", SUPABASE_SERVICE_ROLE_KEY || "");

// ---------------------------
// Health check
// ---------------------------
app.get("/", (req, res) => {
  res.status(200).send("Workout Agent is running ✅");
});

// ---------------------------
// Debug: insert a sample row (GET)
// ---------------------------
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
    return res.json({ ok: true, inserted: data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Unknown error" });
  }
});

// ---------------------------
// Debug: insert a row (POST body)
// ---------------------------
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
    return res.json({ ok: true, inserted: data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Unknown error" });
  }
});

// ---------------------------
// Placeholder "mailbox" endpoints
// (Polar doesn't truly push webhooks by default — this is just a receiver)
// ---------------------------
app.post("/webhooks/polar", async (req, res) => {
  try {
    const raw = req.body ?? {};
    const { error } = await supabase.from("polar_sessions").insert([
      { session_start: new Date().toISOString(), raw },
    ]);
    if (error) return res.status(500).json({ ok: false, error });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Unknown error" });
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
    return res.status(500).json({ ok: false, message: e?.message ?? "Unknown error" });
  }
});

// ---------------------------
// Polar OAuth: "Door" -> redirect user to Polar login
// ---------------------------
app.get("/auth/polar", (req, res) => {
  const clientId = process.env.POLAR_CLIENT_ID;
  const redirectUri = process.env.POLAR_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).send("❌ Missing POLAR_CLIENT_ID or POLAR_REDIRECT_URI in environment variables");
  }

  // ✅ Correct Polar OAuth authorize endpoint
  const url =
    "https://polarremote.com/v2/oauth2/authorization" +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  return res.redirect(url);
});

// ---------------------------
// Polar OAuth callback: exchange code for token + store in Supabase
// ---------------------------
app.get("/auth/polar/callback", async (req, res) => {
  try {
    const code = req.query.code;

    if (!code) {
      return res.status(400).send("❌ Missing authorization code");
    }

    const clientId = process.env.POLAR_CLIENT_ID;
    const clientSecret = process.env.POLAR_CLIENT_SECRET;
    const redirectUri = process.env.POLAR_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).send("❌ Missing POLAR_CLIENT_ID / POLAR_CLIENT_SECRET / POLAR_REDIRECT_URI env vars");
    }

    // Exchange code for access token
    const tokenRes = await fetch("https://polarremote.com/v2/oauth2/token", {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      return res.status(400).json({
        ok: false,
        message: "Token exchange failed",
        tokenData,
      });
    }

    // Store token securely
    // Recommended columns: access_token, refresh_token, expires_in, token_type, created_at
    const { error } = await supabase.from("polar_tokens").insert([
      {
        access_token: tokenData.access_token ?? null,
        refresh_token: tokenData.refresh_token ?? null,
        expires_in: tokenData.expires_in ?? null,
        token_type: tokenData.token_type ?? null,
      },
    ]);

    if (error) {
      return res.status(500).json({ ok: false, message: "Failed to save token", error });
    }

    return res.send("✅ Polar connected successfully. You can close this page.");
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Unknown error" });
  }
});

// ---------------------------
// Start server
// ---------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
