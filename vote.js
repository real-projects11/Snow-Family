const R_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL;

const R_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN;

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

const BROTHER = ["Shadow", "Bruno", "Kobi"];
const DAD = ["Atlas", "Kong", "Otis"];

async function redis(...cmd) {
  const r = await fetch(R_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + R_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

async function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch("https://api.telegram.org/bot" + TG_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: text })
    });
  } catch (e) {
    // si Telegram falla, el dato igual quedó guardado
  }
}

async function throttled(ip, action, seconds) {
  const ok = await redis("SET", "lock:" + action + ":" + ip, "1", "NX", "EX", String(seconds));
  return ok === null;
}

export default async function handler(req, res) {
  if (!R_URL || !R_TOKEN) {
    return res.status(500).json({ error: "faltan las variables de Upstash" });
  }

  const fwd = req.headers["x-forwarded-for"] || "0.0.0.0";
  const ip = String(fwd).split(",")[0].trim();

  try {
    if (req.method === "GET") {
      const type = req.query.type;

      if (type === "tally" || type === "tally_dad") {
        const set = type === "tally" ? BROTHER : DAD;
        const bucket = type === "tally" ? "brother" : "dad";
        const keys = set.map(function (n) { return "votes:" + bucket + ":" + n; });
        const vals = await redis("MGET", ...keys);
        const out = {};
        set.forEach(function (n, i) { out[n] = parseInt(vals[i] || 0, 10); });
        return res.status(200).json(out);
      }

      if (type === "suggestions") {
        const flat = await redis("ZREVRANGE", "suggestions", "0", "9", "WITHSCORES");
        const list = [];
        for (let i = 0; i < flat.length; i += 2) {
          list.push({ name: flat[i], count: parseInt(flat[i + 1], 10) });
        }
        return res.status(200).json(list);
      }

      return res.status(400).json({ error: "unknown type" });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const type = body.type;

      if (type === "vote" || type === "vote_dad") {
        const set = type === "vote" ? BROTHER : DAD;
        const bucket = type === "vote" ? "brother" : "dad";
        const name = String(body.name || "");

        if (set.indexOf(name) === -1) {
          return res.status(400).json({ error: "invalid name" });
        }
        if (await throttled(ip, bucket, 30)) {
          return res.status(200).json({ ok: true, throttled: true });
        }

        const total = await redis("INCR", "votes:" + bucket + ":" + name);
        return res.status(200).json({ ok: true, name: name, total: total });
      }

      if (type === "suggestion") {
        const raw = String(body.name || "")
          .replace(/[^a-zA-Z' -]/g, "")
          .trim()
          .slice(0, 18);

        if (raw.length < 2) {
          return res.status(400).json({ error: "too short" });
        }
        if (await throttled(ip, "sugg", 60)) {
          return res.status(200).json({ ok: true, throttled: true });
        }

        const name = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
        await redis("ZINCRBY", "suggestions", "1", name);
        return res.status(200).json({ ok: true, name: name });
      }

      if (type === "lead") {
        const email = String(body.email || "").trim().toLowerCase();
        const valid = /^\S+@\S+\.\S+$/.test(email);

        if (!valid) {
          return res.status(400).json({ error: "bad email" });
        }

        const added = await redis("SADD", "leads", email);

        if (added === 1) {
          await redis("HSET", "lead:" + email, "vote", String(body.vote || ""), "at", new Date().toISOString());
          const count = await redis("SCARD", "leads");
          await telegram("Nuevo mail: " + email + "\nVoto: " + (body.vote || "-") + "\nTotal: " + count);
        }

        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: "unknown type" });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error", detalle: String(e.message) });
  }
}
