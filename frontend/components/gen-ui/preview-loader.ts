import { authorizedFetch, clearTokenOnSessionFailure } from "@frontend/lib/api/client";
import {
	GEN_UI_FILE_LIMITS,
	type GenUiFileReference,
	type GenUiPreview,
} from "@shared/gen-ui-files";
import { boundedText, loadBuiltinRuntime, loadUiRuntime } from "./kit-client";

export interface PreviewBundle extends GenUiPreview {
	runtimeJs: string;
	runtimeCss: string;
	/** The runtime is the project's component kit, which the build was compiled against. */
	kitRuntime: boolean;
}

export async function loadGenUiPreview(
	narratorId: string,
	file: Pick<GenUiFileReference, "toolUseId" | "toolCallId">,
	signal: AbortSignal,
): Promise<PreviewBundle> {
	const response = await authorizedFetch(
		`/api/narrators/${encodeURIComponent(narratorId)}/gen-ui/preview/${encodeURIComponent(file.toolUseId)}?toolCallId=${encodeURIComponent(file.toolCallId)}`,
		{ signal, cache: "no-store", redirect: "error" },
	);
	const text = await boundedText(response, GEN_UI_FILE_LIMITS.outputBytes * 6 + 64 * 1024);
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
	const preview = JSON.parse(text) as GenUiPreview;
	if (
		!preview ||
		typeof preview.js !== "string" ||
		typeof preview.css !== "string" ||
		typeof preview.directory !== "string" ||
		typeof preview.entry !== "string" ||
		!Array.isArray(preview.files) ||
		preview.files.length > GEN_UI_FILE_LIMITS.files ||
		!preview.files.every((path) => typeof path === "string" && path.length <= 4096) ||
		new TextEncoder().encode(preview.js + preview.css).byteLength > GEN_UI_FILE_LIMITS.outputBytes
	)
		throw new Error("Invalid preview build response");
	signal.throwIfAborted();
	// The server compiled against whichever runtime the workspace serves; load that one.
	const runtime = preview.kit
		? await loadUiRuntime(narratorId, signal)
		: await loadBuiltinRuntime(signal);
	if (preview.kit && !runtime.kit)
		throw new Error("The component kit this preview was built against is unavailable");
	if (preview.kit && runtime.id !== `kit:${preview.kit.hash}`)
		throw new Error("The component kit changed after this preview was built; rebuild the preview");
	return {
		...preview,
		runtimeJs: runtime.runtimeJs,
		runtimeCss: runtime.runtimeCss,
		kitRuntime: runtime.kit,
	};
}
