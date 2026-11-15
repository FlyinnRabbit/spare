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

const randCode = (n = 8) => {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => A[b % A.length]).join("");
};
const isAdmin = async (env, userId) =>
  (await env.DB.prepare("SELECT MIN(id) AS id FROM users").first())?.id === userId;
async function makeResetCode(env, userId, ttlMs) {
  const code = randCode(8);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM resets WHERE user_id = ? OR expires_at < ?").bind(userId, Date.now()),
    env.DB.prepare("INSERT INTO resets (user_id, code_hash, expires_at) VALUES (?, ?, ?)").bind(userId, await sha256(code), Date.now() + ttlMs),
  ]);
  return code;
}
async function useAI(env, user) {
  if (user.admin) return;
  const limit = +(env.DAILY_AI_LIMIT || 25), day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT n FROM usage WHERE user_id = ? AND day = ?").bind(user.id, day).first();
  if (row && row.n >= limit) throw Object.assign(new Error(`Daily limit reached (${limit} scans or ideas). It resets overnight.`), { status: 429 });
  await env.DB.prepare("INSERT INTO usage (user_id, day, n) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET n = n + 1").bind(user.id, day).run();
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
  const imgs = Array.isArray(imageDataUrl) ? imageDataUrl : imageDataUrl ? [imageDataUrl] : [];
  if (env.ANTHROPIC_API_KEY) {
    const content = [];
    for (const url of imgs) {
      const [, media_type, data] = url.match(/^data:([^;]+);base64,(.*)$/) || [];
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
  for (const url of imgs) content.push({ type: "image_url", image_url: { url } });
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

  if (path === "/api/health") return json({ ok: true, ai: env.ANTHROPIC_API_KEY ? "claude" : "workers-ai", signup: env.ALLOW_SIGNUP !== "false", email: !!(env.RESEND_API_KEY && env.MAIL_FROM) });

  if (path === "/api/reset/request" && method === "POST") {
    const { email } = await readBody(req, 10_000);
    const em = String(email || "").trim().toLowerCase();
    const canMail = !!(env.RESEND_API_KEY && env.MAIL_FROM);
    const u = validEmail(em) && await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(em).first();
    if (u && canMail) {
      const code = await makeResetCode(env, u.id, 3600e3);
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM, to: em, subject: "Your Spare reset code",
          text: `Your Spare password reset code is ${code}\n\nIt works for 1 hour. If you didn't ask for it, ignore this email.` }),
      });
    }
    return json({ ok: true, emailed: canMail });
  }

  if (path === "/api/reset/confirm" && method === "POST") {
    const { email, code, newPassword } = await readBody(req, 10_000);
    const em = String(email || "").trim().toLowerCase();
    if (typeof newPassword !== "string" || newPassword.length < 8) return fail(400, "New password needs at least 8 characters.");
    const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(em).first();
    const r = u && await env.DB.prepare("SELECT code_hash FROM resets WHERE user_id = ? AND expires_at > ?").bind(u.id, Date.now()).first();
    if (!r || r.code_hash !== await sha256(String(code || "").trim().toUpperCase())) return fail(400, "That code is wrong or expired.");
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").bind(await hashPassword(newPassword), u.id),
      env.DB.prepare("DELETE FROM resets WHERE user_id = ?").bind(u.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
    ]);
    return json({ token: await newSession(env, u.id), email: em });
  }

  if (path === "/api/signup" && method === "POST") {
    if (env.ALLOW_SIGNUP === "false") return fail(403, "Sign-ups are closed on this server.");
    const { email, password, invite } = await readBody(req, 10_000);
    const em = String(email || "").trim().toLowerCase();
    if (!validEmail(em)) return fail(400, "Enter a valid email.");
    const first = !(await env.DB.prepare("SELECT id FROM users LIMIT 1").first());
    const code = String(invite || "").trim().toUpperCase();
    if (!first) {
      const inv = code && await env.DB.prepare("SELECT code, max_uses, uses FROM invites WHERE code = ?").bind(code).first();
      if (!inv || inv.uses >= inv.max_uses) return fail(403, code ? "That invite code is wrong or already used." : "You need an invite code to create an account.");
    }
    if (typeof password !== "string" || password.length < 8) return fail(400, "Password needs at least 8 characters.");
    const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(em).first();
    if (exists) return fail(409, "An account with this email already exists. Log in instead.");
    const r = await env.DB.prepare("INSERT INTO users (email, pw_hash, created_at) VALUES (?, ?, ?)")
      .bind(em, await hashPassword(password), Date.now()).run();
    const id = r.meta.last_row_id;
    if (!first) await env.DB.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?").bind(code).run();
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
  user.admin = await isAdmin(env, user.id);

  if (path.startsWith("/api/admin/")) {
    if (!user.admin) return fail(403, "Only the admin can do that.");
    if (path === "/api/admin/overview" && method === "GET") {
      const invites = (await env.DB.prepare("SELECT code, note, max_uses, uses, created_at FROM invites ORDER BY created_at DESC").all()).results;
      const users = (await env.DB.prepare(
        "SELECT u.email, u.created_at, s.updated_at AS synced FROM users u LEFT JOIN states s ON s.user_id = u.id ORDER BY u.id"
      ).all()).results;
      return json({ invites, users });
    }
    if (path === "/api/admin/invite" && method === "POST") {
      const { note, uses } = await readBody(req, 10_000);
      const code = randCode(8);
      await env.DB.prepare("INSERT INTO invites (code, note, max_uses, uses, created_at) VALUES (?, ?, ?, 0, ?)")
        .bind(code, String(note || "").slice(0, 80), Math.min(50, Math.max(1, +uses || 1)), Date.now()).run();
      return json({ code });
    }
    if (path === "/api/admin/invite/delete" && method === "POST") {
      const { code } = await readBody(req, 10_000);
      await env.DB.prepare("DELETE FROM invites WHERE code = ?").bind(String(code || "")).run();
      return json({ ok: true });
    }
    if (path === "/api/admin/reset" && method === "POST") {
      const { email } = await readBody(req, 10_000);
      const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(String(email || "").toLowerCase()).first();
      if (!u) return fail(404, "No such account.");
      return json({ code: await makeResetCode(env, u.id, 24 * 3600e3) });
    }
    return fail(404, "Not found");
  }

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
    return json({ email: user.email, admin: user.admin, data: row ? JSON.parse(row.data) : null, updatedAt: row ? row.updated_at : 0 });
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
    const { image, images, text, prompt } = await readBody(req, 12_000_000);
    if (typeof prompt !== "string" || prompt.length > 8000) return fail(400, "Missing prompt.");
    const imgs = (Array.isArray(images) ? images : image ? [image] : []).slice(0, 4);
    if (imgs.some((u) => typeof u !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(u))) return fail(400, "Unsupported image.");
    await useAI(env, user);
    const multi = imgs.length > 1 ? `\n\nThe receipt is split over ${imgs.length} photos, in order from top to bottom. Lines visible on two photos must be counted only once.` : "";
    const full = text ? `${prompt}\n\nOrder text:\n${String(text).slice(0, 20000)}` : prompt + multi;
    try { return json(extractJSON(await askModel(env, full, imgs))); }
    catch (e) { return fail(502, "Couldn't read that ticket. " + e.message); }
  }

  if (path === "/api/tips" && method === "POST") {
    const { prompt } = await readBody(req, 60_000);
    if (typeof prompt !== "string" || prompt.length > 30000) return fail(400, "Missing prompt.");
    await useAI(env, user);
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
