/**
 * The push relay of the Ovis phone app (docs/native-app.md, "Notifications"). A WKWebView app
 * gets no Web Push, so this Cloudflare Worker looks to the PC's server/push.ts like one more Web
 * Push service and hands each push to Apple's push service (APNs):
 *
 * - POST /v1/register { token, environment? }: the app hands over its APNs device token and gets
 *   back an endpoint URL holding a random ID for it. The token never leaves the relay.
 * - POST /v1/push/<id>: a Web Push request (RFC 8030), its body encrypted for keys only the app
 *   holds (RFC 8291, aes128gcm) and signed with the PC's VAPID key (RFC 8292). The first VAPID
 *   key that pushes to an endpoint is pinned and any other is refused, so knowing an endpoint is
 *   not enough to send to a phone; each endpoint is rate-limited too. The ciphertext goes to APNs
 *   as it came, in a mutable-content push that the app's Notification Service Extension decrypts:
 *   the relay never holds a key that could read it. APNs saying a token is gone deletes the
 *   endpoint and answers 410, which the PC takes as an unsubscribe.
 *
 * Per endpoint it keeps the token, the APNs environment, the pinned key and the current rate
 * window (schema.sql), and nothing else; it never reads the sender's address and logs nothing.
 * Deploy: push-relay/README.md.
 */

/** the part of Cloudflare's D1 binding this Worker uses */
interface D1Statement { bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } }
export interface Env {
  DB: { prepare(query: string): D1Statement };
  /** secret: the APNs auth key (.p8 file contents, PKCS #8 PEM) */
  APNS_KEY: string;
  /** secret: the ID Apple shows for that key */
  APNS_KEY_ID: string;
  /** secret: the Apple developer team the key belongs to */
  APNS_TEAM_ID: string;
  /** var (wrangler.toml): the app's bundle ID */
  APNS_TOPIC: string;
}
type Environment = "production" | "sandbox";
type Send = (url: string, init: RequestInit) => Promise<Response>;

/** pushes one endpoint may make per window; more answer 429 until the window ends */
export const RATE_LIMIT = 60;
export const RATE_WINDOW_SECONDS = 600;
/** endpoints one device token may hold (one per PC); registering one more drops the oldest */
export const ENDPOINTS_PER_TOKEN = 32;
/** what a phone shows when its extension cannot decrypt a push (or does not run) */
export const FALLBACK_BODY = "herdr needs you";
const MAX_REGISTER_BYTES = 1024;
/** RFC 8030 section 7.2: the payload size every push service takes */
const MAX_PUSH_BYTES = 4096;
/** what APNs takes for a push's JSON; base64 makes the ciphertext a third larger */
const MAX_APNS_BYTES = 4096;
/** the longest a push waits at APNs for a phone that is offline */
const MAX_TTL_SECONDS = 28 * 24 * 60 * 60;
/** RFC 8292 section 2: a VAPID token expires within 24 hours */
const VAPID_MAX_SECONDS = 24 * 60 * 60;
/** APNs takes a provider token for an hour and refuses a new one more often than every 20 minutes */
const PROVIDER_TOKEN_SECONDS = 50 * 60;
const APNS_TIMEOUT_MS = 10_000;
const APNS_HOSTS: Record<Environment, string> = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" };
/** APNs reasons (with a 400) that mean the token will never take a push again */
const GONE_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic"]);
const ID = /^[A-Za-z0-9_-]{22}$/;
/** an APNs device token as hex; Apple asks not to rely on its length (32 bytes today) */
const TOKEN = /^(?:[0-9a-f]{2}){32,256}$/;
/** RFC 8030 section 5.4 */
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

const status = (code: number, headers?: Record<string, string>) => new Response(null, { status: code, headers });

