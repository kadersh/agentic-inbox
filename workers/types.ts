// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;

	// Fork additions — secrets only. Public vars (DEFAULT_DRAFTER,
	// MATRIX_HOMESERVER, AGENTMEMORY_URL) live in wrangler.jsonc and get
	// narrowed to literal types automatically by `wrangler types`.
	ANTHROPIC_API_KEY?: string;
	ANTHROPIC_DAILY_CAP_USD?: string;
	MATRIX_TOKEN?: string;
	MATRIX_ROOM_HERMES?: string;
	AGENTMEMORY_SECRET?: string;
}
