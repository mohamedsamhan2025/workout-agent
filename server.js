import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

/** -------------------------
 *  Supabase client
 *  ------------------------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(
  SUPABASE_URL || "",
  SUPABASE_SERVICE_ROLE_KEY || ""
);

/** -------------------------
 *  Health check
 *  ------------------------- */
app.get("/", (req, res) => {
  res.status(200).send("Workout Agent is running ✅");
});

/** -------------------------
 *  Debug insert (GET)
 *  Visit in browser to insert one test row
 *  ------------------------- */
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
    return res.status(500).json({ ok: false, message: e?.message ?? "Unknown error" });
  }
});

/** -------------------------
 *  Debug insert (POST)
 *  ------------------------- */
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

/** -------------------------
 *  “Mailbox” endpoints (URLs that can receive POSTs)
 *  Note: Polar AccessLink is NOT really “webhooks” in the UI like Stripe.
 *  Polar uses OAuth + API calls, and some subscription callbacks depending on AccessLink.
 *  ------------------------- */
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

/** -------------------------
 *  POLAR OAUTH (the “door”)
 *  ------------------------- */
app.get("/auth/polar", (req, res) => {
  const POLAR_CLIENT_ID = process.env.POLAR_CLIENT_ID;
  const POLAR_REDIRECT_URI = process.env.POLAR_REDIRECT_URI;

  if (!POLAR_CLIENT_ID || !POLAR_REDIRECT_URI) {
    return res.status(500).send("Missing POLAR_CLIENT_ID or POLAR_REDIRECT_URI env vars");
  }

  // Important: redirect_uri MUST match EXACTLY what you entered in Polar admin
  const state = "workout_agent_" + Date.now(); // simple state (ok for basic testing)

  const url =
    "https://flow.polar.com/oauth2/authorization" +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(POLAR_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(POLAR_REDIRECT_URI)}` +
    `&state=${encodeURIComponent(state)}`;

  return res.redirect(url);
});

app.get("/auth/polar/callback", async (req, res) => {
  try {
    const code = req.query.code;

    if (!code) {
      return res.status(400).send("Missing authorization code");
    }

    const POLAR_CLIENT_ID = process.env.POLAR_CLIENT_ID;
    const POLAR_CLIENT_SECRET = process.env.POLAR_CLIENT_SECRET;
    const POLAR_REDIRECT_URI = process.env.POLAR_REDIRECT_URI;

    if (!POLAR_CLIENT_ID || !POLAR_CLIENT_SECRET || !POLAR_REDIRECT_URI) {
      return res.status(500).send("Missing Polar env vars (ID/SECRET/REDIRECT_URI)");
    }

    // Exchange code for token (Node 22 has global fetch)
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
      return res.status(400).json({
        ok: false,
        message: "Polar token exchange failed",
        tokenData,
      });
    }

    // Store token in Supabase (you need a polar_tokens table)
    const { error } = await supabase.from("polar_tokens").insert([
      {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        token_type: tokenData.token_type ?? null,
        scope: tokenData.scope ?? null,
        created_at: new Date().toISOString(),
        raw: tokenData,
      },
    ]);

    if (error) return res.status(500).json({ ok: false, supabase_error: error });

    return res.send("✅ Polar connected successfully. You can close this page.");
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Unknown error" });
  }
});

/** -------------------------
 *  Start server
 *  ------------------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
