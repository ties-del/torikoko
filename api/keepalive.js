const supabaseConfig = require("../src/supabaseConfig.json");

const SUPABASE_URL = process.env.SUPABASE_URL || supabaseConfig.url;
const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  supabaseConfig.publishableKey;

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const target = `${SUPABASE_URL}/rest/v1/attendance?select=id&limit=1`;

  try {
    const response = await fetch(target, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: "application/json",
      },
    });

    return res.status(200).json({
      ok: true,
      supabaseReachable: true,
      supabaseStatus: response.status,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      supabaseReachable: false,
      error: error?.message || "Failed to reach Supabase",
      durationMs: Date.now() - startedAt,
    });
  }
};
