import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
	PLUGIN_SOURCE_MAX_METADATA_BYTES,
	PLUGIN_SOURCE_METADATA_FILE,
	type PluginSource,
	type PluginSourceDiagnostic,
	pluginSourceMetadataSchema,
} from "@shared/plugin-source";

export interface PluginSourceMetadataResult {
	source: PluginSource | null;
	diagnostics: PluginSourceDiagnostic[];
}
const diagnostic = (
	code: PluginSourceDiagnostic["code"],
	message: string,
): PluginSourceMetadataResult => ({ source: null, diagnostics: [{ code, message }] });
function aborted(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

export async function readPluginSourceMetadata(
	packagePath: string,
	expectedPluginId: string,
	options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<PluginSourceMetadataResult> {
	aborted(options.signal);
	const filePath = join(packagePath, PLUGIN_SOURCE_METADATA_FILE);
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(filePath);
	} catch (error) {
		aborted(options.signal);
		if ((error as { code?: string }).code === "ENOENT") {
			return { source: null, diagnostics: [] };
		}
		return diagnostic("SOURCE_UNREADABLE", "Plugin source metadata could not be read");
	}
	const requestedLimit = options.maxBytes ?? PLUGIN_SOURCE_MAX_METADATA_BYTES;
	const limit = Number.isFinite(requestedLimit)
		? Math.min(PLUGIN_SOURCE_MAX_METADATA_BYTES, Math.max(1, Math.floor(requestedLimit)))
		: PLUGIN_SOURCE_MAX_METADATA_BYTES;
	if (!info.isFile() || info.isSymbolicLink() || info.size > limit) {
		return diagnostic("SOURCE_INVALID", "Plugin source metadata is not a bounded regular file");
	}
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		aborted(options.signal);
		const [rootReal, fileReal] = await Promise.all([realpath(packagePath), realpath(filePath)]);
		const path = relative(rootReal, fileReal);
		if (isAbsolute(path) || path === ".." || path.startsWith("../") || path.startsWith("..\\")) {
			return diagnostic("SOURCE_INVALID", "Plugin source metadata escaped its package");
		}
		handle = await open(fileReal, "r");
		const openedInfo = await handle.stat();
		if (
			!openedInfo.isFile() ||
			openedInfo.size > limit ||
			openedInfo.dev !== info.dev ||
			openedInfo.ino !== info.ino
		) {
			return diagnostic("SOURCE_INVALID", "Plugin source metadata changed while opening");
		}
		const bytes = new Uint8Array(limit + 1);
		let read = 0;
		while (read < bytes.length) {
			aborted(options.signal);
			const result = await handle.read(bytes, read, bytes.length - read, read);
			if (!result.bytesRead) break;
			read += result.bytesRead;
		}
		if (read > limit) {
			return diagnostic("SOURCE_INVALID", "Plugin source metadata exceeded its byte budget");
		}
		aborted(options.signal);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, read));
		const parsed = pluginSourceMetadataSchema.safeParse(JSON.parse(text));
		if (!parsed.success) {
			return diagnostic("SOURCE_INVALID", "Plugin source metadata did not match the source schema");
		}
		if (
			parsed.data.pluginId !== expectedPluginId ||
			(parsed.data.source.type === "local" && parsed.data.source.builtinId !== expectedPluginId)
		) {
			return diagnostic("SOURCE_MISMATCH", "Plugin source metadata belongs to a different plugin");
		}
		return { source: parsed.data.source, diagnostics: [] };
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason ?? error;
		return diagnostic("SOURCE_INVALID", "Plugin source metadata was invalid or unreadable");
	} finally {
		await handle?.close();
	}
}
