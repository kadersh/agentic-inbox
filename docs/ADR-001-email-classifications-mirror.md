# ADR-001 — Defer mirroring `agentic-inbox` events into ak-assistant `email_classifications`

- **Status**: Accepted (2026-05-24)
- **Context**: ak-assistant's `email-triage.ts` writes every email it processes
  into the `email_classifications` Postgres table, then forwards Finance /
  Receipts to Paperless → Firefly. The original plan considered adding a
  third sidecar to `agentic-inbox` that would POST a mirror event into the
  same table whenever a haouache.com alias received mail.
- **Decision**: Do not add the mirror in the initial deploy. Revisit only if
  AK starts routing a "finance@haouache.com"-style address to the Inbox.
- **Reasons**:
  1. The catch-all rule forwards all unrecognised `*@haouache.com` mail to
     `akhaouache@gmail.com`, which `email-triage.ts` already reads. The
     Paperless / Firefly pipeline keeps working unmodified.
  2. The six aliases that DO route to the Worker (`agent`, `ai`, `inbox`,
     `hermes`, `support`, `forceraft`) are agent-driven and shouldn't be
     auto-creating Firefly transactions.
  3. Cross-network coupling: the Worker would need to reach Postgres on the
     home VM through a Cloudflare Tunnel, doubling the failure modes. The
     agentmemory sidecar already gives Hermes/ClaudeClaw visibility without
     touching `email_classifications`.
- **Trigger to revisit**: AK adds a finance-style address to the Inbox, OR
  Hermes/ClaudeClaw starts needing structured triage history for haouache.com
  traffic.
