/**
 * Minimal MCP client for inbox.haouache.com over Cloudflare Access service
 * tokens. Used by ClaudeClaw (CT 140) and the workspace.
 *
 * Auth: inject `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers.
 * Reads credentials from /etc/cf-access/<NAME>.env (KEY=value pairs) so
 * tokens never live alongside source.
 *
 * Usage:
 *   import { InboxClient } from "./cf-access-client";
 *   const inbox = await InboxClient.fromEnvFile("/etc/cf-access/claudeclaw.env");
 *   const { tools } = await inbox.listTools();
 *   const result = await inbox.callTool("list_mailboxes", {});
 */
import { readFile } from "node:fs/promises";

export interface InboxClientOpts {
	baseUrl?: string; // default https://inbox.haouache.com
	clientId: string;
	clientSecret: string;
	fetchImpl?: typeof fetch;
}

export class InboxClient {
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;
	private readonly fetchImpl: typeof fetch;
	private requestId = 0;

	constructor(opts: InboxClientOpts) {
		this.baseUrl = (opts.baseUrl ?? "https://inbox.haouache.com").replace(/\/$/, "");
		this.headers = {
			"CF-Access-Client-Id": opts.clientId,
			"CF-Access-Client-Secret": opts.clientSecret,
			"Content-Type": "application/json",
			Accept: "application/json,text/event-stream",
		};
		this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
	}

	/** Load creds from a KEY=value env file. Tolerates blank lines and `#` comments. */
	static async fromEnvFile(path: string, baseUrl?: string): Promise<InboxClient> {
		const raw = await readFile(path, "utf8");
		const env: Record<string, string> = {};
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq < 0) continue;
			env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
		}
		const clientId = env.CF_ACCESS_CLIENT_ID ?? env.ACCESS_CLIENT_ID;
		const clientSecret = env.CF_ACCESS_CLIENT_SECRET ?? env.ACCESS_CLIENT_SECRET;
		if (!clientId || !clientSecret) {
			throw new Error(`Missing CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET in ${path}`);
		}
		return new InboxClient({ baseUrl, clientId, clientSecret });
	}

	private async rpc(method: string, params?: Record<string, unknown>) {
		this.requestId += 1;
		const res = await this.fetchImpl(`${this.baseUrl}/mcp`, {
			method: "POST",
			headers: this.headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: this.requestId,
				method,
				params: params ?? {},
			}),
		});
		if (!res.ok) {
			throw new Error(`Inbox MCP ${method} failed: ${res.status} ${await res.text()}`);
		}
		const text = await res.text();
		// MCP servers commonly speak SSE; pluck the data: line when needed.
		const lines = text.split("\n").filter((l) => l.startsWith("data: "));
		const payload = lines.length > 0 ? JSON.parse(lines[lines.length - 1].slice(6)) : JSON.parse(text);
		if (payload.error) {
			throw new Error(`Inbox MCP ${method} error: ${payload.error.message ?? JSON.stringify(payload.error)}`);
		}
		return payload.result;
	}

	listTools() {
		return this.rpc("tools/list");
	}

	callTool(name: string, args: Record<string, unknown>) {
		return this.rpc("tools/call", { name, arguments: args });
	}

	ping() {
		return this.rpc("ping");
	}
}
