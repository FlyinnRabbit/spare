// Spare API — accounts, sync and receipt reading on Cloudflare Workers + D1.
// Static files (the web app) are served from ../web by the assets binding;
// everything under /api/ lands here.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};
const PBKDF2_ITER = 50000; // Workers caps PBKDF2 at 100k; 50k keeps logins fast on the free plan.
const VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MAX_STATE_BYTES = 1_800_000; // D1 rows top out at 2 MB.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
const fail = (status, error) => json({ error }, status);

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${hex(salt)}$${await pbkdf2(password, salt, PBKDF2_ITER)}`;
}
async function checkPassword(password, stored) {
  const [, iter, salt, want] = stored.split("$");
  const got = await pbkdf2(password, fromHex(salt), +iter);
  let diff = got.length ^ want.length;
  for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}
async function newSession(env, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_used) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now, now).run();
  return token;
}
async function authUser(env, req) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  const th = await sha256(m[1]);
  const row = await env.DB.prepare(
    "SELECT u.id, u.email, s.last_used FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"
  ).bind(th).first();
  if (!row) return null;
  if (Date.now() - row.last_used > 6 * 3600e3)
    await env.DB.prepare("UPDATE sessions SET last_used = ? WHERE token_hash = ?").bind(Date.now(), th).run();
  return { id: row.id, email: row.email, tokenHash: th };
}

// ---------- AI ----------
function extractJSON(out) {
  if (out && typeof out === "object") return out;
  const s = String(out || "").replace(/```(?:json)?/g, "");
  const start = s.search(/[\[{]/);
  if (start < 0) throw new Error("no JSON in model output");
  const open = s[start], close = open === "{" ? "}" : "]";
  return JSON.parse(s.slice(start, s.lastIndexOf(close) + 1));
}
async function askModel(env, prompt, imageDataUrl) {
  if (env.ANTHROPIC_API_KEY) {
    const content = [];
    if (imageDataUrl) {
      const [, media_type, data] = imageDataUrl.match(/^data:([^;]+);base64,(.*)$/) || [];
      if (data) content.push({ type: "image", source: { type: "base64", media_type, data } });
    }
    content.push({ type: "text", text: prompt });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: env.CLAUDE_MODEL || "claude-haiku-5-5", max_tokens: 3000, messages: [{ role: "user", content }] }),
    });
    if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.content.map((c) => c.text || "").join("");
  }
  const content = [];
  if (imageDataUrl) content.push({ type: "image_url", image_url: { url: imageDataUrl } });
  content.push({ type: "text", text: prompt });
  const res = await env.AI.run(VISION_MODEL, { messages: [{ role: "user", content }], max_tokens: 3000, temperature: 0.1 });
  return res?.response ?? res?.choices?.[0]?.message?.content ?? res;
}

// ---------- routes ----------
async function readBody(req, max = 8_000_000) {
  const len = +req.headers.get("content-length") || 0;
  if (len > max) throw Object.assign(new Error("too large"), { status: 413 });
  try { return await req.json(); } catch { throw Object.assign(new Error("bad json"), { status: 400 }); }
}
const validEmail = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length < 200;

