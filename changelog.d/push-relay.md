### Maintenance
- The phone app's push relay, a Cloudflare Worker for `push.ovis.sh`, is in `push-relay/` with its
  tests: it forwards the PC's end-to-end encrypted alerts to Apple's push service without being
  able to read them, pins each endpoint to the first PC key that pushes to it, and rate-limits
  every endpoint. It is not deployed yet.
