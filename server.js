import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json());

// --------------------
// ENV CHECK
// --------------------
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  POLAR_CLIENT_ID,
  POLAR_CLIENT_SECRET,
  POLAR_REDIRECT_URI
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing Supabase env vars");
}

if (!POLAR_CLIENT_ID || !POLAR_CLIENT_SECRET || !POLAR_REDIRECT_URI) {
  console.error("❌ Missing Polar OAuth env vars");
}

// --------------------
// SUPABASE CLIENT
// --------------------
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

// --------------------
// HEALTH CHECK
// --------------------
app.get("/", (req, res) => {
  res.send("Workout Agent running ✅");
});

// --------------------
// STEP 1: REDIRECT USER TO POLAR
// --------------------
app.get("/auth/polar", (req, res) => {
  const url =
    "https://flow.polar.com/oauth2/authorization" +
    `?response_type=code` +
    `&client_id=${POLAR_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(POLAR_REDIRECT_URI)}`;

  console.log("➡️ Redirecting to Polar:", url);
  res.redirect(url);
});

// --------------------
// STEP 2: POLAR CALLBACK
// --------------------
app.get("/auth/polar/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error("❌ Polar error:", error);
    return res.status(400).send("Polar authorization failed");
  }

  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  try {
    // Exchange code for token
    const tokenResponse = await fetch(
      "https://polarremote.com/v2/oauth2/token",
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${POLAR_CLIENT_ID}:${POLAR_CLIENT_SECRET}`
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: POLAR_REDIRECT_URI
        })
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error("❌ Token error:", tokenData);
      return res.status(500).json(tokenData);
    }

    // Save token
    await supabase.from("polar_tokens").insert([
      {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        token_type: tokenData.token_type,
        scope: tokenData.scope
      }
    ]);

    res.send("✅ Polar connected successfully. You can close this page.");

  } catch (err) {
    console.error("❌ Callback crash:", err);
    res.status(500).send("Server error during Polar callback");
  }
});

// --------------------
// DEBUG TEST INSERT
// --------------------
app.get("/debug/insert-test", async (req, res) => {
  const { data, error } = await supabase
    .from("polar_sessions")
    .insert([
      {
        session_start: new Date().toISOString(),
        avg_hr: 145,
        max_hr: 182,
        cardio_load: 120
      }
    ])
    .select()
    .single();

  if (error) return res.status(500).json(error);
  res.json({ ok: true, data });
});

// --------------------
// START SERVER
// --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server listening on port ${PORT}`)
);
