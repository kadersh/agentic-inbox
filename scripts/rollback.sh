#!/usr/bin/env bash
# Single-command teardown for inbox-haouache.
#
# Removes:
#   - Worker `inbox-haouache` (wrangler delete)
#   - All MX, SPF, DMARC, DKIM records on haouache.com
#   - Email Routing rules + disabled
#
# Gmail accounts and ak-assistant's email-triage.ts are untouched.
# Total propagation time ≤10 min (Cloudflare MX TTL is 5 min).

set -Eeuo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN="${DRY_RUN:-0}"

log() { printf '[rollback] %s\n' "$*"; }

if [[ "$DRY_RUN" -ne 1 ]]; then
	read -r -p "This will delete the inbox-haouache Worker and purge haouache.com email DNS. Type 'rollback' to confirm: " confirm
	[[ "$confirm" == "rollback" ]] || { log "Aborted."; exit 1; }
fi

log "1/3 — Deleting Worker inbox-haouache"
if [[ "$DRY_RUN" -eq 1 ]]; then
	log "  DRY-RUN: npx wrangler delete --name inbox-haouache"
else
	(cd "$DIR/.." && npx wrangler delete --name inbox-haouache) || log "  Worker delete returned non-zero (may already be gone)"
fi

log "2/3 — Purging DNS (MX, SPF, DMARC, DKIM)"
DRY_FLAG=""
[[ "$DRY_RUN" -eq 1 ]] && DRY_FLAG="--dry-run"
bash "$DIR/provision-dns.sh" $DRY_FLAG --purge-mx --purge-spf --purge-dmarc --purge-dkim

log "3/3 — Disabling Email Routing"
bash "$DIR/provision-dns.sh" $DRY_FLAG --disable-email-routing

log "Done. Verify with: dig MX haouache.com  (expect empty)"
