/**
 * Matrix notifier — fan out new-email events to a Matrix room so AK sees
 * `agent@haouache.com` traffic alongside everything else from Hermes.
 *
 * Wired from `receiveEmail` via `ctx.waitUntil`. Failures log and swallow:
 * email handling must never block on Matrix being reachable.
 */
import type { Env } from "../types";

export interface MatrixNotifyPayload {
	mailboxId: string;
	sender: string;
	subject: string;
	threadId: string;
	emailId: string;
	bodyPreview?: string;
}

export async function notifyMatrix(env: Env, payload: MatrixNotifyPayload): Promise<void> {
	const homeserver = env.MATRIX_HOMESERVER;
	const token = env.MATRIX_TOKEN;
	const room = env.MATRIX_ROOM_HERMES;
	if (!homeserver || !token || !room) {
		// Not configured — silently skip (dev / not-yet-provisioned).
		return;
	}

	const txnId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
	const url = `${homeserver.replace(/\/$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txnId}`;

	const body = `📬 *${payload.mailboxId}* — new email from ${payload.sender}\n**${escapeMd(payload.subject || "(no subject)")}**${payload.bodyPreview ? `\n\n${escapeMd(payload.bodyPreview)}` : ""}`;

	try {
		const res = await fetch(url, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				msgtype: "m.text",
				body,
				format: "org.matrix.custom.html",
				formatted_body: renderHtml(payload),
			}),
		});
		if (!res.ok) {
			console.warn(
				`Matrix notify failed: ${res.status} ${await res.text().catch(() => "")}`,
			);
		}
	} catch (e) {
		console.warn("Matrix notify threw:", (e as Error).message);
	}
}

function escapeMd(s: string): string {
	return s.replace(/[\\`*_{}\[\]()#+\-.!]/g, "\\$&");
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function renderHtml(p: MatrixNotifyPayload): string {
	const subject = escapeHtml(p.subject || "(no subject)");
	const sender = escapeHtml(p.sender);
	const mailbox = escapeHtml(p.mailboxId);
	const preview = p.bodyPreview ? `<br/><blockquote>${escapeHtml(p.bodyPreview)}</blockquote>` : "";
	return `📬 <b>${mailbox}</b> — new email from ${sender}<br/><b>${subject}</b>${preview}`;
}
