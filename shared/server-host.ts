/** Persist the intent to use the first LAN address, not a DHCP-assigned IP. */
export const AUTO_LAN_HOST = "auto-lan";

/**
 * 是否是"监听所有接口"的通配地址。
 *
 * 这类地址不能直接拼进 URL：`0.0.0.0` / `::` / 空串都不是可访问的主机名，
 * 拼出来浏览器只会报地址错误。调用方应换成 localhost 或回环地址。
 */
export function isWildcardHost(host: string): boolean {
	return host === "0.0.0.0" || host === "::" || host === "[::]" || host === "";
}

/**
 * 可以放进 URL 的主机名。
 *
 * 通配地址和 `auto-lan` 都不是可访问的主机；裸 IPv6 字面量必须加方括号，
 * 否则 `http://:::7778` 既打不开，也解析不出端口。
 */
export function urlHost(host: string): string {
	if (isWildcardHost(host) || host === AUTO_LAN_HOST) return "127.0.0.1";
	if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
	return host;
}

/**
 * 健康检查要连得上的主机。
 *
 * 写进浏览器地址栏时，通配地址和 `auto-lan` 都换成回环。探测则不同：服务实际听在
 * 第一块局域网地址上，打 127.0.0.1 会错过它。没有局域网地址时才回落到回环。
 */
export function probeHost(host: string, lanAddresses: readonly string[] = []): string {
	if (isWildcardHost(host)) return "127.0.0.1";
	if (host === AUTO_LAN_HOST) {
		const lan = lanAddresses.find((address) => address.trim().length > 0);
		return lan ? urlHost(lan) : "127.0.0.1";
	}
	return urlHost(host);
}

/** Literal loopback hosts only: never trust an arbitrary DNS name with manager credentials. */
export function isLoopbackHost(host: string): boolean {
	const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (bare === "localhost" || bare === "::1") return true;
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) {
		return bare.split(".").every((part) => Number(part) <= 255);
	}
	// URL canonicalizes expanded IPv6 and IPv4-mapped IPv6 without any DNS lookup.
	if (bare.includes(":")) {
		try {
			const canonical = new URL(`http://[${bare}]`).hostname;
			return canonical === "[::1]" || /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/.test(canonical);
		} catch {
			return false;
		}
	}
	return false;
}

/** Only local destinations; retain localhost so IPv6-only resolution continues to work. */
export function managerControlHost(listenHost: string): string {
	const host = listenHost.replace(/^\[|\]$/g, "");
	if (host === "::") return "::1";
	if (isLoopbackHost(host)) return host;
	return "127.0.0.1";
}

/** Call with the actual resolved bind address, not persisted `auto-lan` intent. */
export function managerControlCompanionHost(listenHost: string): "127.0.0.1" | undefined {
	return isWildcardHost(listenHost) || isLoopbackHost(listenHost) ? undefined : "127.0.0.1";
}

export function managerControlOrigin(address: {
	protocol: "http" | "https";
	host: string;
	port: number;
}): string {
	return `${address.protocol}://${urlHost(managerControlHost(address.host))}:${address.port}`;
}
