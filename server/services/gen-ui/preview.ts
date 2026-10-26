import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import { resolveBackend } from "@server/lib/agent/execution/registry";
import {
	type GenUiFileReference,
	type GenUiPreview,
	GEN_UI_FILE_LIMITS as LIMITS,
} from "@shared/gen-ui-files";
import type { WorkspaceContext } from "@shared/workspace-context";
import { compilePreview } from "./compiler";
import {
	assertReferenceWorkspace,
	collectSources,
	type SourceFile,
	uiError,
	validateDirectory,
} from "./files";
import { readKit } from "./kit";

export interface PreviewDependencies {
	workspace(narratorId: string): Promise<WorkspaceContext>;
	backend(deviceId: string): ExecutionBackend;
	authorize(
		narratorId: string,
		userId: string,
		deviceId: string,
		path: string,
		signal: AbortSignal,
	): Promise<string>;
	compile: typeof compilePreview;
	/** The project kit this workspace serves, if any: previews compile against it. */
	kit(
		backend: ExecutionBackend,
		workspace: WorkspaceContext,
		authorize: (path: string, signal: AbortSignal) => Promise<string>,
		signal: AbortSignal,
	): Promise<{ hash: string; components: string[] } | null>;
}
const defaults: PreviewDependencies = {
	async workspace(narratorId) {
		const { workspaceContextService } = await import("@server/services/workspace-context-service");
		return workspaceContextService.get(narratorId);
	},
	backend(deviceId) {
		return resolveBackend({ requested: deviceId });
	},
	async authorize(narratorId, userId, deviceId, path, signal) {
		const { fileReferenceService } = await import("@server/services/file-reference-service");
		const [target] = await fileReferenceService.resolveFileReferences(
			narratorId,
			userId,
			[{ deviceId, path }],
			signal,
		);
		if (!target) throw uiError("File read authorization denied", 403);
		return target.path;
	},
	compile: compilePreview,
	async kit(backend, workspace, authorize, signal) {
		const { status } = await readKit(backend, workspace, authorize, signal);
		return status.hash ? { hash: status.hash, components: status.components } : null;
	},
};

/**
 * Compiled output by content: the same files against the same kit compile to the same
 * bundle, so reopening a preview (or the card mounting again) skips the compiler. Keyed
 * by bytes, not paths or times, so an edit is never served stale. Everything else a
 * build checks (workspace, authorization) still runs on every request.
 */
const COMPILE_CACHE_ENTRIES = 8;
const COMPILE_CACHE_BYTES = 16 * 1024 * 1024;
const compiled = new Map<string, { js: string; css: string; bytes: number }>();

export function compileCacheKey(sources: SourceFile[], kitHash: string | undefined): string {
	const hash = new Bun.CryptoHasher("sha256");
	hash.update(`kit:${kitHash ?? ""}\0`);
	for (const source of [...sources].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	)) {
		hash.update(`${source.path}\0${source.bytes.byteLength}\0`);
		hash.update(source.bytes);
	}
	return hash.digest("hex");
}

function remember(key: string, result: { js: string; css: string }): void {
	const bytes = (result.js.length + result.css.length) * 2;
	if (bytes > COMPILE_CACHE_BYTES / 2) return;
	compiled.delete(key);
	compiled.set(key, { ...result, bytes });
	let total = 0;
	for (const entry of compiled.values()) total += entry.bytes;
	while (compiled.size > COMPILE_CACHE_ENTRIES || total > COMPILE_CACHE_BYTES) {
		const [oldest, entry] = compiled.entries().next().value as [string, { bytes: number }];
		compiled.delete(oldest);
		total -= entry.bytes;
	}
}

/** Test seam: cases must not see each other's builds. */
export function resetPreviewCacheForTest(): void {
	compiled.clear();
}

