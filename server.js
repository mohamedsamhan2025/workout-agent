import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ENV you MUST have on Render:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - POLAR_CLIENT_ID
 * - POLAR_CLIENT_SECRET
 * - POLAR_REDIRECT_URI   (must match EXACTLY what you set in Polar admin)
 * Optional:
 * - POLAR_SCOPE          (default: accesslink.read_all)
 * - POLAR_MEMBER_ID      (default: mo-samhan)
 */

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  POLAR_CLIENT_ID,
  POLAR_CLIENT_SECRET,
  POLAR_REDIRECT_URI,
  POLAR_SCOPE,
  POLAR_MEMBER_ID,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
if (!POLAR_CLIENT_ID || !POLAR_CLIENT_SECRET || !POLAR_REDIRECT_URI) {
  console.error("❌ Missing POLAR_CLIENT_ID / POLAR_CLIENT_SECRET / POLAR_REDIRECT_URI");
}

const supabase = createClient(SUPABASE_URL || "", SUPABASE_SERVICE_ROLE_KEY || "");

const POLAR_AUTH_URL = "https://flow.polar.com/oauth2/authorization";
const POLAR_TOKEN_URL = "https://polarremote.com/v2/oauth2/token";
const ACCESSLINK_BASE = "https://www.polaraccesslink.com";
const SCOPE = POLAR_SCOPE || "accesslink.read_all";
const MEMBER_ID = POLAR_MEMBER_ID || "mo-samhan";

/** ---------------------------
 *  Helpers
 *  --------------------------*/
function basicAuthHeader(clientId, clientSecret) {
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  return `Basic ${encoded}`;
}

async function getLatestPolarToken() {
  const { data, error } = await supabase
    .from("polar_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.access_token) throw new Error("No token found in polar_tokens yet.");
  return data;
}

/** ---------------------------
 *  Health
 *  --------------------------*/
app.get("/", (req, res) => {
  res.status(200).send("Workout Agent is running ✅");
});

/** ---------------------------
 *  Debug inserts (your existing tests)
 *  --------------------------*/
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

/** ---------------------------
 *  STEP A: "Door" 1 — send user to Polar login (OAuth authorize)
 *  --------------------------*/
app.get("/auth/polar", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");

  const url =
    `${POLAR_AUTH_URL}` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(POLAR_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(POLAR_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&state=${encodeURIComponent(state)}`;

  return res.redirect(url);
});

/** ---------------------------
 *  STEP B: "Door" 2 — Polar calls you back with ?code=
 *  Exchange code -> token, SAVE token to Supabase (polar_tokens)
 *  Then REGISTER USER (required before you can pull exercise data)
 *  --------------------------*/
app.get("/auth/polar/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const errorFromPolar = req.query.error;

    if (errorFromPolar) {
      return res.status(400).json({ ok: false, message: "Polar returned error", error: errorFromPolar });
    }

    if (!code) {
      return res.status(400).send("Missing authorization code");
    }

    // 1) Exchange code for access token
    const tokenRes = await fetch(POLAR_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(POLAR_CLIENT_ID, POLAR_CLIENT_SECRET),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: POLAR_REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      return res.status(400).json({
        ok: false,
        message: "Token exchange failed",
        status: tokenRes.status,
        tokenData,
      });
    }

    // tokenData includes: access_token, token_type, expires_in, x_user_id
    // Your polar_tokens table DOES NOT have token_type column -> store it inside raw instead.
    const insertPayload = {
      access_token: tokenData.access_token ?? null,
      refresh_token: tokenData.refresh_token ?? null, // may be missing in some setups
      expires_in: tokenData.expires_in ?? null,
      scope: SCOPE,
      raw: tokenData, // keep everything here including token_type and x_user_id
    };

    const { data: saved, error: saveErr } = await supabase
      .from("polar_tokens")
      .insert([insertPayload])
      .select()
      .single();

    if (saveErr) {
      return res.status(500).json({
        ok: false,
        message: "Saved token failed",
        error: saveErr,
      });
    }

    // 2) Register user (required by Polar before you can read exercises)
    // Docs: POST https://www.polaraccesslink.com/v3/users with Bearer token + member-id
    const registerRes = await fetch(`${ACCESSLINK_BASE}/v3/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ "member-id": MEMBER_ID }),
    });

    // Register may return 200 (json user), or 409 if already registered
    let registerJson = null;
    const text = await registerRes.text();
    try {
      registerJson = text ? JSON.parse(text) : null;
    } catch {
      registerJson = { raw_text: text };
    }

    // Save registration response into the same token row (inside raw) for debugging
    // (If this update fails, we still consider OAuth “connected”, because token is saved.)
    await supabase
      .from("polar_tokens")
      .update({
        raw: { ...(tokenData ?? {}), register_response: registerJson, register_status: registerRes.status },
      })
      .eq("id", saved.id);

    // If user already registered, that's fine.
    if (!registerRes.ok && registerRes.status !== 409) {
      return res.status(400).json({
        ok: false,
        message: "Token saved, but Polar user registration failed",
        register_status: registerRes.status,
        register_response: registerJson,
      });
    }

    return res.send("✅ Polar connected successfully. You can close this page.");
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

