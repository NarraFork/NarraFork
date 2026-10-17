/**
 * 管理器面板的更新客户端。
 *
 * 走 NarraFork 服务端自带的更新接口。面板把启动服务时发下去的令牌放进
 * Authorization。流程与前端的更新模态框同源，面板不重复实现检测、下载与校验。
 */

export interface UpdateCheckSummary {
	updateAvailable: boolean;
	currentVersion: string;
	latestVersion?: string;
	error?: string;
	/** 原样保留并在下载时回传：服务端据此解析出可下载的发布信息。 */
	releaseInfo?: unknown;
}

export interface DownloadOutcome {
	success: boolean;
	version?: string;
	/** 应用阶段需要回传的已准备更新标识。 */
	preparedIdentity?: string;
	error?: string;
}

export interface ApplyOutcome {
	success: boolean;
	error?: string;
	/** 连接在服务重启时断开。调用方应把它当成“替换进程已启动”，而不是失败。 */
	interrupted?: boolean;
}

const REQUEST_TIMEOUT_MS = 20_000;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
	return { ...extra, authorization: `Bearer ${token}` };
}

/** 检查更新；服务不可用或出错时返回带 error 的结果（面板只负责展示文案）。 */
export async function checkForUpdate(baseUrl: string, token: string): Promise<UpdateCheckSummary> {
	try {
		const response = await fetch(`${baseUrl}/api/update/check`, {
			headers: authHeaders(token),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (!response.ok) {
			return {
				updateAvailable: false,
				currentVersion: "",
				error: typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
			};
		}
		return {
			updateAvailable: body.updateAvailable === true,
			currentVersion: typeof body.currentVersion === "string" ? body.currentVersion : "",
			latestVersion: typeof body.latestVersion === "string" ? body.latestVersion : undefined,
			error: typeof body.error === "string" ? body.error : undefined,
			releaseInfo: body.releaseInfo,
		};
	} catch (error) {
		return { updateAvailable: false, currentVersion: "", error: messageOf(error) };
	}
}

/**
 * 下载并落盘更新；进度以百分比回调。
 *
 * 服务端用 SSE 推送：`progress`（阶段与百分比）、`complete`（含 preparedIdentity）、
 * `error`。这里只按帧解析这两种事件，其余阶段变化忽略。
 */
export async function downloadUpdate(
	baseUrl: string,
	token: string,
	releaseInfo: unknown,
	onProgress: (percent: number) => void,
	signal?: AbortSignal,
): Promise<DownloadOutcome> {
	try {
		const response = await fetch(`${baseUrl}/api/update/download`, {
			method: "POST",
			headers: authHeaders(token, { "content-type": "application/json" }),
			body: JSON.stringify({ releaseInfo }),
			signal,
		});
		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => "");
			return { success: false, error: text.slice(0, 200) || `HTTP ${response.status}` };
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let outcome: DownloadOutcome | undefined;
		let streamError: string | undefined;

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			// SSE 以空行分帧。
			let separator = buffer.indexOf("\n\n");
			while (separator >= 0) {
				const frame = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				separator = buffer.indexOf("\n\n");
				const event = frame.match(/^event: (.+)$/m)?.[1];
				const dataLine = frame.match(/^data: (.+)$/m)?.[1];
				if (!event || !dataLine) continue;
				let data: Record<string, unknown>;
				try {
					data = JSON.parse(dataLine) as Record<string, unknown>;
				} catch {
					continue;
				}
				if (event === "progress") {
					if (typeof data.percent === "number") {
						onProgress(Math.max(0, Math.min(100, data.percent)));
					}
				} else if (event === "complete") {
					outcome = {
						success: data.success === true,
						version: typeof data.version === "string" ? data.version : undefined,
						preparedIdentity:
							typeof data.preparedIdentity === "string" ? data.preparedIdentity : undefined,
					};
				} else if (event === "error") {
					streamError = typeof data.error === "string" ? data.error : "download failed";
				}
			}
		}

		if (outcome) return outcome;
		return { success: false, error: streamError ?? "download did not complete" };
	} catch (error) {
		return { success: false, error: messageOf(error) };
	}
}

/**
 * 应用已下载的更新；服务端随即重启，因此调用方在调用后应立即展示"正在重启"，
 * 并把这里的网络类错误视为正常（连接会被重启中断）。
 */
export async function applyUpdate(
	baseUrl: string,
	token: string,
	version: string | undefined,
	preparedIdentity: string,
): Promise<ApplyOutcome> {
	try {
		const response = await fetch(`${baseUrl}/api/update/apply`, {
			method: "POST",
			headers: authHeaders(token, { "content-type": "application/json" }),
			body: JSON.stringify({ version, preparedId: preparedIdentity }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (!response.ok) {
			return {
				success: false,
				error: typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
			};
		}
		return { success: true };
	} catch (error) {
		return { success: false, interrupted: true, error: messageOf(error) };
	}
}