let activePreviews = 0;
export async function buildGenUiPreview(
	narratorId: string,
	userId: string,
	reference: GenUiFileReference,
	requestSignal: AbortSignal,
	overrides: Partial<PreviewDependencies> = {},
): Promise<GenUiPreview> {
	if (activePreviews >= 2) throw uiError("UI preview is busy; retry shortly", 429);
	activePreviews++;
	const deps = { ...defaults, ...overrides };
	const controller = new AbortController();
	const cancel = () =>
		controller.abort(requestSignal.reason ?? uiError("UI preview cancelled", 408));
	requestSignal.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(
		() => controller.abort(uiError("UI preview exceeded 15 seconds", 408)),
		LIMITS.timeoutMs,
	);
	const signal = controller.signal;
	let abort: (() => void) | undefined;
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		if (requestSignal.aborted) cancel();
		return await Promise.race([
			cancelled,
			(async () => {
				signal.throwIfAborted();
				const workspace = structuredClone(await deps.workspace(narratorId));
				signal.throwIfAborted();
				const backend = deps.backend(reference.deviceId);
				const generation = backend.runtimeGeneration;
				assertReferenceWorkspace(reference, workspace, backend);
				const { directory, entryPath } = await validateDirectory(
					backend,
					workspace,
					reference.directory,
					signal,
				);
				// Authorize an entry before enumeration, then every file before its bytes cross devices.
				await deps.authorize(narratorId, userId, reference.deviceId, entryPath, signal);
				const sources = await collectSources(
					backend,
					directory,
					(path, readSignal) =>
						deps.authorize(narratorId, userId, reference.deviceId, path, readSignal),
					signal,
				);
				const kit = await deps.kit(
					backend,
					workspace,
					(path, readSignal) =>
						deps.authorize(narratorId, userId, reference.deviceId, path, readSignal),
					signal,
				);
				const key = compileCacheKey(sources, kit?.hash);
				const hit = compiled.get(key);
				if (hit) {
					// Most recently used last.
					compiled.delete(key);
					compiled.set(key, hit);
				}
				const result = hit
					? { js: hit.js, css: hit.css }
					: await deps.compile(sources, signal, kit ?? undefined);
				signal.throwIfAborted();
				const current = await deps.workspace(narratorId);
				assertReferenceWorkspace(reference, current, backend);
				if (
					current.revision !== workspace.revision ||
					deps.backend(reference.deviceId).runtimeGeneration !== generation
				)
					throw uiError("Workspace or device changed while compiling", 409);
				await validateDirectory(backend, current, directory, signal);
				// Policy revocations during compilation must not release already-read source.
				for (const source of sources) {
					const path = backend.paths.resolve(directory, source.path);
					const authorized = await deps.authorize(
						narratorId,
						userId,
						reference.deviceId,
						path,
						signal,
					);
					if (!backend.paths.equals(path, authorized))
						throw uiError("UI file identity changed", 409);
				}
				const latest = await deps.workspace(narratorId);
				assertReferenceWorkspace(reference, latest, backend);
				if (
					latest.revision !== workspace.revision ||
					deps.backend(reference.deviceId).runtimeGeneration !== generation
				)
					throw uiError("Workspace or device changed while authorizing preview", 409);
				signal.throwIfAborted();
				const preview = {
					...result,
					directory,
					entry: reference.entry,
					files: sources.map((source) => source.path),
					sourceHash: key,
					...(kit ? { kit: { hash: kit.hash } } : {}),
				};
				if (Buffer.byteLength(JSON.stringify(preview)) > LIMITS.outputBytes)
					throw uiError("UI preview JSON exceeds the 4 MiB output limit", 413);
				// Only a build that passed every check is kept.
				if (!hit) remember(key, result);
				return preview;
			})(),
		]);
	} finally {
		clearTimeout(timer);
		requestSignal.removeEventListener("abort", cancel);
		if (abort) signal.removeEventListener("abort", abort);
		controller.abort();
		activePreviews--;
	}
}
