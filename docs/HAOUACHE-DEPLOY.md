# Deploy runbook — `inbox-haouache`

> AK's fork of `cloudflare/agentic-inbox`. The plan that authored this fork
> lives at `/home/ak/.claude/plans/17-go-look-online-agile-lamport.md`.

## What this fork changes vs upstream

| File | Change |
|---|---|
| `wrangler.jsonc` | Worker name `inbox-haouache`, custom domain `inbox.haouache.com`, R2 bucket `inbox-haouache-attachments`, six `EMAIL_ADDRESSES` aliases, vars for drafter + Matrix + agentmemory |
| `workers/lib/drafter.ts` *(new)* | Dual-AI: Workers AI Kimi default, Anthropic Claude Haiku 4.5 on demand. Per-mailbox `agentDrafter` override in R2 settings. Daily Claude spend cap (default $1) tracked in R2. |
| `workers/agent/index.ts` | Both LLM call sites (`onChatMessage` + `handleNewEmail`) use `pickModel(env, mailboxHint)`. Spend recorded on Claude calls. |
| `workers/index.ts` | P2 (#32 fix) — route by SMTP envelope `event.to` instead of `parsedEmail.to[0]`. P5 (#36 fix) — clamp search query to 256 chars + escape LIKE wildcards + try/catch returning empty result. Matrix + agentmemory `ctx.waitUntil` hooks on new email. |
| `workers/sidecars/matrix.ts` *(new)* | Matrix notifier — best-effort POST per inbound email. |
| `workers/sidecars/agentmemory.ts` *(new)* | `memory_save` POST for `email_received` (and future `draft_created` / `email_sent`) events. |
| `workers/types.ts` | Adds secret-only env vars (`ANTHROPIC_API_KEY`, `MATRIX_TOKEN`, `MATRIX_ROOM_HERMES`, `AGENTMEMORY_SECRET`). Public vars are narrowed by wrangler. |
| `mcp/cf-access-client.{ts,py}` *(new)* | Bridges for Hermes (CT 121, stdlib Python) and ClaudeClaw (CT 140, Node TS) to reach `/mcp` via service tokens. |
| `scripts/provision-dns.sh` *(new)* | Idempotent MX / SPF / DKIM / DMARC + Email Routing rules via Cloudflare API. |
| `scripts/rollback.sh` *(new)* | One-command teardown. |
| `.github/workflows/{deploy,pr,upstream-sync}.yml` *(new)* | Push-to-deploy on `ak/main`, PR pre-flight, weekly upstream rebase PR. |

## Prerequisites (one-time)

1. Cloudflare account with Workers Paid ($5/mo) — `send_email` binding requires it.
2. `haouache.com` zone on the same Cloudflare account (confirmed).
3. Tokens already in workspace `/home/ak/SynologyDrive/Claude/.env`:
   - `CLOUDFLARE_API_TOKEN` (account-scope)
   - `CLOUDFLARE_DNS_TOKEN_HAOUACHE` (zone DNS + Email Routing edit)
   - `CLOUDFLARE_ZONE_HAOUACHE`
4. An Anthropic API key (for the Claude drafter path).
5. A Matrix bot access token + room ID for the Hermes room.

## Day 0 — Production cutover (~45 min)

```bash
cd ~/projects/agentic-inbox

# 1. Sanity check
npm ci
npm run typecheck
npx wrangler deploy --dry-run --outdir=/tmp/inbox-dry

# 2. Provision DNS / MX / SPF / DKIM / DMARC + Email Routing rules
#    DRY RUN FIRST.
bash scripts/provision-dns.sh --dry-run
bash scripts/provision-dns.sh

# 3. Deploy the Worker
npx wrangler deploy

# 4. Set secrets (interactive prompt each)
npx wrangler secret put POLICY_AUD          # from Cloudflare Access modal
npx wrangler secret put TEAM_DOMAIN         # from Cloudflare Access modal
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ANTHROPIC_DAILY_CAP_USD  # default 1.0
npx wrangler secret put MATRIX_TOKEN
npx wrangler secret put MATRIX_ROOM_HERMES
npx wrangler secret put AGENTMEMORY_SECRET

# 5. Enable Cloudflare Access on the Worker
#    - https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/
#    - The modal returns POLICY_AUD and TEAM_DOMAIN. If you set them in (4) BEFORE
#      enabling Access, repeat (4) with the post-enable values.

# 6. Create service tokens for Hermes (CT 121) and ClaudeClaw (CT 140)
#    Dashboard: Zero Trust → Access → Service Auth → Service Tokens
#    Issue two tokens, copy client_id + client_secret to each LXC.
#    Add a service_auth policy to the Access app for each token.

# 7. Distribute service tokens
scp /etc/cf-access/hermes.env       proxmox:/tmp/cf-access-hermes.env
ssh proxmox 'pct push 121 /tmp/cf-access-hermes.env /etc/cf-access/hermes.env && \
             pct exec 121 -- chmod 600 /etc/cf-access/hermes.env'
scp /etc/cf-access/claudeclaw.env   proxmox:/tmp/cf-access-claudeclaw.env
ssh proxmox 'pct push 140 /tmp/cf-access-claudeclaw.env /etc/cf-access/claudeclaw.env && \
             pct exec 140 -- chmod 600 /etc/cf-access/claudeclaw.env'

# 8. Deploy the MCP bridges
scp mcp/cf-access-client.py proxmox:/tmp/inbox_mcp.py
ssh proxmox 'pct push 121 /tmp/inbox_mcp.py /root/.hermes/scripts/inbox_mcp.py && \
             pct exec 121 -- chmod +x /root/.hermes/scripts/inbox_mcp.py'
scp mcp/cf-access-client.ts proxmox:/tmp/inbox-mcp.ts
ssh proxmox 'pct push 140 /tmp/inbox-mcp.ts /opt/claudeclaw/mcp_clients/inbox.ts'

# 9. Create the first mailbox
curl -s -X POST https://inbox.haouache.com/api/v1/mailboxes \
  -H "Content-Type: application/json" \
  -H "cf-access-jwt-assertion: <YOUR_SSO_JWT>" \
  -d '{"email":"agent@haouache.com","name":"Agent"}'
```

## Smoke test (after cutover)

1. From `akhaouache@gmail.com` send to `agent@haouache.com` subject `smoke 1`.
2. Within 10 s a Matrix message lands in the Hermes room.
3. From CT 121: `python3 /root/.hermes/scripts/inbox_mcp.py list_mailboxes` returns JSON listing `agent@haouache.com`.
4. From CT 121: `python3 /root/.hermes/scripts/inbox_mcp.py list_emails '{"mailboxId":"agent@haouache.com"}'` returns the smoke email.
5. From CT 121: `python3 /root/.hermes/scripts/inbox_mcp.py search_emails '{"mailboxId":"agent@haouache.com","query":"smoke"}'` — should not 500 even with long random strings (P5 patch).
6. BCC test: send to `forceraft@haouache.com` with BCC `ai@haouache.com`. Confirm the message lands in the `forceraft` mailbox only (P2 patch routes by envelope; without the patch, the BCC would have leaked).
7. Flip a mailbox to Claude:
   ```bash
   curl -s -X PUT https://inbox.haouache.com/api/v1/mailboxes/agent@haouache.com \
     -H "Content-Type: application/json" \
     -H "cf-access-jwt-assertion: <JWT>" \
     -d '{"settings":{"agentDrafter":"claude"}}'
   ```
   Send a new email — verify the auto-draft tone differs from Kimi.
8. agentmemory check:
   ```bash
   curl -s -X POST http://192.168.1.110:3121/agentmemory/mcp/call \
     -H "Authorization: Bearer $AGENTMEMORY_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"name":"memory_recall","arguments":{"query":"agentic-inbox smoke 1","limit":5}}'
   ```

## Day 2 — DMARC ramp

| Date | DMARC policy |
|---|---|
| Week 0 (cutover) | `p=quarantine; pct=10` (set by provision-dns.sh) |
| Week 2 | `p=quarantine; pct=100` |
| Week 4 | `p=reject` |

Each step: edit `provision-dns.sh` DMARC line, rerun. Idempotent. The script will update the TXT in place.

## Rollback (5 min)

```bash
cd ~/projects/agentic-inbox
DRY_RUN=1 bash scripts/rollback.sh   # confirm what it will do
bash scripts/rollback.sh             # type 'rollback' at the prompt
```

Gmail accounts and `email-triage.ts` are untouched throughout.

## Service-token rotation (quarterly)

Cloudflare service tokens have unlimited lifetime by default; rotate to limit blast radius if a token leaks.

```bash
# 1. Create a new token in Cloudflare dashboard (Zero Trust → Service Auth)
# 2. Push the new client_id/client_secret to the LXC's /etc/cf-access/*.env
# 3. Wait for the next MCP call to verify
# 4. Delete the old token in the dashboard
```

## OpenProject WP closure on GO

When the live smoke test passes, mark these WPs Closed:
- WP#2079 (Email Routing) — link to the actual MX records
- WP#2080 (Deploy) — link to https://inbox.haouache.com
- WP#2081 (MCP integration) — link to the smoke test output

WP#2078 (Research) — closed by the plan file + research report.
WP#2082 (AI draft quality) — keep open, log 2-week draft-quality findings in `docs/draft-quality-log.md` before closing.
WP#2083 (Cost analysis) — close once one full month of Cloudflare + Anthropic spend is in.
WP#2084 (GO/NO-GO) — flip to **GO with conditions**: the conditions are this fork.
