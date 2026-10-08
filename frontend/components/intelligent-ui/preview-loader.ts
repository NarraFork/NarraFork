import { authorizedFetch, clearTokenOnSessionFailure } from "@frontend/lib/api/client";
import { assetUrl } from "@frontend/lib/base-path";
import {
	PLUGIN_UI_RUNTIME_CSS_URL,
	PLUGIN_UI_RUNTIME_JS_URL,
} from "@frontend/plugin-runtime/paths";
import {
	INTELLIGENT_UI_FILE_LIMITS,
	type IntelligentUiFileReference,
	type IntelligentUiPreview,
} from "@shared/intelligent-ui-files";

export interface PreviewBundle extends IntelligentUiPreview {
	runtimeJs: string;
	runtimeCss: string;
}

/** Bound network reads before collecting text, including static runtime assets. */
async function boundedText(response: Response, maxBytes: number): Promise<string> {
	if (Number(response.headers.get("content-length")) > maxBytes) {
		await response.body?.cancel();
		throw new Error("Preview response exceeds its size limit");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty preview response");
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error("Preview response exceeds its size limit");
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function runtimeAsset(path: string, signal: AbortSignal): Promise<string> {
	const response = await fetch(assetUrl(path), { signal, credentials: "omit", redirect: "error" });
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Shared UI runtime unavailable (${response.status})`);
	}
	return boundedText(response, 8 * 1024 * 1024);
}

export async function loadIntelligentUiPreview(
	narratorId: string,
	file: Pick<IntelligentUiFileReference, "toolUseId" | "toolCallId">,
	signal: AbortSignal,
): Promise<PreviewBundle> {
	const response = await authorizedFetch(
		`/api/narrators/${encodeURIComponent(narratorId)}/intelligent-ui/preview/${encodeURIComponent(file.toolUseId)}?toolCallId=${encodeURIComponent(file.toolCallId)}`,
		{ signal, cache: "no-store", redirect: "error" },
	);
	const text = await boundedText(response, INTELLIGENT_UI_FILE_LIMITS.outputBytes * 6 + 64 * 1024);
	if (response.status === 401) {
		await clearTokenOnSessionFailure(
			new Response(text, { status: 401, headers: response.headers }),
		);
	}
	if (!response.ok) {
		let message = `Preview build failed (${response.status})`;
		try {
			const data = JSON.parse(text);
			if (typeof data.error === "string") message = data.error.slice(0, 2000);
		} catch {
			// Do not display arbitrary HTML returned by an upstream proxy.
		}
		throw new Error(message);
	}
	const preview = JSON.parse(text) as IntelligentUiPreview;
	if (
		!preview ||
		typeof preview.js !== "string" ||
		typeof preview.css !== "string" ||
		typeof preview.directory !== "string" ||
		typeof preview.entry !== "string" ||
		!Array.isArray(preview.files) ||
		preview.files.length > INTELLIGENT_UI_FILE_LIMITS.files ||
		!preview.files.every((path) => typeof path === "string" && path.length <= 4096) ||
		new TextEncoder().encode(preview.js + preview.css).byteLength >
			INTELLIGENT_UI_FILE_LIMITS.outputBytes
	)
		throw new Error("Invalid preview build response");
	signal.throwIfAborted();
	const [runtimeJs, runtimeCss] = await Promise.all([
		runtimeAsset(PLUGIN_UI_RUNTIME_JS_URL, signal),
		runtimeAsset(PLUGIN_UI_RUNTIME_CSS_URL, signal),
	]);
	return { ...preview, runtimeJs, runtimeCss };
}
