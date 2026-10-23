# Push relay

The Cloudflare Worker that carries the PC's alerts to the Ovis phone app, at `push.ovis.sh`.
A WKWebView app gets no Web Push, so the relay stands in for a browser's push service: to the
PC's `server/push.ts` it is one more Web Push endpoint, and it hands each push to Apple's push
service (APNs). Why and how it fits the app: [docs/native-app.md](../docs/native-app.md#notifications).

Pushes are end-to-end encrypted. The PC encrypts each alert for keys the app made and keeps in
its keychain (RFC 8291), and the relay forwards the ciphertext as it came; it never holds a key
that could read it. The app's Notification Service Extension decrypts it on the phone.

## What it answers

`POST /v1/register` (the app), with `Content-Type: application/json`:

```json
{ "token": "<APNs device token, hex>", "environment": "production" }
```

`environment` is `production` (the default) or `sandbox`, for a token from a development build.
The answer is `201` with `{ "endpoint": "https://push.ovis.sh/v1/push/<id>" }`, where `<id>` is
random and stands for the token: the token itself never leaves the relay. Every registration makes
a new endpoint, because each PC pins its own key to the one it is given. The app registers once
per PC and keeps that endpoint (with the keys it made for it), rather than registering at every
launch: a token keeps its newest 32 endpoints, and registering a 33rd drops the oldest.

`POST /v1/push/<id>` (the PC) is a Web Push request (RFC 8030): an `aes128gcm` body of at most
4096 bytes, a `TTL` header, optionally `Urgency` and `Topic`, and a VAPID `Authorization: vapid
t=..., k=...` header (RFC 8292) whose token names this relay's origin as its audience.

- The first VAPID key that pushes to an endpoint is pinned to it. A push signed by any other key
  is refused (`403`), so knowing an endpoint is not enough to send to a phone. A missing, expired
  or forged token is `401`.
- An endpoint takes at most 60 pushes per 10 minutes; past that it answers `429` with
  `Retry-After` until the window ends. A refused push does not count.
- The push goes to APNs as a `mutable-content` alert:
  `{"aps":{"alert":{"body":"herdr needs you"},"mutable-content":1},"ovis":"<ciphertext, base64>"}`.
  The extension replaces the alert with the decrypted title and body; the line in `aps` is what
  the phone shows when it cannot. `Urgency: high` becomes APNs priority 10 (any other, 5), `TTL`
  becomes `apns-expiration` (at most 28 days; `0` delivers now or never), and `Topic` becomes
  `apns-collapse-id`, so a newer push with the same topic replaces one still waiting.
- The answer is `201` once APNs takes the push. APNs saying the token is gone (`410`, or `400`
  with `BadDeviceToken` or `DeviceTokenNotForTopic`) deletes the endpoint and answers `410`, which
  the PC takes as an unsubscribe; an unknown endpoint is `404`, which it takes the same way. A
  body that no longer fits APNs' 4 KB once base64-encoded is `413`, a content encoding other than
  `aes128gcm` is `415`, APNs throttling the device is `429`, and any other APNs failure is `502`.

## What it keeps

One D1 table (`schema.sql`), one row per endpoint: the random ID, the device token, its APNs
environment, the pinned VAPID public key, and the start and count of the current rate window.
Nothing of what a push said, no time of registration, and no address: the Worker never reads the
sender's address or any header beyond those above, and Workers Logs are off (`wrangler.toml`),
so no request log keeps the address either.

## Deploy

The relay needs the `ovis.sh` zone on the Cloudflare account it deploys to (the route in
`wrangler.toml` makes `push.ovis.sh` a custom domain of the Worker), and an APNs auth key
(a `.p8` file) from the Apple developer account that owns `sh.ovis.app`. Create the database and
apply the schema once:

```sh
cd push-relay
bunx wrangler login
bunx wrangler d1 create ovis-push-relay   # then put its database_id in wrangler.toml and commit it
bunx wrangler d1 execute ovis-push-relay --remote --file schema.sql
```

The APNs credentials are Worker secrets, never files in the repository:

| Secret | Value |
|---|---|
| `APNS_KEY` | the whole `.p8` file, `-----BEGIN PRIVATE KEY-----` lines included |
| `APNS_KEY_ID` | the key's ID, as Apple's developer site shows it |
| `APNS_TEAM_ID` | the ID of the team the key belongs to |

```sh
bunx wrangler secret put APNS_KEY < AuthKey_XXXXXXXXXX.p8
bunx wrangler secret put APNS_KEY_ID
bunx wrangler secret put APNS_TEAM_ID
bunx wrangler deploy
```

`APNS_TOPIC` in `wrangler.toml` is the app's bundle ID (`sh.ovis.app`). One key pushes to both
APNs environments; a registration says which one its token belongs to.

## Running your own

The relay is open so anyone can run one: change `name`, the route and `APNS_TOPIC` in
`wrangler.toml` to your own domain and app, and follow the steps above with your own Cloudflare
and Apple accounts. Endpoints name the origin the registration came to, so they follow the
domain without a code change.

## Tests

`bun test ./push-relay` from the repository root. The tests sign and encrypt pushes with
`web-push`, as `server/push.ts` does, and run the Worker over a real SQLite table built from
`schema.sql` and a fake APNs. They run in CI in the Push relay workflow
(`.github/workflows/push-relay.yml`); the typecheck runs in Fast checks.
