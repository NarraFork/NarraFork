import { isLoopbackHost } from "../../shared/server-host";

/**
 * 管理器打到本机服务的请求。
 *
 * 健康检查、退出和更新打的是同一台刚探测过的服务。自签证书只在这一跳放行，
 * 不能让健康检查通过之后，关闭和更新因为证书校验失败。
 */
export async function managerFetch(url: string, init: BunFetchRequestInit = {}): Promise<Response> {
	const target = new URL(url);
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		throw new Error("Manager requests require HTTP or HTTPS");
	}
	const hasCredentials =
		new Headers(init.headers).has("authorization") || target.username || target.password;
	if (hasCredentials && !isLoopbackHost(target.hostname)) {
		throw new Error("Manager credentials require a loopback destination");
	}
	return fetch(url, {
		...init,
		// Never inherit HTTP(S)_PROXY or forward credentials through a redirect.
		proxy: false,
		redirect: "manual",
		tls: { rejectUnauthorized: false },
	});
}
