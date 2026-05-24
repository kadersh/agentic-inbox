#!/usr/bin/env python3
"""Minimal MCP client for inbox.haouache.com over Cloudflare Access service
tokens. Used by Hermes on CT 121 (stdlib only — matches gmail_helper.py).

Auth: inject `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers from
/etc/cf-access/hermes.env (KEY=value pairs). Tokens never live in source.

Usage from another script:
    from cf_access_client import InboxClient
    inbox = InboxClient.from_env_file("/etc/cf-access/hermes.env")
    print(inbox.list_tools())
    print(inbox.call_tool("list_mailboxes", {}))

Usage from the shell (parity with gmail_helper.py):
    python3 cf-access-client.py list_mailboxes
    python3 cf-access-client.py list_emails '{"mailboxId":"hermes@haouache.com"}'
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
from dataclasses import dataclass
from typing import Any


DEFAULT_BASE_URL = "https://inbox.haouache.com"
DEFAULT_ENV_FILE = "/etc/cf-access/hermes.env"


@dataclass
class InboxClient:
    client_id: str
    client_secret: str
    base_url: str = DEFAULT_BASE_URL
    _next_id: int = 0

    @classmethod
    def from_env_file(cls, path: str = DEFAULT_ENV_FILE, base_url: str = DEFAULT_BASE_URL) -> "InboxClient":
        creds: dict[str, str] = {}
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                if "=" not in stripped:
                    continue
                k, v = stripped.split("=", 1)
                v = v.strip().strip("'").strip('"')
                creds[k.strip()] = v
        cid = creds.get("CF_ACCESS_CLIENT_ID") or creds.get("ACCESS_CLIENT_ID")
        sec = creds.get("CF_ACCESS_CLIENT_SECRET") or creds.get("ACCESS_CLIENT_SECRET")
        if not cid or not sec:
            raise RuntimeError(
                f"Missing CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET in {path}"
            )
        return cls(client_id=cid, client_secret=sec, base_url=base_url.rstrip("/"))

    # ── core RPC ───────────────────────────────────────────────────

    def _rpc(self, method: str, params: dict[str, Any] | None = None) -> Any:
        self._next_id += 1
        body = json.dumps(
            {"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params or {}}
        ).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/mcp",
            method="POST",
            data=body,
            headers={
                "CF-Access-Client-Id": self.client_id,
                "CF-Access-Client-Secret": self.client_secret,
                "Content-Type": "application/json",
                "Accept": "application/json,text/event-stream",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Inbox MCP {method} failed: {e.code} {detail}") from None
        # Servers may speak SSE; grab the last data: frame when present.
        sse_lines = [l for l in raw.split("\n") if l.startswith("data: ")]
        if sse_lines:
            payload = json.loads(sse_lines[-1][6:])
        else:
            payload = json.loads(raw)
        if "error" in payload and payload["error"]:
            err = payload["error"]
            msg = err.get("message") if isinstance(err, dict) else str(err)
            raise RuntimeError(f"Inbox MCP {method} error: {msg}")
        return payload.get("result")

    # ── high-level helpers ─────────────────────────────────────────

    def ping(self) -> Any:
        return self._rpc("ping")

    def list_tools(self) -> Any:
        return self._rpc("tools/list")

    def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        return self._rpc("tools/call", {"name": name, "arguments": arguments})


def _cli() -> int:
    if len(sys.argv) < 2:
        print("usage: cf-access-client.py <tool_name> [json_args]", file=sys.stderr)
        print("       cf-access-client.py ping", file=sys.stderr)
        print("       cf-access-client.py list_tools", file=sys.stderr)
        return 2
    env_file = os.environ.get("CF_ACCESS_ENV_FILE", DEFAULT_ENV_FILE)
    base_url = os.environ.get("INBOX_BASE_URL", DEFAULT_BASE_URL)
    client = InboxClient.from_env_file(env_file, base_url=base_url)
    name = sys.argv[1]
    if name == "ping":
        result = client.ping()
    elif name == "list_tools":
        result = client.list_tools()
    else:
        args: dict[str, Any] = {}
        if len(sys.argv) >= 3 and sys.argv[2]:
            args = json.loads(sys.argv[2])
        result = client.call_tool(name, args)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
