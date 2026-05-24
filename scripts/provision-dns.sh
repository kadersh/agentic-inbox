#!/usr/bin/env bash
# Provision DNS / MX / SPF / DKIM / DMARC + Cloudflare Email Routing rules
# for the inbox-haouache Worker.
#
# Idempotent: re-running with the same args reconciles state. Safe to dry-run
# first with --dry-run.
#
# Requires:
#   - jq, curl
#   - env vars: CLOUDFLARE_DNS_TOKEN_HAOUACHE (or CLOUDFLARE_API_TOKEN), CLOUDFLARE_ZONE_HAOUACHE
#     loaded from /home/ak/SynologyDrive/Claude/.env or the shell.
#
# Flags:
#   --dry-run                show planned mutations without executing
#   --purge-mx               delete all MX records on the zone
#   --purge-spf              delete SPF TXT at apex
#   --purge-dmarc            delete _dmarc TXT
#   --purge-dkim             delete cf2024-1._domainkey CNAME
#   --disable-email-routing  disable email routing entirely
#   --catchall-target ADDR   set catch-all forward target (default akhaouache@gmail.com)
#
# All operations require WRITE scopes: Zone:DNS Edit, Zone:Email Routing.

set -Eeuo pipefail

ENV_FILE="${ENV_FILE:-/home/ak/SynologyDrive/Claude/.env}"
WORKER_NAME="${WORKER_NAME:-inbox-haouache}"
CATCHALL_TARGET="akhaouache@gmail.com"
DRY_RUN=0
PURGE_MX=0
PURGE_SPF=0
PURGE_DMARC=0
PURGE_DKIM=0
DISABLE_ER=0

ALIASES=(
	"agent@haouache.com"
	"ai@haouache.com"
	"inbox@haouache.com"
	"hermes@haouache.com"
	"support@haouache.com"
	"forceraft@haouache.com"
	"dmarc@haouache.com"
)

log()  { printf '[provision] %s\n' "$*"; }
warn() { printf '[provision] WARN: %s\n' "$*" >&2; }
die()  { printf '[provision] ERROR: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dry-run)               DRY_RUN=1 ;;
		--purge-mx)              PURGE_MX=1 ;;
		--purge-spf)             PURGE_SPF=1 ;;
		--purge-dmarc)           PURGE_DMARC=1 ;;
		--purge-dkim)            PURGE_DKIM=1 ;;
		--disable-email-routing) DISABLE_ER=1 ;;
		--catchall-target)       shift; CATCHALL_TARGET="$1" ;;
		-h|--help)
			sed -n '2,28p' "$0"; exit 0 ;;
		*) die "Unknown flag: $1" ;;
	esac
	shift
done

# Load env file if present
if [[ -f "$ENV_FILE" ]]; then
	# shellcheck disable=SC2046
	set -a
	# Only export variables we care about, ignoring noisy file
	eval "$(grep -E '^(CLOUDFLARE_DNS_TOKEN_HAOUACHE|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ZONE_HAOUACHE)=' "$ENV_FILE" || true)"
	set +a
fi

TOKEN="${CLOUDFLARE_DNS_TOKEN_HAOUACHE:-${CLOUDFLARE_API_TOKEN:-}}"
ZONE="${CLOUDFLARE_ZONE_HAOUACHE:-}"
[[ -n "$TOKEN" ]] || die "CLOUDFLARE_DNS_TOKEN_HAOUACHE (or CLOUDFLARE_API_TOKEN) is required"
[[ -n "$ZONE"  ]] || die "CLOUDFLARE_ZONE_HAOUACHE is required"

API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

cf() {
	# cf METHOD PATH [BODY_FILE]
	local method="$1" path="$2" body="${3:-}"
	if [[ "$DRY_RUN" -eq 1 && "$method" != "GET" ]]; then
		log "DRY-RUN $method $path${body:+ (body in $body)}"
		[[ -n "$body" ]] && cat "$body" >&2
		printf '{"success":true,"result":{}}\n'
		return 0
	fi
	if [[ -n "$body" ]]; then
		curl -fsS "${AUTH[@]}" -X "$method" "$API$path" --data-binary "@$body"
	else
		curl -fsS "${AUTH[@]}" -X "$method" "$API$path"
	fi
}