/** base64 or base64url (padded or not) to bytes; null when it is neither */
function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  const base64 = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*$/.test(base64)) return null;
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const encodeBase64Url = (bytes: Uint8Array) => encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function jsonObject(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The sender's VAPID public key (base64url) when `header` is a valid RFC 8292 `vapid t=..., k=...`
 * for this relay (`audience`, its origin) at `nowSeconds`; null otherwise.
 */
export async function verifyVapid(header: string | null, audience: string, nowSeconds: number): Promise<string | null> {
  const match = header ? /^vapid\s+(.+)$/i.exec(header.trim()) : null;
  if (!match) return null;
  const params = new Map<string, string>();
  for (const part of match[1]!.split(",")) {
    const equals = part.indexOf("=");
    if (equals < 0) return null;
    params.set(part.slice(0, equals).trim().toLowerCase(), part.slice(equals + 1).trim());
  }
  const key = decodeBase64(params.get("k") ?? "");
  if (!key || key.length !== 65 || key[0] !== 4) return null;
  const parts = (params.get("t") ?? "").split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const jwtHeader = jsonObject(decodeBase64(encodedHeader));
  const claims = jsonObject(decodeBase64(encodedClaims));
  if (jwtHeader?.["alg"] !== "ES256" || claims?.["aud"] !== audience) return null;
  const expires = claims["exp"];
  if (typeof expires !== "number" || expires <= nowSeconds || expires > nowSeconds + VAPID_MAX_SECONDS) return null;
  const signature = decodeBase64(encodedSignature);
  if (!signature || signature.length !== 64) return null;
  try {
    const publicKey = await crypto.subtle.importKey("raw", key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`));
    return valid ? encodeBase64Url(key) : null;
  } catch {
    return null;
  }
}

/** the APNs provider token this isolate signed last, reused while APNs takes it */
let providerToken: { teamId: string; keyId: string; key: string; issuedAt: number; token: string } | null = null;

async function apnsToken(env: Env, nowSeconds: number): Promise<string> {
  const cached = providerToken;
  if (cached && cached.teamId === env.APNS_TEAM_ID && cached.keyId === env.APNS_KEY_ID && cached.key === env.APNS_KEY
    && nowSeconds >= cached.issuedAt && nowSeconds - cached.issuedAt < PROVIDER_TOKEN_SECONDS) return cached.token;
  const der = decodeBase64(env.APNS_KEY.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, ""));
  if (!der) throw new Error("APNS_KEY is not a PEM key");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (value: object) => encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${part({ alg: "ES256", kid: env.APNS_KEY_ID })}.${part({ iss: env.APNS_TEAM_ID, iat: nowSeconds })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned)));
  const token = `${unsigned}.${encodeBase64Url(signature)}`;
  providerToken = { teamId: env.APNS_TEAM_ID, keyId: env.APNS_KEY_ID, key: env.APNS_KEY, issuedAt: nowSeconds, token };
  return token;
}

/** the body, or null as soon as it passes `limit` bytes (without waiting for the rest) */
async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { void reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** the device token and its APNs environment from a registration body, or null when it is not one */
export function readRegistration(body: unknown): { token: string; environment: Environment } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "token" && key !== "environment")) return null;
  const { token, environment = "production" } = value;
  if (typeof token !== "string" || !TOKEN.test(token.toLowerCase())) return null;
  if (environment !== "production" && environment !== "sandbox") return null;
  return { token: token.toLowerCase(), environment };
}

async function register(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return status(405, { allow: "POST" });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return status(415);
  const bytes = await readBody(request, MAX_REGISTER_BYTES);
  if (bytes === null) return status(413);
  let registration: ReturnType<typeof readRegistration>;
  try { registration = readRegistration(JSON.parse(new TextDecoder().decode(bytes))); } catch { registration = null; }
  if (!registration) return status(400);
  const id = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare("INSERT INTO endpoints (id, token, environment) VALUES (?, ?, ?)").bind(id, registration.token, registration.environment).run();
  await env.DB.prepare("DELETE FROM endpoints WHERE token = ? AND id NOT IN (SELECT id FROM endpoints WHERE token = ? ORDER BY rowid DESC LIMIT ?)")
    .bind(registration.token, registration.token, ENDPOINTS_PER_TOKEN).run();
  return Response.json({ endpoint: `${new URL(request.url).origin}/v1/push/${id}` }, { status: 201, headers: { "cache-control": "no-store" } });
}

async function apnsReason(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const reason = (body as { reason?: unknown } | null)?.reason;
    return typeof reason === "string" ? reason : "";
  } catch {
    return "";
  }
}

async function push(request: Request, env: Env, id: string, now: Date, send: Send): Promise<Response> {
  if (request.method !== "POST") return status(405, { allow: "POST" });
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const key = await verifyVapid(request.headers.get("authorization"), new URL(request.url).origin, nowSeconds);
  if (!key) return status(401, { "www-authenticate": "vapid" });
  // the extension decrypts RFC 8291's aes128gcm only
  if (request.headers.get("content-encoding")?.toLowerCase() !== "aes128gcm") return status(415);
  const ttlHeader = request.headers.get("ttl");
  if (ttlHeader === null || !/^\d{1,10}$/.test(ttlHeader)) return status(400);
  const ttl = Math.min(Number(ttlHeader), MAX_TTL_SECONDS);
  const topic = request.headers.get("topic");
  if (topic !== null && !TOPIC.test(topic)) return status(400);
  const body = await readBody(request, MAX_PUSH_BYTES);
  if (body === null) return status(413);
  if (body.byteLength === 0) return status(400);
  const payload = JSON.stringify({ aps: { alert: { body: FALLBACK_BODY }, "mutable-content": 1 }, ovis: encodeBase64(body) });
  if (new TextEncoder().encode(payload).byteLength > MAX_APNS_BYTES) return status(413);

  // pin the first key that pushes, in one statement so two first pushes cannot both win
  const pinned = await env.DB.prepare("UPDATE endpoints SET vapid_key = COALESCE(vapid_key, ?) WHERE id = ? RETURNING vapid_key, window_start")
    .bind(key, id).first<{ vapid_key: string; window_start: number }>();
  if (!pinned) return status(404);
  if (pinned.vapid_key !== key) return status(403);
  const windowStart = nowSeconds - RATE_WINDOW_SECONDS;
  const allowed = await env.DB.prepare(
    "UPDATE endpoints SET window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END, window_count = CASE WHEN window_start <= ? THEN 1 ELSE window_count + 1 END WHERE id = ? AND (window_start <= ? OR window_count < ?) RETURNING token, environment",
  ).bind(windowStart, nowSeconds, windowStart, id, windowStart, RATE_LIMIT).first<{ token: string; environment: Environment }>();
  if (!allowed) return status(429, { "retry-after": String(Math.max(1, pinned.window_start + RATE_WINDOW_SECONDS - nowSeconds)) });

  let apns: Response;
  try {
    const headers: Record<string, string> = {
      authorization: `bearer ${await apnsToken(env, nowSeconds)}`,
      "apns-topic": env.APNS_TOPIC,
      "apns-push-type": "alert",
      "apns-priority": request.headers.get("urgency") === "high" ? "10" : "5",
      // 0: deliver now or never, as a TTL of 0 asks
      "apns-expiration": String(ttl === 0 ? 0 : nowSeconds + ttl),
      "content-type": "application/json",
    };
    if (topic !== null) headers["apns-collapse-id"] = topic;
    apns = await send(`${APNS_HOSTS[allowed.environment]}/3/device/${allowed.token}`, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(APNS_TIMEOUT_MS) });
  } catch {
    return status(502);
  }
  if (apns.ok) return status(201, { ttl: String(ttl) });
  const reason = await apnsReason(apns);
  if (apns.status === 410 || (apns.status === 400 && GONE_REASONS.has(reason))) {
    await env.DB.prepare("DELETE FROM endpoints WHERE id = ?").bind(id).run();
    return status(410);
  }
  if (apns.status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")) providerToken = null;
  if (apns.status === 429) return status(429);
  return status(502);
}

export async function handle(request: Request, env: Env, now = new Date(), send: Send = fetch): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/v1/register") return register(request, env);
  const id = /^\/v1\/push\/([^/]+)$/.exec(pathname)?.[1];
  if (id !== undefined && ID.test(id)) return push(request, env, id, now, send);
  return status(404);
}

export default { fetch: (request: Request, env: Env) => handle(request, env) };
