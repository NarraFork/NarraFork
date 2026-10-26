import { resolve } from "node:path";
import {
	PLUGIN_UI_RUNTIME_CSS_PATH,
	PLUGIN_UI_RUNTIME_JS_PATH,
} from "@frontend/plugin-runtime/paths";
import { uiError } from "./files";

const MAX_RUNTIME_BYTES = 8 * 1024 * 1024;

/** Read only host-owned build assets, never an agent-supplied path or authenticated URL. */
export async function readInspectionRuntime(signal: AbortSignal) {
	const compiled = import.meta.url.includes("$bunfs/") || import.meta.url.includes("%7EBUN/");
	let assets: Record<string, string> | undefined;
	if (compiled) {
		const modulePath = "../../generated/embedded-frontend";
		const module = (await import(modulePath)) as { embeddedAssets?: Record<string, string> };
		assets = module.embeddedAssets;
	}
	let remaining = MAX_RUNTIME_BYTES;
	async function read(path: string): Promise<string> {
		signal.throwIfAborted();
		const filePath = compiled
			? assets?.[`/${path}`]
			: resolve(import.meta.dir, "../../../dist/frontend", path);
		if (!filePath) throw uiError("GenUI inspection runtime is unavailable in this build", 503);
		const file = Bun.file(filePath);
		if (!(await file.exists()))
			throw uiError(
				"GenUI inspection runtime assets are missing. Build the frontend (bun run build) first; normal chat previews remain available.",
				503,
			);
		if (file.size > remaining) throw uiError("GenUI inspection runtime exceeds 8 MiB", 413);
		const reader = file.stream().getReader();
		const cancel = () => void reader.cancel().catch(() => {});
		signal.addEventListener("abort", cancel, { once: true });
		const decoder = new TextDecoder();
		let text = "";
		try {
			while (true) {
				signal.throwIfAborted();
				const chunk = await reader.read();
				if (chunk.done) break;
				remaining -= chunk.value.byteLength;
				if (remaining < 0) throw uiError("GenUI inspection runtime exceeds 8 MiB", 413);
				text += decoder.decode(chunk.value, { stream: true });
			}
			signal.throwIfAborted();
			return text + decoder.decode();
		} finally {
			signal.removeEventListener("abort", cancel);
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
	const runtimeJs = await read(PLUGIN_UI_RUNTIME_JS_PATH);
	const runtimeCss = await read(PLUGIN_UI_RUNTIME_CSS_PATH);
	return { runtimeJs, runtimeCss };
}