require_success() {
	local resp="$1" what="$2"
	echo "$resp" | jq -e '.success == true' >/dev/null \
		|| { echo "$resp" >&2; die "$what failed"; }
}

# Resolve account id (needed for Email Routing destination addresses)
ZONE_INFO=$(cf GET "/zones/$ZONE")
require_success "$ZONE_INFO" "zone lookup"
ACCOUNT_ID=$(echo "$ZONE_INFO" | jq -r '.result.account.id')
ZONE_NAME=$(echo "$ZONE_INFO" | jq -r '.result.name')
log "Zone $ZONE_NAME (account $ACCOUNT_ID)"

# ── DNS helpers ─────────────────────────────────────────────────────

list_dns() {
	# list_dns TYPE NAME [CONTENT]
	local type="$1" name="$2" content="${3:-}"
	local query="type=$type&name=$name"
	[[ -n "$content" ]] && query="$query&content=$(printf '%s' "$content" | jq -sRr @uri)"
	cf GET "/zones/$ZONE/dns_records?$query&per_page=100"
}

ensure_dns() {
	# ensure_dns TYPE NAME CONTENT [PRIORITY]
	local type="$1" name="$2" content="$3" priority="${4:-}"
	local body; body=$(mktemp)
	jq -n --arg type "$type" --arg name "$name" --arg content "$content" \
		--argjson priority "${priority:-null}" \
		'{type: $type, name: $name, content: $content}
		 + (if $priority then {priority: $priority} else {} end)
		 + {ttl: 1, proxied: false}' > "$body"

	local existing
	existing=$(list_dns "$type" "$name" "$content")
	require_success "$existing" "list $type $name"
	local existing_id
	existing_id=$(echo "$existing" | jq -r '.result[0].id // empty')
	if [[ -n "$existing_id" ]]; then
		log "  ✓ $type $name already exists ($existing_id)"
	else
		log "  + creating $type $name = $content${priority:+ priority $priority}"
		local resp; resp=$(cf POST "/zones/$ZONE/dns_records" "$body")
		require_success "$resp" "create $type $name"
	fi
	rm -f "$body"
}

purge_dns() {
	# purge_dns TYPE NAME
	local type="$1" name="$2"
	local list; list=$(list_dns "$type" "$name")
	require_success "$list" "list $type $name"
	echo "$list" | jq -r '.result[].id' | while read -r id; do
		[[ -z "$id" ]] && continue
		log "  - deleting $type $name ($id)"
		cf DELETE "/zones/$ZONE/dns_records/$id" >/dev/null
	done
}

# ── Cloudflare Email Routing helpers ────────────────────────────────

ensure_destination() {
	# ensure_destination EMAIL
	local addr="$1"
	local existing
	existing=$(cf GET "/accounts/$ACCOUNT_ID/email/routing/addresses?per_page=100")
	require_success "$existing" "list destinations"
	if echo "$existing" | jq -e --arg a "$addr" '.result[] | select(.email == $a)' >/dev/null; then
		log "  ✓ destination $addr already exists"
		return 0
	fi
	local body; body=$(mktemp)
	jq -n --arg email "$addr" '{email: $email}' > "$body"
	log "  + creating destination $addr (you must click the verify link in $addr's inbox)"
	cf POST "/accounts/$ACCOUNT_ID/email/routing/addresses" "$body" | jq -r '.result.email // .errors[0].message'
	rm -f "$body"
}

ensure_alias_rule() {
	# ensure_alias_rule ALIAS WORKER
	local alias="$1" worker="$2"
	local existing
	existing=$(cf GET "/zones/$ZONE/email/routing/rules?per_page=200")
	require_success "$existing" "list rules"
	local id
	id=$(echo "$existing" | jq -r --arg a "$alias" '.result[] | select(.matchers[0].type == "literal" and .matchers[0].value == $a) | .tag')
	local body; body=$(mktemp)
	jq -n --arg alias "$alias" --arg worker "$worker" \
		'{name: ("Route " + $alias + " to Worker"),
		  enabled: true,
		  priority: 0,
		  matchers: [{type: "literal", field: "to", value: $alias}],
		  actions: [{type: "worker", value: [$worker]}]}' > "$body"
	if [[ -n "$id" ]]; then
		log "  ~ updating rule $alias → worker:$worker"
		cf PUT "/zones/$ZONE/email/routing/rules/$id" "$body" >/dev/null
	else
		log "  + creating rule $alias → worker:$worker"
		cf POST "/zones/$ZONE/email/routing/rules" "$body" >/dev/null
	fi
	rm -f "$body"
}