/** ---------------------------
 *  Pull last 30 days exercises from Polar and optionally insert into polar_sessions
 *  Docs: GET /v3/exercises (Bearer token). Only last 30 days returned.
 *  --------------------------*/
app.get("/polar/exercises", async (req, res) => {
  try {
    const tokenRow = await getLatestPolarToken();
    const accessToken = tokenRow.access_token;

    const url = new URL(`${ACCESSLINK_BASE}/v3/exercises`);
    // optional flags:
    // url.searchParams.set("samples", "false");
    // url.searchParams.set("zones", "false");
    // url.searchParams.set("route", "false");

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });

    const data = await r.json().catch(() => null);

    if (!r.ok) {
      return res.status(400).json({ ok: false, message: "Failed to fetch exercises", status: r.status, data });
    }

    return res.json({ ok: true, count: Array.isArray(data) ? data.length : null, data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

/** ---------------------------
 *  OPTIONAL: Pull exercises and insert a simplified row into polar_sessions
 *  (avg_hr/max_hr/calories/cardio_load + raw)
 *  --------------------------*/
app.post("/polar/exercises/sync", async (req, res) => {
  try {
    const tokenRow = await getLatestPolarToken();
    const accessToken = tokenRow.access_token;

    const r = await fetch(`${ACCESSLINK_BASE}/v3/exercises`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });

    const exercises = await r.json().catch(() => null);

    if (!r.ok || !Array.isArray(exercises)) {
      return res.status(400).json({
        ok: false,
        message: "Failed to fetch exercises to sync",
        status: r.status,
        exercises,
      });
    }

    const rows = exercises.map((ex) => {
      const sessionStart = ex?.start_time ? new Date(ex.start_time).toISOString() : new Date().toISOString();
      const avgHr = ex?.heart_rate?.average ?? null;
      const maxHr = ex?.heart_rate?.maximum ?? null;
      const calories = ex?.calories ?? null;

      // cardio load: prefer training_load_pro.cardio-load, fallback to training_load if available
      const cardioLoad =
        ex?.training_load_pro?.["cardio-load"] ??
        ex?.training_load ??
        null;

      return {
        session_start: sessionStart,
        avg_hr: avgHr,
        max_hr: maxHr,
        calories,
        cardio_load: cardioLoad,
        raw: ex,
      };
    });

    const { data: inserted, error } = await supabase.from("polar_sessions").insert(rows).select();

    if (error) return res.status(500).json({ ok: false, message: "Insert to polar_sessions failed", error });

    return res.json({ ok: true, inserted_count: inserted?.length ?? 0 });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

/** ---------------------------
 *  Placeholder webhooks (for later)
 *  --------------------------*/
app.post("/webhooks/polar", async (req, res) => {
  const raw = req.body ?? {};
  const { error } = await supabase.from("polar_sessions").insert([{ session_start: new Date().toISOString(), raw }]);
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
