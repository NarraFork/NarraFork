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