async function api(req, env, path) {
  const method = req.method;

  if (path === "/api/health") return json({ ok: true, ai: env.ANTHROPIC_API_KEY ? "claude" : "workers-ai", signup: env.ALLOW_SIGNUP !== "false" });

  if (path === "/api/signup" && method === "POST") {
    if (env.ALLOW_SIGNUP === "false") return fail(403, "Sign-ups are closed on this server.");
    const { email, password } = await readBody(req, 10_000);
    const em = String(email || "").trim().toLowerCase();
    if (!validEmail(em)) return fail(400, "Enter a valid email.");
    if (typeof password !== "string" || password.length < 8) return fail(400, "Password needs at least 8 characters.");
    const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(em).first();
    if (exists) return fail(409, "An account with this email already exists. Log in instead.");
    const r = await env.DB.prepare("INSERT INTO users (email, pw_hash, created_at) VALUES (?, ?, ?)")
      .bind(em, await hashPassword(password), Date.now()).run();
    const id = r.meta.last_row_id;
    return json({ token: await newSession(env, id), email: em });
  }

  if (path === "/api/login" && method === "POST") {
    const { email, password } = await readBody(req, 10_000);
    const em = String(email || "").trim().toLowerCase();
    const u = await env.DB.prepare("SELECT id, pw_hash FROM users WHERE email = ?").bind(em).first();
    if (!u || typeof password !== "string" || !(await checkPassword(password, u.pw_hash)))
      return fail(401, "Wrong email or password.");
    return json({ token: await newSession(env, u.id), email: em });
  }

  const user = await authUser(env, req);
  if (!user) return fail(401, "Please log in again.");

  if (path === "/api/logout" && method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.tokenHash).run();
    return json({ ok: true });
  }

  if (path === "/api/password" && method === "POST") {
    const { oldPassword, newPassword } = await readBody(req, 10_000);
    const u = await env.DB.prepare("SELECT pw_hash FROM users WHERE id = ?").bind(user.id).first();
    if (!(await checkPassword(String(oldPassword || ""), u.pw_hash))) return fail(401, "Current password is wrong.");
    if (typeof newPassword !== "string" || newPassword.length < 8) return fail(400, "New password needs at least 8 characters.");
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").bind(await hashPassword(newPassword), user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, user.tokenHash),
    ]);
    return json({ ok: true });
  }

  if (path === "/api/state" && method === "GET") {
    const row = await env.DB.prepare("SELECT data, updated_at FROM states WHERE user_id = ?").bind(user.id).first();
    return json({ email: user.email, data: row ? JSON.parse(row.data) : null, updatedAt: row ? row.updated_at : 0 });
  }

  if (path === "/api/state" && method === "PUT") {
    const { data, base } = await readBody(req, MAX_STATE_BYTES + 10_000);
    if (!data || typeof data !== "object" || !data.settings) return fail(400, "Invalid data.");
    const text = JSON.stringify(data);
    if (text.length > MAX_STATE_BYTES) return fail(413, "Your data is getting too big to sync. Export a backup and clear old history.");
    const row = await env.DB.prepare("SELECT data, updated_at FROM states WHERE user_id = ?").bind(user.id).first();
    if (row && row.updated_at !== +base) // someone else saved since this device last synced
      return json({ conflict: true, data: JSON.parse(row.data), updatedAt: row.updated_at }, 409);
    const now = Math.max(Date.now(), (row?.updated_at || 0) + 1);
    await env.DB.prepare(
      "INSERT INTO states (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
    ).bind(user.id, text, now).run();
    return json({ ok: true, updatedAt: now });
  }

  if (path === "/api/scan" && method === "POST") {
    const { image, text, prompt } = await readBody(req);
    if (typeof prompt !== "string" || prompt.length > 8000) return fail(400, "Missing prompt.");
    if (image && !/^data:image\/(jpeg|png|webp);base64,/.test(image)) return fail(400, "Unsupported image.");
    const full = text ? `${prompt}\n\nOrder text:\n${String(text).slice(0, 20000)}` : prompt;
    try { return json(extractJSON(await askModel(env, full, image || null))); }
    catch (e) { return fail(502, "Couldn't read that ticket. " + e.message); }
  }

  if (path === "/api/tips" && method === "POST") {
    const { prompt } = await readBody(req, 60_000);
    if (typeof prompt !== "string" || prompt.length > 30000) return fail(400, "Missing prompt.");
    try { return json(extractJSON(await askModel(env, prompt, null))); }
    catch (e) { return fail(502, "Couldn't get ideas right now. " + e.message); }
  }

  return fail(404, "Not found");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    try { return await api(req, env, url.pathname); }
    catch (e) { return fail(e.status || 500, e.status ? e.message : "Server error: " + e.message); }
  },
};
