import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// --------------------
// Supabase
// --------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL || "", SUPABASE_SERVICE_ROLE_KEY || "");

// --------------------
// Polar env
// --------------------
const POLAR_CLIENT_ID = process.env.POLAR_CLIENT_ID;
const POLAR_CLIENT_SECRET = process.env.POLAR_CLIENT_SECRET;
const POLAR_REDIRECT_URI = process.env.POLAR_REDIRECT_URI;

function mustHaveEnv() {
  const missing = [];
  if (!POLAR_CLIENT_ID) missing.push("POLAR_CLIENT_ID");
  if (!POLAR_CLIENT_SECRET) missing.push("POLAR_CLIENT_SECRET");
  if (!POLAR_REDIRECT_URI) missing.push("POLAR_REDIRECT_URI");
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }
}

// --------------------
// Helpers
// --------------------
function basicAuthHeader(clientId, clientSecret) {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

async function getLatestPolarToken() {
  const { data, error } = await supabase
    .from("polar_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data; // can be null if not connected yet
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
// STEP A: "Door" to Polar login (GET)
// --------------------
app.get("/auth/polar", (req, res) => {
  try {
    mustHaveEnv();

    // Per docs: GET https://flow.polar.com/oauth2/authorization?... :contentReference[oaicite:4]{index=4}
    const authUrl =
      "https://flow.polar.com/oauth2/authorization" +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(POLAR_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(POLAR_REDIRECT_URI)}` +
      `&scope=${encodeURIComponent("accesslink.read_all")}` +
      `&state=${encodeURIComponent(cryptoRandomState())}`;

    return res.redirect(authUrl);
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

function cryptoRandomState() {
  // simple random string, good enough for now
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

// --------------------
// STEP B: Polar redirects here with ?code=...
// Exchange code -> token, save it, then REGISTER user.
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

    // Token endpoint: POST https://polarremote.com/v2/oauth2/token :contentReference[oaicite:5]{index=5}
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
        redirect_uri: POLAR_REDIRECT_URI, // must match if you used it in /authorization :contentReference[oaicite:6]{index=6}
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

    // tokenData contains: access_token, token_type, expires_in, x_user_id :contentReference[oaicite:7]{index=7}
    const insertToken = {
      access_token: tokenData?.access_token ?? null,
      refresh_token: tokenData?.refresh_token ?? null, // may be missing in some flows
      expires_in: tokenData?.expires_in ?? null,
      token_type: tokenData?.token_type ?? null,
      x_user_id: tokenData?.x_user_id ?? null,
      scope: "accesslink.read_all",
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

    // REGISTER user (required before getting data) :contentReference[oaicite:8]{index=8}
    // POST https://www.polaraccesslink.com/v3/users with Bearer access token :contentReference[oaicite:9]{index=9}
    const memberId = `user_${tokenData?.x_user_id ?? "unknown"}`; // your own identifier

    const regRes = await fetch("https://www.polaraccesslink.com/v3/users", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ "member-id": memberId }),
    });

    // 200 = registered; 409 = already registered :contentReference[oaicite:10]{index=10}
    if (regRes.status !== 200 && regRes.status !== 409) {
      const regData = await regRes.json().catch(() => null);
      return res.status(400).json({
        ok: false,
        message: "User register failed",
        status: regRes.status,
        data: regData,
      });
    }

    return res.send("✅ Polar connected successfully. You can close this page.");
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// Check registration status (GET /v3/users/{user-id})
// --------------------
app.get("/polar/register-status", async (req, res) => {
  try {
    const token = await getLatestPolarToken();
    if (!token?.access_token || !token?.x_user_id) {
      return res.status(400).json({ ok: false, message: "No saved Polar token yet. Visit /auth/polar first." });
    }

    // Correct endpoint: GET /v3/users/{user-id} :contentReference[oaicite:11]{index=11}
    const url = `https://www.polaraccesslink.com/v3/users/${token.x_user_id}`;

    const infoRes = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/json",
      },
    });

    if (infoRes.status === 204) {
      return res.json({ ok: true, registered: false, status: 204 });
    }

    const data = await infoRes.json().catch(() => null);
    if (!infoRes.ok) {
      return res.status(400).json({ ok: false, status: infoRes.status, data });
    }

    return res.json({ ok: true, registered: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// List exercises (last 30 days, after registration) :contentReference[oaicite:12]{index=12}
// --------------------
app.get("/polar/exercises", async (req, res) => {
  try {
    const token = await getLatestPolarToken();
    if (!token?.access_token) {
      return res.status(400).json({ ok: false, message: "No saved Polar token yet. Visit /auth/polar first." });
    }

    const params = new URLSearchParams();
    if (req.query.samples === "true") params.set("samples", "true");
    if (req.query.zones === "true") params.set("zones", "true");
    if (req.query.route === "true") params.set("route", "true");

    // GET /v3/exercises :contentReference[oaicite:13]{index=13}
    const url = `https://www.polaraccesslink.com/v3/exercises${params.toString() ? `?${params}` : ""}`;

    const exRes = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/json",
      },
    });

    const data = await exRes.json().catch(() => null);

    if (!exRes.ok) {
      return res.status(400).json({ ok: false, status: exRes.status, data });
    }

    return res.json({ ok: true, count: Array.isArray(data) ? data.length : 0, data });
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
