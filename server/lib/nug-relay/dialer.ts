/**
 * Relay target dialing with a strict allowlist (nf side).
 *
 * The allowlist is the nf-side security boundary of the client-egress relay:
 * the server can ask this process to dial any host:port, so without the check
 * a malicious or compromised NUG could use the user's machine to reach
 * internal network addresses. Only upstream AI API hosts are dialable.
 */
import { isIP } from "node:net";

import type { Socket } from "bun";

export interface DialTarget {
	host: string;
	port: number;
}

/** Default allowlist: the codex upstream is the only legitimate target. */
export const DEFAULT_ALLOWED_RELAY_HOSTS: readonly string[] = ["chatgpt.com"];

export class RelayTargetRejectedError extends Error {
	constructor(addr: string, reason: string) {
		super(`relay target ${JSON.stringify(addr)} rejected: ${reason}`);
		this.name = "RelayTargetRejectedError";
	}
}

export function parseAndValidateTarget(
	addr: string,
	allowedHosts: readonly string[] = DEFAULT_ALLOWED_RELAY_HOSTS,
): DialTarget {
	const idx = addr.lastIndexOf(":");
	if (idx <= 0 || idx === addr.length - 1) {
		throw new RelayTargetRejectedError(addr, "target must be host:port");
	}
	const host = addr.slice(0, idx).toLowerCase();
	const port = Number(addr.slice(idx + 1));
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new RelayTargetRejectedError(addr, "invalid port");
	}
	// IP literals are always refused: the allowlist names hostnames, and
	// accepting literals would let the server reach internal addresses without
	// ever touching DNS.
	if (isIP(host) !== 0) {
		throw new RelayTargetRejectedError(addr, "IP literals are not allowed");
	}
	if (!allowedHosts.includes(host)) {
		throw new RelayTargetRejectedError(
			addr,
			`host not in allowlist ${JSON.stringify(allowedHosts)}`,
		);
	}
	return { host, port };
}

export interface RelaySocketHandlers {
	onData(data: Uint8Array): void;
	onClose(): void;
	onError(err: Error): void;
}

/**
 * Dial a relay target, optionally through a local HTTP proxy (CONNECT tunnel,
 * e.g. clash). The tunnel is transparent to the byte stream: TLS to the
 * target is established by the NUG side, so the proxy only ever sees
 * ciphertext plus the CONNECT line.
 */
export function dialRelayTarget(
	target: DialTarget,
	proxyUrl: string | undefined,
	handlers: RelaySocketHandlers,
): Promise<Socket> {
	return new Promise<Socket>((resolve, reject) => {
		let established = false;
		let settled = false;
		let handshake = Buffer.alloc(0);

		let proxy: URL | null = null;
		if (proxyUrl) {
			try {
				proxy = new URL(proxyUrl);
			} catch {
				reject(new Error(`invalid egress proxy URL: ${JSON.stringify(proxyUrl)}`));
				return;
			}
			if (proxy.protocol !== "http:") {
				reject(new Error(`egress proxy must be http:// (CONNECT tunnel), got ${proxy.protocol}`));
				return;
			}
		}
		const connectHost = proxy ? proxy.hostname : target.host;
		const connectPort = proxy ? Number(proxy.port || "7890") : target.port;

		const fail = (err: Error) => {
			if (!settled) {
				settled = true;
				reject(err);
			}
		};

		Bun.connect({
			hostname: connectHost,
			port: connectPort,
			socket: {
				open(socket) {
					if (!proxy) {
						established = true;
						settled = true;
						resolve(socket);
						return;
					}
					const user = decodeURIComponent(proxy.username);
					const auth = proxy.username
						? `Proxy-Authorization: Basic ${Buffer.from(`${user}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
						: "";
					socket.write(
						`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n${auth}\r\n`,
					);
				},
				data(socket, data) {
					if (established) {
						handlers.onData(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
						return;
					}
					handshake = Buffer.concat([handshake, data]);
					const end = handshake.indexOf("\r\n\r\n");
					if (end < 0) {
						if (handshake.length > 16384) {
							socket.end();
							fail(new Error("proxy CONNECT response headers too large"));
						}
						return;
					}
					const head = handshake.subarray(0, end).toString("latin1");
					const rest = handshake.subarray(end + 4);
					const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(head);
					const status = statusMatch ? Number(statusMatch[1]) : 0;
					if (status < 200 || status >= 300) {
						socket.end();
						fail(
							new Error(
								`proxy CONNECT to ${target.host}:${target.port} failed: ${head.split("\r\n")[0] ?? "empty response"}`,
							),
						);
						return;
					}
					established = true;
					settled = true;
					resolve(socket);
					if (rest.length > 0) {
						handlers.onData(new Uint8Array(rest.buffer, rest.byteOffset, rest.byteLength));
					}
				},
				close() {
					if (!established) {
						fail(new Error("socket closed before the tunnel was established"));
						return;
					}
					handlers.onClose();
				},
				error(_socket, err) {
					if (!established) {
						fail(err instanceof Error ? err : new Error(String(err)));
						return;
					}
					handlers.onError(err instanceof Error ? err : new Error(String(err)));
				},
			},
		}).catch(fail);
	});
}
