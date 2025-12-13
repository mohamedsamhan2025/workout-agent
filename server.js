import express from "express";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// Health check
app.get("/", (req, res) => {
  res.status(200).send("Workout Agent is running ✅");
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
          cardio_load: 120
        }
      ])
      .select()
      .single();

    if (error) return res.status(500).json(error);
    res.json({ ok: true, inserted: data });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL || "", SUPABASE_SERVICE_ROLE_KEY || "");

// Quick test insert (lets you confirm DB works later)
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
          raw: payload
        }
      ])
      .select()
      .single();

    if (error) return res.status(500).json({ ok: false, error });
    return res.json({ ok: true, inserted: data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e?.message ?? "Unknown error" });
  }
});

// Placeholder webhook endpoints (we’ll wire Polar/PushPress later)
app.post("/webhooks/polar", async (req, res) => {
  const raw = req.body ?? {};
  const { error } = await supabase.from("polar_sessions").insert([
    { session_start: new Date().toISOString(), raw }
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
      raw
    }
  ]);
  if (error) return res.status(500).json({ ok: false, error });
  return res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on port ${port}`));

