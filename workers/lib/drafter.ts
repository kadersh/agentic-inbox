/**
 * Drafter — selects which LLM the email Agent uses for drafting.
 *
 * Two providers, both surfaced through the AI SDK v6 abstraction so the
 * agent code stays single-shape:
 *   - "kimi"   → Workers AI @cf/moonshotai/kimi-k2.5 (default, free under quota)
 *   - "claude" → Anthropic Claude Haiku 4.5 (better quality, costs per-token)
 *
 * Selection precedence: per-mailbox `agentDrafter` setting (R2 settings JSON)
 * > worker var DEFAULT_DRAFTER > "kimi". A daily spend cap on Anthropic
 * forces "kimi" fallback when exceeded.
 */
import { createWorkersAI } from "workers-ai-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import type { Env } from "../types";

export type DrafterChoice = "kimi" | "claude";

const KIMI_MODEL = "@cf/moonshotai/kimi-k2.5" as const;
const CLAUDE_MODEL = "claude-haiku-4-5" as const;

// Anthropic Haiku 4.5 list prices (USD per 1M tokens) — adjust if Anthropic re-prices.
const CLAUDE_INPUT_USD_PER_MTOK = 0.8;
const CLAUDE_OUTPUT_USD_PER_MTOK = 4.0;

const DEFAULT_DAILY_CAP_USD = 1.0;
const SPEND_KEY = (date: string) => `meta/spend/claude/${date}.json`;

function todayUTC(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve the desired drafter for this call. Considers per-mailbox preference,
 * the worker default, and the current Claude daily spend cap. Falls back to
 * Kimi whenever Claude is unavailable for any reason.
 */
export async function resolveDrafter(
	env: Env,
	mailboxHint?: DrafterChoice | null,
): Promise<{ choice: DrafterChoice; reason: string }> {
	// DEFAULT_DRAFTER is narrowed to its current literal value by wrangler
	// types, but the value is dynamic at runtime — read through a widened
	// string before comparing so flipping it in wrangler.jsonc takes effect
	// without a type bump.
	const defaultDrafter = (env as unknown as { DEFAULT_DRAFTER?: string }).DEFAULT_DRAFTER;
	const desired: DrafterChoice =
		mailboxHint === "claude" || mailboxHint === "kimi"
			? mailboxHint
			: defaultDrafter === "claude"
				? "claude"
				: "kimi";

	if (desired !== "claude") {
		return { choice: "kimi", reason: "default" };
	}

	if (!env.ANTHROPIC_API_KEY) {
		console.warn("Drafter: ANTHROPIC_API_KEY not configured, falling back to kimi");
		return { choice: "kimi", reason: "no_anthropic_key" };
	}

	const cap = Number(env.ANTHROPIC_DAILY_CAP_USD ?? DEFAULT_DAILY_CAP_USD);
	const spent = await getDailySpend(env);
	if (spent >= cap) {
		console.warn(
			`Drafter: Claude daily cap reached ($${spent.toFixed(2)}/$${cap.toFixed(2)}), falling back to kimi`,
		);
		return { choice: "kimi", reason: "spend_cap" };
	}

	return { choice: "claude", reason: "selected" };
}

/**
 * Materialise the AI SDK v6 language model for a given drafter choice.
 * The result drops cleanly into `streamText({ model, ... })` / `generateText({ model, ... })`.
 */
export function modelFor(env: Env, choice: DrafterChoice): LanguageModel {
	if (choice === "claude") {
		const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY! });
		return anthropic(CLAUDE_MODEL);
	}
	const workersai = createWorkersAI({ binding: env.AI });
	return workersai(KIMI_MODEL);
}

/**
 * Convenience: resolve and materialise in one call. Returns both the model
 * and the choice/reason for logging.
 */
export async function pickModel(
	env: Env,
	mailboxHint?: DrafterChoice | null,
): Promise<{ model: LanguageModel; choice: DrafterChoice; reason: string }> {
	const { choice, reason } = await resolveDrafter(env, mailboxHint);
	return { model: modelFor(env, choice), choice, reason };
}

/**
 * Read today's running Claude spend in USD from R2. Returns 0 on miss or
 * any parse error — fail open so a transient R2 issue never blocks drafting,
 * just risks a single over-cap call before the next write succeeds.
 */
export async function getDailySpend(env: Env): Promise<number> {
	try {
		const obj = await env.BUCKET.get(SPEND_KEY(todayUTC()));
		if (!obj) return 0;
		const data = (await obj.json()) as { usd?: number };
		return typeof data.usd === "number" ? data.usd : 0;
	} catch (e) {
		console.warn("Drafter: spend read failed", (e as Error).message);
		return 0;
	}
}

/**
 * Record token usage from a completed Claude call. Best-effort — failures
 * are logged but don't surface. Race-condition tolerant: an interleaved
 * write may lose at most one call's increment, acceptable for a $1 daily
 * cap that's a soft brake, not a hard budget.
 */
export async function recordClaudeUsage(
	env: Env,
	usage: { inputTokens?: number; outputTokens?: number },
): Promise<void> {
	const input = usage.inputTokens ?? 0;
	const output = usage.outputTokens ?? 0;
	if (input === 0 && output === 0) return;
	const cost =
		(input / 1_000_000) * CLAUDE_INPUT_USD_PER_MTOK +
		(output / 1_000_000) * CLAUDE_OUTPUT_USD_PER_MTOK;
	try {
		const key = SPEND_KEY(todayUTC());
		const existing = await getDailySpend(env);
		const next = existing + cost;
		await env.BUCKET.put(
			key,
			JSON.stringify({
				usd: next,
				updated_at: new Date().toISOString(),
				last_call: { input, output, cost_usd: cost },
			}),
		);
	} catch (e) {
		console.warn("Drafter: spend write failed", (e as Error).message);
	}
}

/**
 * Read the per-mailbox drafter preference from R2 settings JSON.
 * Returns null when unset / parse fails — caller falls back to env default.
 */
export async function readMailboxDrafter(
	env: Env,
	mailboxId: string,
): Promise<DrafterChoice | null> {
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		if (!obj) return null;
		const settings = (await obj.json()) as { agentDrafter?: string };
		if (settings.agentDrafter === "claude" || settings.agentDrafter === "kimi") {
			return settings.agentDrafter;
		}
		return null;
	} catch {
		return null;
	}
}
