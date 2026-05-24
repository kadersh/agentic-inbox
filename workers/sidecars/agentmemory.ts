/**
 * agentmemory sync — push inbox lifecycle events to the cross-agent memory
 * service so Hermes (CT 121) and ClaudeClaw (CT 140) can recall them.
 *
 * Endpoint: POST {AGENTMEMORY_URL}/agentmemory/mcp/call with body
 *   { name: "memory_save", arguments: {...} }
 * Bearer auth via AGENTMEMORY_SECRET.
 *
 * Every call is best-effort and wrapped in waitUntil by the caller. We never
 * block email handling on memory persistence.
 */
import type { Env } from "../types";

export type InboxEvent =
	| "email_received"
	| "draft_created"
	| "email_sent"
	| "draft_discarded";

export interface MemorySaveInput {
	event: InboxEvent;
	mailboxId: string;
	emailId?: string;
	threadId?: string;
	subject?: string;
	sender?: string;
	recipient?: string;
	summary?: string;
	model?: string;
	tags?: string[];
}

export async function syncToMemory(env: Env, input: MemorySaveInput): Promise<void> {
	const baseUrl = env.AGENTMEMORY_URL;
	const secret = env.AGENTMEMORY_SECRET;
	if (!baseUrl || !secret) return;

	const observation = buildObservation(input);
	const tags = Array.from(
		new Set([
			"inbox",
			"agentic-inbox",
			input.event,
			input.mailboxId,
			...(input.tags ?? []),
		]),
	);

	const payload = {
		name: "memory_save",
		arguments: {
			observation,
			tags,
			importance: importanceFor(input.event),
			agent_origin: "agentic-inbox",
			type: "inbox_event",
			metadata: {
				event: input.event,
				mailboxId: input.mailboxId,
				emailId: input.emailId,
				threadId: input.threadId,
				model: input.model,
				occurred_at: new Date().toISOString(),
			},
		},
	};

	try {
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/agentmemory/mcp/call`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${secret}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			console.warn(
				`agentmemory sync failed: ${res.status} ${await res.text().catch(() => "")}`,
			);
		}
	} catch (e) {
		console.warn("agentmemory sync threw:", (e as Error).message);
	}
}

function buildObservation(i: MemorySaveInput): string {
	const parts: string[] = [];
	parts.push(`[${i.event}]`);
	parts.push(`mailbox=${i.mailboxId}`);
	if (i.sender) parts.push(`from=${i.sender}`);
	if (i.recipient) parts.push(`to=${i.recipient}`);
	if (i.subject) parts.push(`subject="${i.subject}"`);
	if (i.threadId) parts.push(`thread=${i.threadId}`);
	if (i.model) parts.push(`model=${i.model}`);
	if (i.summary) {
		parts.push("");
		parts.push(i.summary);
	}
	return parts.join(" ").trim();
}

function importanceFor(event: InboxEvent): number {
	switch (event) {
		case "email_sent":
			return 0.8;
		case "draft_created":
			return 0.5;
		case "email_received":
			return 0.4;
		case "draft_discarded":
			return 0.2;
	}
}
