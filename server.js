import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// --------------------
// Env
// --------------------
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  POLAR_CLIENT_ID,
  POLAR_CLIENT_SECRET,
  POLAR_REDIRECT_URI,
} = process.env;

function assertEnv() {
  const missing = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!POLAR_CLIENT_ID) missing.push("POLAR_CLIENT_ID");
  if (!POLAR_CLIENT_SECRET) missing.push("POLAR_CLIENT_SECRET");
  if (!POLAR_REDIRECT_URI) missing.push("POLAR_REDIRECT_URI");
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

// --------------------
// Supabase
// --------------------
const supabase = createClient(SUPABASE_URL || "", SUPABASE_SERVICE_ROLE_KEY || "");

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
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data; // may be null
}

async function registerUserWithPolar(accessToken, xUserId) {
  // You can choose ANY member-id format you want (it’s your ID for the user).
  const memberId = `mo-${xUserId}`;

  const regRes = await fetch("https://www.polaraccesslink.com/v3/users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ "member-id": memberId }),
  });

  // 200 = registered, 409 = already registered
  if (regRes.status === 200 || regRes.status === 409) {
    return { ok: true, status: regRes.status };
  }

  const data = await regRes.json().catch(() => null);
  return { ok: false, status: regRes.status, data };
}

// --------------------
// Health
// --------------------
app.get("/", (req, res) => res.status(200).send("Workout Agent is running ✅"));

// --------------------
// Debug insert (GET)
// --------------------
app.get("/debug/insert-test", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("polar_sessions")
      .insert([{ session_start: new Date().toISOString(), avg_hr: 145, max_hr: 182, cardio_load: 120 }])
      .select()
      .single();

    if (error) return res.status(500).json({ ok: false, error });
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// STEP 1: Polar auth "door" (GET)
// --------------------
app.get("/auth/polar", (req, res) => {
  try {
    assertEnv();

    const url =
      "https://flow.polar.com/oauth2/authorization" +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(POLAR_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(POLAR_REDIRECT_URI)}` +
      `&scope=${encodeURIComponent("accesslink.read_all")}` +
      `&state=${encodeURIComponent(randomState())}`;

    return res.redirect(url);
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// STEP 2: Polar callback (GET) -> exchange code -> save token -> register user
// --------------------
app.get("/auth/polar/callback", async (req, res) => {
  try {
    assertEnv();

    const code = req.query.code;
    const err = req.query.error;

    if (err) return res.status(400).json({ ok: false, message: "Polar error", error: err });
    if (!code) return res.status(400).send("Missing authorization code");

    // Exchange code -> token
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

    const xUserId = tokenData?.x_user_id;
    const accessToken = tokenData?.access_token;

    // Save token to Supabase (matches your columns)
    const row = {
      access_token: tokenData?.access_token ?? null,
      refresh_token: tokenData?.refresh_token ?? null,
      expires_in: tokenData?.expires_in ?? null,
      token_type: tokenData?.token_type ?? null,
      x_user_id: xUserId ?? null,
      scope: tokenData?.scope ?? "accesslink.read_all",
      raw: tokenData,
    };

    const { error: saveErr } = await supabase.from("polar_tokens").insert([row]);
    if (saveErr) {
      return res.status(500).json({ ok: false, message: "Saved token failed", error: saveErr });
    }

    // Register user (required before data access)
    if (accessToken && xUserId) {
      const reg = await registerUserWithPolar(accessToken, xUserId);
      if (!reg.ok) {
        return res.status(400).json({ ok: false, message: "User register failed", ...reg });
      }
    }

    return res.send("✅ Polar connected successfully. You can close this page.");
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// Optional: manual register (GET) if you ever need it again
// --------------------
app.get("/polar/register", async (req, res) => {
  try {
    const token = await getLatestPolarToken();
    if (!token?.access_token || !token?.x_user_id) {
      return res.status(400).json({ ok: false, message: "No saved Polar token. Visit /auth/polar first." });
    }

    const reg = await registerUserWithPolar(token.access_token, token.x_user_id);
    if (!reg.ok) return res.status(400).json({ ok: false, ...reg });

    return res.json({ ok: true, message: "Registered (or already registered)", status: reg.status });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// Registration status (GET /v3/users/{user-id})
// --------------------
app.get("/polar/register-status", async (req, res) => {
  try {
    const token = await getLatestPolarToken();
    if (!token?.access_token || !token?.x_user_id) {
      return res.status(400).json({ ok: false, message: "No saved Polar token yet. Visit /auth/polar first." });
    }

    const url = `https://www.polaraccesslink.com/v3/users/${token.x_user_id}`;
    const infoRes = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
    });

    const data = await infoRes.json().catch(() => null);
    if (!infoRes.ok) return res.status(400).json({ ok: false, status: infoRes.status, data });

    return res.json({ ok: true, registered: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// ✅ Exercise Transactions (deprecated style)
// STEP A: Create transaction (MUST be POST)
// --------------------
app.post("/polar/transactions/exercises", async (req, res) => {
  try {
    const token = await getLatestPolarToken();
    if (!token?.access_token || !token?.x_user_id) {
      return res.status(400).json({ ok: false, message: "No saved Polar token. Visit /auth/polar first." });
    }

    const url = `https://www.polaraccesslink.com/v3/users/${token.x_user_id}/exercise-transactions`;

    const txRes = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        Accept: "application/json",
      },
    });

    // 201 = created, 204 = no new data
    if (txRes.status === 204) {
      return res.json({ ok: true, status: 204, message: "No new training data available (nothing new since last check)." });
    }

    const data = await txRes.json().catch(() => null);
    if (!txRes.ok) return res.status(400).json({ ok: false, status: txRes.status, data });

    return res.json({ ok: true, status: 201, data }); // includes transaction-id
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// STEP B: List exercises inside a transaction (GET)
// --------------------
app.get("/polar/transactions/exercises/:transactionId", async (req, res) => {
  try {
    const token = await getLatestPolarToken();
    if (!token?.access_token || !token?.x_user_id) {
      return res.status(400).json({ ok: false, message: "No saved Polar token. Visit /auth/polar first." });
    }

    const { transactionId } = req.params;
    const url = `https://www.polaraccesslink.com/v3/users/${token.x_user_id}/exercise-transactions/${transactionId}`;

    const listRes = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
    });

    const data = await listRes.json().catch(() => null);
    if (!listRes.ok) return res.status(400).json({ ok: false, status: listRes.status, data });

    return res.json({ ok: true, data }); // contains array of exercise URLs
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// --------------------
// Placeholder webhooks (later)
// --------------------
app.post("/webhooks/polar", async (req, res) => {
  const raw = req.body ?? {};
  const { error } = await supabase.from("polar_sessions").insert([{ session_start: new Date().toISOString(), raw }]);
  if (error) return res.status(500).json({ ok: false, error });
  return res.json({ ok: true });
});

// --------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
