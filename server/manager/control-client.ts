/** 请求管理器拉起的服务优雅退出。202 表示已排上关闭，409 表示关闭已在进行。 */
export async function requestManagedShutdown(baseUrl: string, token: string): Promise<boolean> {
	try {
		const response = await fetch(`${baseUrl}/api/system/lifecycle/signal`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(5_000),
		});
		return response.status === 202 || response.status === 409;
	} catch {
		return false;
	}
}
