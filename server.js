import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// --------------------
// ENV (Supabase)
// --------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL || "", SUPABASE_SERVICE_ROLE_KEY || "");

// --------------------
// ENV (Polar)
// --------------------
const POLAR_CLIENT_ID = process.env.POLAR_CLIENT_ID;
const POLAR_CLIENT_SECRET = process.env.POLAR_CLIENT_SECRET;
const POLAR_REDIRECT_URI = process.env.POLAR_REDIRECT_URI;

function mustHaveEnv() {
  const missing = [];
  if (!POLAR_CLIENT_ID) missing.push("POLAR_CLIENT_ID");
  if (!POLAR_CLIENT_SECRET) missing.push("POLAR_CLIENT_SECRET");
  if (!POLAR_REDIRECT_URI) missing.push("POLAR_REDIRECT_URI");
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

// --------------------
// Helpers
// --------------------
function basicAuthHeader(clientId, clientSecret) {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function randomState() {
  return crypto.randomBytes(16).toString("hex");
}

async function getLatestPolarToken() {
  const { data, error } = await supabase
    .from("polar_tokens")
    .select("access_token, refresh_token, expires_in, token_type, x_user_id, scope, raw, created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data; // can be null
}

function authHeaderFromToken(tokenRow) {
  const tokenType = (tokenRow?.token_type || "bearer").toLowerCase();
  if (!tokenRow?.access_token) return null;
  if (tokenType === "bearer") return `Bearer ${tokenRow.access_token}`;
  return `${tokenRow.token_type} ${tokenRow.access_token}`;
}

// --------------------
// Health
// --------------------
app.get("/", (req, res) => {
  res.status(200).send("Workout Agent is running ✅");
});

// --------------------
// Debug: insert one row into polar_sessions (GET)
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
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// Debug: insert into polar_sessions (POST)
// --------------------
app.post("/debug/insert", async (req, res) => {
  try {
    const payload = req.body ?? {};
    const { data, error } = await supabase
      .from("polar_sessions")
      .insert([
        {
          session_start: new Date().toISOString(),
          duration_sec: payload.duration_sec ?? null,
          avg_hr: payload.avg_hr ?? 140,
          max_hr: payload.max_hr ?? 175,
          calories: payload.calories ?? null,
          cardio_load: payload.cardio_load ?? 100,
          raw: payload ?? null,
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
// STEP 1: Door to Polar login
// --------------------
app.get("/auth/polar", (req, res) => {
  try {
    mustHaveEnv();

    // IMPORTANT: redirect_uri must match EXACTLY what you entered in Polar admin.
    const state = randomState();

    const authUrl =
      "https://flow.polar.com/oauth2/authorization" +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(POLAR_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(POLAR_REDIRECT_URI)}` +
      `&scope=${encodeURIComponent("accesslink.read_all")}` +
      `&state=${encodeURIComponent(state)}`;

    return res.redirect(authUrl);
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// STEP 2: Callback (exchange code -> token, save token, register user)
// --------------------
app.get("/auth/polar/callback", async (req, res) => {
  try {
    mustHaveEnv();

    const code = req.query.code;
    const err = req.query.error;

    if (err) {
      return res.status(400).json({ ok: false, message: "Polar returned an error", error: err });
    }
    if (!code) {
      return res.status(400).send("Missing authorization code");
    }

    // Exchange code for token
    const tokenRes = await fetch("https://polarremote.com/v2/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(POLAR_CLIENT_ID, POLAR_CLIENT_SECRET),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json;charset=UTF-8",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: POLAR_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json().catch(() => null);

    if (!tokenRes.ok) {
      return res.status(400).json({
        ok: false,
        message: "Token exchange failed",
        status: tokenRes.status,
        data: tokenData,
      });
    }

    // Save token (must match your polar_tokens columns)
    const insertToken = {
      access_token: tokenData?.access_token ?? null,
      refresh_token: tokenData?.refresh_token ?? null,
      expires_in: tokenData?.expires_in ?? null,
      token_type: tokenData?.token_type ?? null,
      x_user_id: tokenData?.x_user_id ?? null,
      scope: tokenData?.scope ?? "accesslink.read_all",
      raw: tokenData,
    };

    const { error: tokenSaveErr } = await supabase.from("polar_tokens").insert([insertToken]);

    if (tokenSaveErr) {
      return res.status(500).json({
        ok: false,
        message: "Saved token failed",
        error: tokenSaveErr,
      });
    }

    // Register user (POST /v3/users) -> 200 OK or 409 Already registered
    // member-id is YOUR identifier, can be anything unique.
    const memberId = `render_${tokenData?.x_user_id ?? "unknown"}`;

    const regRes = await fetch("https://www.polaraccesslink.com/v3/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ "member-id": memberId }),
    });

    if (regRes.status !== 200 && regRes.status !== 409) {
      const regData = await regRes.text();
      return res.status(400).json({
        ok: false,
        message: "User register failed",
        status: regRes.status,
        raw: regData,
      });
    }

    return res.send("✅ Polar connected successfully. You can close this page.");
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// Register status (GET /v3/users/{user-id})
// --------------------
app.get("/polar/register-status", async (req, res) => {
  try {
    const token = await getLatestPolarToken();
    if (!token?.access_token || !token?.x_user_id) {
      return res.status(400).json({
        ok: false,
        message: "No saved Polar token yet. Visit /auth/polar first.",
      });
    }

    const url = `https://www.polaraccesslink.com/v3/users/${token.x_user_id}`;

    const r = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/json",
      },
    });

    if (r.status === 204) return res.json({ ok: true, registered: false, status: 204 });

    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, status: r.status, data: json, raw: text });
    }

    return res.json({ ok: true, registered: true, data: json });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// List exercise transactions (GET /v3/users/{id}/exercise-transactions)
// --------------------
app.get("/polar/transactions", async (req, res) => {
  try {
    const token = await getLatestPolarToken();
    if (!token?.access_token || !token?.x_user_id) {
      return res.status(400).json({ ok: false, message: "No token/x_user_id found. Visit /auth/polar first." });
    }

    const url = `https://www.polaraccesslink.com/v3/users/${token.x_user_id}/exercise-transactions`;

    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
    });

    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, status: r.status, data: json, raw: text });
    }

    return res.json({ ok: true, data: json });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// List exercises for a transaction (GET /v3/users/{id}/exercise-transactions/{transactionId})
// --------------------
app.get("/polar/transactions/:transactionId", async (req, res) => {
  try {
    const token = await getLatestPolarToken();
    if (!token?.access_token || !token?.x_user_id) {
      return res.status(400).json({ ok: false, message: "No token/x_user_id found. Visit /auth/polar first." });
    }

    const { transactionId } = req.params;

    const url = `https://www.polaraccesslink.com/v3/users/${token.x_user_id}/exercise-transactions/${transactionId}`;

    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
    });

    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, status: r.status, data: json, raw: text });
    }

    return res.json({ ok: true, data: json });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// Get a single exercise summary by id (GET /v3/exercises/{exerciseId})
// --------------------
app.get("/polar/exercise/:exerciseId", async (req, res) => {
  try {
    const token = await getLatestPolarToken();
    if (!token?.access_token) {
      return res.status(400).json({ ok: false, message: "No saved Polar token yet. Visit /auth/polar first." });
    }

    const { exerciseId } = req.params;
    const url = `https://www.polaraccesslink.com/v3/exercises/${exerciseId}`;

    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
    });

    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, status: r.status, data: json, raw: text });
    }

    return res.json({ ok: true, data: json });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// Placeholder webhook endpoints (optional later)
// --------------------
app.post("/webhooks/polar", async (req, res) => {
  const raw = req.body ?? {};
  const { error } = await supabase.from("polar_sessions").insert([
    { session_start: new Date().toISOString(), raw },
  ]);
  if (error) return res.status(500).json({ ok: false, error });
  return res.json({ ok: true });
});

app.post("/webhooks/pushpress", async (req, res) => {
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
});

// --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