ensure_catchall_rule() {
	# ensure_catchall_rule DESTINATION
	local dest="$1"
	local existing
	existing=$(cf GET "/zones/$ZONE/email/routing/rules/catch_all")
	require_success "$existing" "fetch catch-all"
	local body; body=$(mktemp)
	jq -n --arg dest "$dest" \
		'{name: "Catch-all forward",
		  enabled: true,
		  matchers: [{type: "all"}],
		  actions: [{type: "forward", value: [$dest]}]}' > "$body"
	log "  ~ catch-all → forward $dest"
	cf PUT "/zones/$ZONE/email/routing/rules/catch_all" "$body" >/dev/null
	rm -f "$body"
}

# ── Purge mode ──────────────────────────────────────────────────────

if [[ "$PURGE_MX" -eq 1 ]]; then
	log "Purging MX records on $ZONE_NAME"
	purge_dns MX "$ZONE_NAME"
fi
if [[ "$PURGE_SPF" -eq 1 ]]; then
	log "Purging SPF TXT at apex"
	# SPF is a TXT record at the apex containing v=spf1. Filter by content.
	apex_txt=$(list_dns TXT "$ZONE_NAME")
	echo "$apex_txt" | jq -r '.result[] | select(.content | startswith("v=spf1")) | .id' | while read -r id; do
		[[ -z "$id" ]] && continue
		log "  - deleting SPF TXT ($id)"
		cf DELETE "/zones/$ZONE/dns_records/$id" >/dev/null
	done
fi
if [[ "$PURGE_DMARC" -eq 1 ]]; then
	log "Purging _dmarc TXT"
	purge_dns TXT "_dmarc.$ZONE_NAME"
fi
if [[ "$PURGE_DKIM" -eq 1 ]]; then
	log "Purging cf2024-1._domainkey CNAME"
	purge_dns CNAME "cf2024-1._domainkey.$ZONE_NAME"
fi
if [[ "$DISABLE_ER" -eq 1 ]]; then
	log "Disabling Email Routing"
	cf POST "/zones/$ZONE/email/routing/disable" >/dev/null || warn "disable returned non-success"
fi
if [[ "$PURGE_MX" -eq 1 || "$PURGE_SPF" -eq 1 || "$PURGE_DMARC" -eq 1 || "$PURGE_DKIM" -eq 1 || "$DISABLE_ER" -eq 1 ]]; then
	log "Purge complete. Stopping (purge runs are not paired with provisioning)."
	exit 0
fi

# ── Provision ───────────────────────────────────────────────────────

log "Enabling Email Routing (idempotent)"
cf POST "/zones/$ZONE/email/routing/enable" >/dev/null || warn "enable returned non-success (likely already enabled)"

log "MX records → route1/2/3.mx.cloudflare.net"
ensure_dns MX "$ZONE_NAME" "route1.mx.cloudflare.net" 10
ensure_dns MX "$ZONE_NAME" "route2.mx.cloudflare.net" 20
ensure_dns MX "$ZONE_NAME" "route3.mx.cloudflare.net" 30

log "SPF TXT at apex"
ensure_dns TXT "$ZONE_NAME" "v=spf1 include:_spf.mx.cloudflare.net ~all"

log "DMARC TXT (ramp p=quarantine 10%; raise to reject after 4 weeks clean)"
ensure_dns TXT "_dmarc.$ZONE_NAME" "v=DMARC1; p=quarantine; pct=10; rua=mailto:dmarc@haouache.com; adkim=s; aspf=s"

log "DKIM CNAME (Cloudflare auto-rotates the underlying key)"
ensure_dns CNAME "cf2024-1._domainkey.$ZONE_NAME" "cf2024-1._domainkey.cloudflare.net"

log "Catch-all destination + forward to $CATCHALL_TARGET"
ensure_destination "$CATCHALL_TARGET"
ensure_catchall_rule "$CATCHALL_TARGET"

log "Worker alias routing rules → $WORKER_NAME"
for alias in "${ALIASES[@]}"; do
	ensure_alias_rule "$alias" "$WORKER_NAME"
done

log "Done. Verify with: dig MX $ZONE_NAME ; dig TXT _dmarc.$ZONE_NAME"
