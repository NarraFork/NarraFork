/**
 * 管理器面板调用本机服务的凭据。
 *
 * 面板没有用户 JWT。放行条件是两条同时成立：TCP 对端是回环地址，并且
 * `Authorization: Bearer` 等于子进程环境变量里的令牌。解析后的 clientIp 不能用，
 * 它会采纳受信代理上的 X-Forwarded-For，反向代理会把外部请求伪装成 127.0.0.1。
 */

import { timingSafeEqual } from "node:crypto";
import { isTrustedProxyAddress } from "./client-ip";

export const MANAGER_TOKEN_ENV = "NARRAFORK_MANAGER_TOKEN";

const LOOPBACK_CIDRS = ["127.0.0.0/8", "::1/128"];

export function isManagerTokenAuthorized(input: {
	peerIp: string | null | undefined;
	authorization: string | null | undefined;
	expectedToken: string | null | undefined;
}): boolean {
	const expected = input.expectedToken?.trim();
	if (!expected) return false;
	if (!isTrustedProxyAddress(input.peerIp, LOOPBACK_CIDRS)) return false;
	const presented = bearerToken(input.authorization);
	if (!presented) return false;
	const actual = Buffer.from(presented);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function bearerToken(header: string | null | undefined): string | undefined {
	if (!header) return undefined;
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
	const token = match?.[1];
	return token && token.length > 0 ? token : undefined;
}
