import { createHash } from "node:crypto";
import {
	type CapturedFileReferencePreview,
	type CapturedFileReferenceSelector,
	FILE_REFERENCE_READ_CONCURRENCY,
	FILE_REFERENCE_READ_TIMEOUT_MS,
	FILE_REFERENCE_SEARCH_TIMEOUT_MS,
	type FileReference,
	type FileReferenceCandidate,
	type FileReferencePreview,
	type FileReferenceSearchResult,
	type FileReferenceSnapshot,
	type FileReferenceSourceOrigin,
	type FileSelection,
	type FileTarget,
	isFileReferenceSnapshot,
	MAX_FILE_REFERENCE_METADATA_BYTES,
	MAX_FILE_REFERENCE_PATH_CHARS,
	MAX_FILE_REFERENCE_SEARCH_BYTES,
	MAX_FILE_REFERENCE_SEARCH_RESULTS,
	MAX_FILE_REFERENCE_SOURCE_BYTES,
	MAX_FILE_REFERENCE_TEXT_BYTES,
	MAX_FILE_REFERENCE_TOTAL_TEXT_BYTES,
} from "@shared/file-reference";
import {
	getFileReferenceImageMimeType,
	MAX_FILE_REFERENCE_IMAGE_BYTES,
} from "@shared/file-reference-image";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { DeviceSummary, ExecutionBackend, FileStat } from "../lib/agent/execution/backend";
import { AppError, NotFoundError, zodValidationError } from "../lib/errors";
import { isPlanModeTrait } from "../lib/narrator-utils";
import { resolveEffectiveRelaxedPlan } from "../lib/permission-modes";
import {
	fileReferencesSchema,
	fileTargetSchema,
	resolveFileReferencesSchema,
	searchFileReferencesSchema,
} from "../lib/validators/file-references";
import type { CompiledExecutionPolicy } from "./execution-policy/compiler";
import { createExecutionTargetContext } from "./execution-policy/target-context";
import type { ExecutionTargetContext } from "./execution-policy/types";
import type { OAuthNarratorRuntimePolicy } from "./oauth-narrator-runtime-policy";

export interface FileReferenceSearchInput {
	q: string;
	deviceId?: string;
	directory?: string;
}
export interface FileReferenceService {
	captureFileReferences(
		narratorId: string,
		userId: string,
		references: readonly FileReference[],
		signal?: AbortSignal,
	): Promise<FileReferenceSnapshot[]>;
	resolveFileReferences(
		narratorId: string,
		userId: string,
		targets: readonly FileTarget[],
		signal?: AbortSignal,
	): Promise<FileTarget[]>;
	previewFileReference(
		narratorId: string,
		userId: string,
		target: FileTarget,
		signal?: AbortSignal,
	): Promise<FileReferencePreview>;
	previewFileReferenceImage(
		narratorId: string,
		userId: string,
		target: FileTarget,
		signal?: AbortSignal,
	): Promise<{ bytes: Uint8Array; mimeType: string }>;
	searchFileReferences(
		narratorId: string,
		userId: string,
		input: FileReferenceSearchInput,
		signal?: AbortSignal,
	): Promise<FileReferenceSearchResult>;
}
export interface FileReferenceScope {
	narratorId: string;
	userId: string;
	/** Server-confirmed new capture project; absence is legacy/unknown, not standalone. */
	projectId?: string | null;
	cwd: string;
	defaultDeviceId: string;
	devices: readonly DeviceSummary[];
	permissionMode: string;
	runtimePolicy?: OAuthNarratorRuntimePolicy | null;
}
export interface FileReferenceDependencies {
	/** Must authorize the actual user, not the narrator owner or last acting user. */
	loadScope(
		narratorId: string,
		userId: string,
		need: "read" | "write",
		options?: { originalResource?: boolean },
	): Promise<FileReferenceScope>;
	getBackend(deviceId: string): ExecutionBackend | Promise<ExecutionBackend>;
	resolveWorkspace?(
		scope: FileReferenceScope,
		deviceId: string,
		options: { required: boolean },
	): Promise<WorkspaceContext | null>;
	assertWorkspaceCurrent?(scope: FileReferenceScope, workspace: WorkspaceContext): Promise<void>;
	assertWorkspaceCurrentSync?(scope: FileReferenceScope, workspace: WorkspaceContext): void;
	authorizeEndpoint?(
		scope: FileReferenceScope,
		deviceId: string,
	): Promise<{ assertStillCurrent(): void }>;
	readDecision(
		scope: FileReferenceScope,
		context: ExecutionTargetContext,
	): Promise<"allow" | "ask" | "deny">;
	isSecretPath(context: ExecutionTargetContext, path: string): boolean | Promise<boolean>;
	decode(bytes: Uint8Array): Promise<{ text: string; encoding: string }>;
	report?(event: {
		operation: string;
		elapsedMs: number;
		failed: boolean;
		truncated: boolean;
	}): void;
}

function failure(code: string, message: string, status = 400): AppError {
	return new AppError(message, status, `FILE_REFERENCE_${code}`);
}

function publicFailure(error: unknown): AppError {
	if (error instanceof AppError) return error;
	if (error instanceof Error) {
		if (error.name === "DeviceCapabilityError")
			return failure(
				"UNSUPPORTED",
				"Upgrade the executor: this file reference operation requires bounded filesystem capabilities",
				422,
			);
		if (error.name === "DeviceConnectionChangedError")
			return failure(
				"IDENTITY_CHANGED",
				"Execution device reconnected; retry the file reference",
				409,
			);
		if (error.name === "DeviceOfflineError" || error.name === "ExecutionTargetError")
			return failure(
				"DEVICE_OFFLINE",
				"Execution device is offline; no local fallback is permitted",
				503,
			);
		if (/timed out|deadline exceeded/i.test(error.message))
			return failure("TIMEOUT", "File reference operation exceeded its time budget", 408);
	}
	return failure(
		"UNAVAILABLE",
		"File reference could not be read safely; check its path, device and Read policy",
		422,
	);
}
/** Pure Read decision shared by the production permission path and isolated regressions. */
export function evaluateFileReferenceReadPolicy(
	scope: Pick<FileReferenceScope, "permissionMode" | "runtimePolicy">,
	context: ExecutionTargetContext & { fileReferenceExactOnly?: boolean },
	policy: Pick<CompiledExecutionPolicy, "evaluatePath">,
): "allow" | "ask" | "deny" {
	const path = context.target.canonicalPath;
	if (!path) return "deny";
	const runtime = scope.runtimePolicy;
	let mode = runtime?.permissionMode ?? scope.permissionMode;
	if (runtime) {
		if (!runtime.allowedTools.has("Read") || !context.deviceClass) return "deny";
		const deviceLevel = runtime.policy.deviceAccess[context.deviceClass];
		if (deviceLevel !== "readOnly" && deviceLevel !== "readWrite") return "deny";
		// Same hard read-only device ceiling as narrator-permission's decisionPermMode:
		// selecting bypass for the narrator does not grant unrestricted paths on this device.
		// This HTTP path never runs danger reflection, so it also keeps a stricter live
		// runtime readOnly/dontAsk mode rather than promoting it for a readWrite device.
		if (deviceLevel === "readOnly" && mode === "bypassPermissions") mode = "readOnly";
	}
	const decision = policy.evaluatePath({ path, operation: "read" }).decision;
	if (decision === "deny" || decision === "allow") return decision;
	if (mode === "dontAsk") return "deny";
	if (mode === "bypassPermissions") return "allow";
	if (!context.fileReferenceExactOnly && context.paths.contains(context.target.cwd, path))
		return "allow";
	return mode === "readOnly" ? "deny" : "ask";
}

/** The saved decoded document hash is also the /fs/edit-source optimistic lock token. */
export function hashFileReferenceText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Validate coordinates against real saved text; the only EOF adaptation is whole-line end+1. */
export function selectFileReferenceText(
	text: string,
	selection?: FileSelection,
): { text: string; selection?: FileSelection } {
	if (!selection) return { text };
	const starts = [0];
	const ends: number[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n" || text[i] === "\r") {
			ends.push(i);
			if (text[i] === "\r" && text[i + 1] === "\n") i++;
			starts.push(i + 1);
		}
	}
	ends.push(text.length);
	const resolved = { ...selection };
	if (resolved.endLineNumber === starts.length + 1 && resolved.endColumn === 1) {
		resolved.endLineNumber = starts.length;
		resolved.endColumn = text.length - starts[starts.length - 1] + 1;
	}
	const offset = (line: number, column: number): number => {
		if (
			!Number.isSafeInteger(line) ||
			!Number.isSafeInteger(column) ||
			line < 1 ||
			line > starts.length ||
			column < 1 ||
			column > ends[line - 1] - starts[line - 1] + 1
		) {
			throw failure("INVALID_SELECTION", "File selection is outside the saved document");
		}
		return starts[line - 1] + column - 1;
	};
	const start = offset(resolved.startLineNumber, resolved.startColumn);
	const end = offset(resolved.endLineNumber, resolved.endColumn);
	if (end < start) throw failure("INVALID_SELECTION", "Selection end precedes start");
	return { text: text.slice(start, end), selection: resolved };
}

class Operation {
	readonly controller = new AbortController();
	readonly authorizedContexts = new Map<string, ExecutionTargetContext>();
	readonly startedAt = Date.now();
	readonly deadline: number;
	private timer: ReturnType<typeof setTimeout>;
	private relay: () => void;
	constructor(
		readonly timeoutMs: number,
		private external?: AbortSignal,
	) {
		this.deadline = this.startedAt + timeoutMs;
		this.relay = () =>
			this.controller.abort(failure("CANCELLED", "File reference operation cancelled", 499));
		this.timer = setTimeout(
			() =>
				this.controller.abort(
					failure("TIMEOUT", "File reference operation exceeded its time budget", 408),
				),
			timeoutMs,
		);
		if (external?.aborted) this.relay();
		else external?.addEventListener("abort", this.relay, { once: true });
	}
	get signal(): AbortSignal {
		return this.controller.signal;
	}
	get remaining(): number {
		return Math.max(1, this.deadline - Date.now());
	}
	check(): void {
		if (Date.now() >= this.deadline && !this.signal.aborted)
			this.controller.abort(
				failure("TIMEOUT", "File reference operation exceeded its time budget", 408),
			);
		this.signal.throwIfAborted();
	}
	async wait<T>(work: () => Promise<T>): Promise<T> {
		this.check();
		let abort: () => void = () => {};
		try {
			const result = await Promise.race([
				work(),
				new Promise<never>((_, reject) => {
					abort = () => reject(this.signal.reason);
					this.signal.addEventListener("abort", abort, { once: true });
					if (this.signal.aborted) abort();
				}),
			]);
			this.check();
			return result;
		} finally {
			this.signal.removeEventListener("abort", abort);
		}
	}
	close(): void {
		clearTimeout(this.timer);
		this.external?.removeEventListener("abort", this.relay);
	}
}

interface DeviceContext {
	backend: ExecutionBackend;
	cwd: string;
	workspace?: WorkspaceContext;
	generation: number;
}
interface AuthorizedFile {
	device: DeviceContext;
	context: ExecutionTargetContext;
	target: FileTarget;
	stat: FileStat;
}

export function createFileReferenceService(
	deps: FileReferenceDependencies,
	budgets: { readTimeoutMs?: number; searchTimeoutMs?: number } = {},
): FileReferenceService {
	async function run<T>(
		operation: string,
		narratorId: string,
		userId: string,
		need: "read" | "write",
		signal: AbortSignal | undefined,
		execute: (
			scope: FileReferenceScope,
			op: Operation,
			devices: Map<string, Promise<DeviceContext>>,
		) => Promise<T>,
	): Promise<T> {
		const limit =
			operation === "search"
				? Math.min(
						budgets.searchTimeoutMs ?? FILE_REFERENCE_SEARCH_TIMEOUT_MS,
						FILE_REFERENCE_SEARCH_TIMEOUT_MS,
					)
				: Math.min(
						budgets.readTimeoutMs ?? FILE_REFERENCE_READ_TIMEOUT_MS,
						FILE_REFERENCE_READ_TIMEOUT_MS,
					);
		const op = new Operation(limit, signal);
		const devices = new Map<string, Promise<DeviceContext>>();
		let failed = true;
		let truncated = false;
		try {
			if (!userId || !narratorId) throw new NotFoundError("Narrator", narratorId);
			const scope = await op.wait(() => deps.loadScope(narratorId, userId, need));
			const result = await op.wait(() => execute(scope, op, devices));
			// Recheck ACL/device availability before releasing results. No long-lived auth cache.
			const current = await op.wait(() => deps.loadScope(narratorId, userId, need));
			if (current.projectId !== scope.projectId)
				throw failure(
					"IDENTITY_CHANGED",
					"Narrator project changed during new reference admission",
					409,
				);

			for (const context of op.authorizedContexts.values()) {
				if ((await op.wait(() => deps.readDecision(current, context))) !== "allow")
					throw failure("FORBIDDEN", "Read policy changed during file reference operation", 403);
			}
			const finalDevices: DeviceContext[] = [];
			const finalProofs: Array<{ assertStillCurrent(): void }> = [];
			for (const [id, pending] of devices) {
				assertDeviceAllowed(current, id);
				const original = await pending;
				finalDevices.push(original);
				if (original.workspace)
					await op.wait(
						() =>
							deps.assertWorkspaceCurrent?.(scope, original.workspace as WorkspaceContext) ??
							Promise.resolve(),
					);
				const fresh = await op.wait(() => Promise.resolve(deps.getBackend(id)));
				if (
					fresh.deviceId !== id ||
					fresh.kind !== original.backend.kind ||
					fresh.runtimeGeneration !== original.generation ||
					fresh.pathFlavor !== original.backend.pathFlavor
				)
					throw failure(
						"IDENTITY_CHANGED",
						"Execution device changed during file reference operation",
						409,
					);
				const proof = await op.wait(
					() => deps.authorizeEndpoint?.(current, id) ?? Promise.resolve(null),
				);
				if (proof) finalProofs.push(proof);
			}
			for (const proof of finalProofs) proof.assertStillCurrent();
			for (const device of finalDevices)
				if (device.workspace) deps.assertWorkspaceCurrentSync?.(scope, device.workspace);
			op.check();
			failed = false;
			truncated = !!(
				result &&
				typeof result === "object" &&
				"truncated" in result &&
				result.truncated
			);
			return result;
		} catch (error) {
			const exposed = publicFailure(op.signal.aborted ? op.signal.reason : error);
			op.controller.abort(exposed);
			throw exposed;
		} finally {
			op.close();
			deps.report?.({ operation, elapsedMs: Date.now() - op.startedAt, failed, truncated });
		}
	}
	function assertDeviceAllowed(scope: FileReferenceScope, id: string): void {
		if (id !== "local" && !deps.authorizeEndpoint) {
			const allowed = scope.devices.find((device) => device.id === id);
			if (!allowed)
				throw failure("FORBIDDEN", "Device is not authorized for this user and narrator", 403);
			if (!allowed.online)
				throw failure(
					"DEVICE_OFFLINE",
					"Remote execution device is offline; no local fallback is permitted",
					503,
				);
		}
		const runtime = scope.runtimePolicy;
		if (
			runtime &&
			(id === "local" ? !runtime.allowLocalExecution : !runtime.deviceIds.includes(id))
		)
			throw failure("FORBIDDEN", "Narrator runtime policy denies this device", 403);
	}
	function deviceFor(
		scope: FileReferenceScope,
		id: string,
		op: Operation,
		devices: Map<string, Promise<DeviceContext>>,
	): Promise<DeviceContext> {
		assertDeviceAllowed(scope, id);
		let result = devices.get(id);
		if (!result) {
			result = (async () => {
				const endpoint = await op.wait(
					() => deps.authorizeEndpoint?.(scope, id) ?? Promise.resolve(null),
				);
				endpoint?.assertStillCurrent();
				const backend = await op.wait(() => Promise.resolve(deps.getBackend(id)));
				if (
					backend.deviceId !== id ||
					(id === "local" ? backend.kind !== "local" : backend.kind !== "remote")
				)
					throw failure("IDENTITY_CHANGED", "Execution backend identity mismatch", 409);
				const remote = backend as ExecutionBackend & {
					supportsFsStatResolvedPath?: boolean;
					supportsFsReadAtomicResolvedPath?: boolean;
					supportsFsReadBounded?: boolean;
				};
				if (
					backend.kind === "remote" &&
					(remote.supportsFsStatResolvedPath !== true ||
						remote.supportsFsReadAtomicResolvedPath !== true ||
						remote.supportsFsReadBounded !== true)
				)
					throw failure(
						"UNSUPPORTED",
						"Upgrade the executor: canonical path, atomic read and fs.read.bounded.v1 capabilities are required",
						422,
					);
				endpoint?.assertStillCurrent();
				// Policy canonicalization must receive the same cancellation and deadline.
				const bounded = new Proxy(backend, {
					get(target, key) {
						if (key === "resolvePathIdentity")
							return (path: string) =>
								op.wait(async () => {
									const proof = await deps.authorizeEndpoint?.(scope, id);
									proof?.assertStillCurrent();
									return target.resolvePathIdentity(path, {
										signal: op.signal,
										timeoutMs: op.remaining,
									});
								});
						const value = Reflect.get(target, key, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
				return { backend: bounded, cwd: "", generation: backend.runtimeGeneration };
			})();
			devices.set(id, result);
		}
		return result;
	}
	async function bindingRoot(
		scope: FileReferenceScope,
		device: DeviceContext,
		op: Operation,
		required = true,
	): Promise<string> {
		if (!device.workspace) {
			const workspace = await op.wait(
				() =>
					deps.resolveWorkspace?.(scope, device.backend.deviceId, { required }) ??
					Promise.resolve(null),
			);
			if (!workspace && !required) return "";
			if (
				!workspace?.binding ||
				workspace.deviceId !== device.backend.deviceId ||
				!device.backend.paths.isAbsolute(workspace.cwd) ||
				workspace.pathFlavor !== device.backend.pathFlavor
			)
				throw failure(
					"WORKSPACE_UNCONFIGURED",
					"Configure this narrator/device working directory first",
					409,
				);
			device.workspace = Object.freeze(structuredClone(workspace));
			await deps.assertWorkspaceCurrent?.(scope, device.workspace);
			const identity = await device.backend.resolvePathIdentity(workspace.cwd);
			if (
				!identity.exists ||
				identity.runtimeGeneration !== device.generation ||
				!device.backend.paths.equals(identity.canonicalPath, workspace.cwd)
			)
				throw failure("IDENTITY_CHANGED", "Working directory identity is unavailable", 409);
			device.cwd = workspace.cwd;
		}
		return device.cwd;
	}
	async function beforeDispatch(
		scope: FileReferenceScope,
		device: DeviceContext,
		op: Operation,
		context?: ExecutionTargetContext,
	): Promise<void> {
		const current = await op.wait(() => deps.loadScope(scope.narratorId, scope.userId, "read"));
		if (current.projectId !== scope.projectId)
			throw failure(
				"IDENTITY_CHANGED",
				"Narrator project changed before new reference dispatch",
				409,
			);
		assertDeviceAllowed(current, device.backend.deviceId);
		if (context && (await op.wait(() => deps.readDecision(current, context))) !== "allow")
			throw failure("FORBIDDEN", "Read policy changed before file dispatch", 403);
		if (device.workspace)
			await op.wait(
				() =>
					deps.assertWorkspaceCurrent?.(scope, device.workspace as WorkspaceContext) ??
					Promise.resolve(),
			);
		const proof = await op.wait(
			() => deps.authorizeEndpoint?.(current, device.backend.deviceId) ?? Promise.resolve(null),
		);
		proof?.assertStillCurrent();
		if (device.workspace) deps.assertWorkspaceCurrentSync?.(scope, device.workspace);
		op.check();
	}
	async function authorize(
		scope: FileReferenceScope,
		input: FileTarget,
		op: Operation,
		devices: Map<string, Promise<DeviceContext>>,
		directory = false,
	): Promise<AuthorizedFile> {
		const device = await deviceFor(scope, input.deviceId, op, devices);
		const { backend } = device;
		if (
			/^[a-z][a-z\d+.-]*:\/\//i.test(input.path) ||
			(backend.pathFlavor !== "windows" && /^[a-z]:[\\/]/i.test(input.path)) ||
			(backend.pathFlavor === "windows" &&
				(/^[a-z]:[^\\/]/i.test(input.path) ||
					/^[\\/]{2}[?.]/.test(input.path) ||
					input.path.replace(/^[a-z]:/i, "").includes(":")))
		)
			throw failure("INVALID_TARGET", "File path does not match the target device path grammar");
		const root = await bindingRoot(scope, device, op, !backend.paths.isAbsolute(input.path));
		const cwd = root || backend.paths.resolve(input.path, "..");
		const lexical = backend.paths.resolve(cwd, input.path);
		if (!backend.paths.isAbsolute(lexical) || lexical.length > MAX_FILE_REFERENCE_PATH_CHARS)
			throw failure("INVALID_TARGET", "File path must resolve to a bounded absolute path");
		const resolvedContext = await op.wait(() =>
			createExecutionTargetContext({
				backend,
				target: {
					deviceId: input.deviceId,
					backendKind: backend.kind,
					cwd,
					lexicalPath: lexical,
					pathFlavor: backend.pathFlavor,
					runtimeGeneration: device.generation,
					selectionSource: "explicit",
				},
			}),
		);
		const context = { ...resolvedContext, fileReferenceExactOnly: !root };
		const canonical = context.target.canonicalPath;
		if (
			!canonical ||
			!backend.paths.isAbsolute(canonical) ||
			canonical.length > MAX_FILE_REFERENCE_PATH_CHARS ||
			(backend.pathFlavor === "windows" && canonical.replace(/^[a-z]:/i, "").includes(":"))
		)
			throw failure("INVALID_TARGET", "Canonical file identity is invalid");
		if (
			await op.wait(
				async () =>
					(await deps.isSecretPath(context, lexical)) ||
					(await deps.isSecretPath(context, canonical)),
			)
		)
			throw failure("FORBIDDEN", "Secret paths cannot be used as file references", 403);
		const decision = await op.wait(() => deps.readDecision(scope, context));
		if (decision !== "allow")
			throw failure(
				"FORBIDDEN",
				decision === "ask"
					? "Read permission requires approval; selecting # is not a Read approval"
					: "Read policy denies this file reference",
				403,
			);
		await beforeDispatch(scope, device, op, context);
		const stat = await op.wait(() =>
			backend.statFile(lexical, { signal: op.signal, timeoutMs: op.remaining }),
		);
		if (!stat) throw new NotFoundError("File", input.path);
		if (
			!stat.resolvedPath ||
			!backend.paths.equals(stat.resolvedPath, canonical) ||
			backend.runtimeGeneration !== device.generation
		)
			throw failure("IDENTITY_CHANGED", "File canonical identity changed", 409);
		if (directory ? !stat.isDirectory : !stat.isFile)
			throw failure(
				"INVALID_TARGET",
				directory
					? "Search root must be a directory"
					: "Only individual text files can be referenced",
			);
		op.authorizedContexts.set(
			JSON.stringify([input.deviceId, backend.paths.identityKey(canonical)]),
			context,
		);
		return {
			device,
			context,
			stat,
			target: {
				deviceId: input.deviceId,
				path: canonical,
				...(input.selection ? { selection: input.selection } : {}),
			},
		};
	}
	async function read(
		scope: FileReferenceScope,
		input: FileTarget,
		op: Operation,
		devices: Map<string, Promise<DeviceContext>>,
		expectedHash?: string,
	) {
		const file = await authorize(scope, input, op, devices);
		if (file.stat.size > MAX_FILE_REFERENCE_SOURCE_BYTES)
			throw failure("SOURCE_TOO_LARGE", "Source file exceeds 1 MiB; choose a smaller file", 413);
		await beforeDispatch(scope, file.device, op, file.context);
		const result = await op.wait(() =>
			file.device.backend.readFileBytes(file.context.target.lexicalPath as string, {
				maxBytes: MAX_FILE_REFERENCE_SOURCE_BYTES,
				expectedResolvedPath: file.target.path,
				signal: op.signal,
				timeoutMs: op.remaining,
			}),
		);
		if (
			!result.resolvedPath ||
			!file.context.paths.equals(result.resolvedPath, file.target.path) ||
			file.device.backend.runtimeGeneration !== file.device.generation
		)
			throw failure(
				"IDENTITY_CHANGED",
				"Atomic read did not verify the authorized file identity",
				409,
			);
		if (
			result.truncated ||
			result.totalSize > MAX_FILE_REFERENCE_SOURCE_BYTES ||
			result.bytes.byteLength > MAX_FILE_REFERENCE_SOURCE_BYTES
		)
			throw failure(
				"SOURCE_TOO_LARGE",
				"Source file exceeds 1 MiB; partial references are not accepted",
				413,
			);
		const decoded = await op.wait(() => deps.decode(result.bytes));
		if (decoded.text.includes("\0"))
			throw failure("BINARY", "Only text files can be referenced", 415);
		const hash = hashFileReferenceText(decoded.text);
		if (expectedHash !== undefined && expectedHash !== hash)
			throw failure(
				"STALE",
				"Saved file has changed; reload or save your selection before sending",
				409,
			);
		const selected = selectFileReferenceText(decoded.text, input.selection);
		return {
			...file,
			target: { ...file.target, ...(selected.selection ? { selection: selected.selection } : {}) },
			content: decoded.text,
			encoding: decoded.encoding,
			selectedText: selected.text,
			hash,
		};
	}
	async function mapBounded<T, R>(
		items: readonly T[],
		op: Operation,
		work: (value: T) => Promise<R>,
	): Promise<R[]> {
		const results = new Array<R>(items.length);
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(FILE_REFERENCE_READ_CONCURRENCY, items.length) }, async () => {
				while (next < items.length) {
					op.check();
					const index = next++;
					try {
						results[index] = await work(items[index]);
					} catch (error) {
						op.controller.abort(error);
						throw error;
					}
				}
			}),
		);
		return results;
	}
	return {
		async captureFileReferences(narratorId, userId, references, signal) {
			const parsed = fileReferencesSchema.safeParse(references);
			if (!parsed.success) throw zodValidationError(parsed.error);
			return run("capture", narratorId, userId, "write", signal, async (scope, op, devices) => {
				let totalBytes = 0;
				let originBytes = 0;
				const snapshots = await mapBounded(
					parsed.data,
					op,
					async (
						reference,
					): Promise<FileReferenceSnapshot & { sourceOrigin?: FileReferenceSourceOrigin }> => {
						const file = await read(scope, reference, op, devices, reference.expectedHash);
						const bytes = Buffer.byteLength(file.selectedText, "utf8");
						totalBytes += bytes;
						if (
							bytes > MAX_FILE_REFERENCE_TEXT_BYTES ||
							totalBytes > MAX_FILE_REFERENCE_TOTAL_TEXT_BYTES
						)
							throw failure(
								"SNAPSHOT_TOO_LARGE",
								"Reference text exceeds 32 KiB per reference or 128 KiB per message; select a smaller range",
								413,
							);
						const sourceOrigin: FileReferenceSourceOrigin | undefined =
							scope.projectId !== undefined
								? {
										version: 1,
										narratorId: scope.narratorId,
										projectId: scope.projectId,
										deviceId: file.target.deviceId,
										canonicalPath: file.target.path,
										...(file.device.workspace ? { cwd: file.device.workspace.cwd } : {}),
									}
								: undefined;
						originBytes += sourceOrigin ? Buffer.byteLength(JSON.stringify(sourceOrigin)) : 0;
						if (originBytes > MAX_FILE_REFERENCE_METADATA_BYTES)
							throw failure(
								"SNAPSHOT_TOO_LARGE",
								"Reference source metadata exceeds its 64 KiB budget",
								413,
							);
						return {
							type: "file_reference",
							...(sourceOrigin ? { sourceOrigin } : {}),
							reference: { ...reference, ...file.target },
							snapshotText: file.selectedText,
							snapshotHash: hashFileReferenceText(file.selectedText),
							capturedAt: new Date().toISOString(),
						};
					},
				);
				const canonicalMetadata = fileReferencesSchema.safeParse(
					snapshots.map((snapshot) => snapshot.reference),
				);
				if (!canonicalMetadata.success) throw zodValidationError(canonicalMetadata.error);
				return snapshots;
			});
		},
		async resolveFileReferences(narratorId, userId, targets, signal) {
			const parsed = resolveFileReferencesSchema.safeParse({ targets });
			if (!parsed.success) throw zodValidationError(parsed.error);
			return run("resolve", narratorId, userId, "read", signal, async (scope, op, devices) => {
				const targets = await mapBounded(parsed.data.targets, op, async (target) => {
					// Coordinates require a bounded saved-text read, but the response never contains it.
					if (target.selection) return (await read(scope, target, op, devices)).target;
					return (await authorize(scope, target, op, devices)).target;
				});
				const canonicalMetadata = resolveFileReferencesSchema.safeParse({ targets });
				if (!canonicalMetadata.success) throw zodValidationError(canonicalMetadata.error);
				return targets;
			});
		},
		async previewFileReference(narratorId, userId, target, signal) {
			const parsed = fileTargetSchema.safeParse(target);
			if (!parsed.success) throw zodValidationError(parsed.error);
			return run("preview", narratorId, userId, "read", signal, async (scope, op, devices) => {
				const file = await read(scope, parsed.data, op, devices);
				return {
					target: file.target,
					content: file.content,
					hash: file.hash,
					encoding: file.encoding,
					fileName: file.context.paths.basename(file.target.path),
				};
			});
		},
		async previewFileReferenceImage(narratorId, userId, target, signal) {
			const parsed = fileTargetSchema.safeParse(target);
			if (!parsed.success) throw zodValidationError(parsed.error);
			return run(
				"image-preview",
				narratorId,
				userId,
				"read",
				signal,
				async (scope, op, devices) => {
					const file = await authorize(scope, parsed.data, op, devices);
					const mimeType = getFileReferenceImageMimeType(file.target.path);
					if (!mimeType)
						throw failure(
							"UNSUPPORTED_IMAGE",
							"File extension is not an allowed image format",
							415,
						);
					if (file.stat.size > MAX_FILE_REFERENCE_IMAGE_BYTES)
						throw failure("SOURCE_TOO_LARGE", "Image exceeds 25 MiB", 413);
					await beforeDispatch(scope, file.device, op, file.context);
					const result = await op.wait(() =>
						file.device.backend.readFileBytes(file.context.target.lexicalPath as string, {
							maxBytes: MAX_FILE_REFERENCE_IMAGE_BYTES,
							expectedResolvedPath: file.target.path,
							signal: op.signal,
							timeoutMs: op.remaining,
						}),
					);
					if (
						!result.resolvedPath ||
						!file.context.paths.equals(result.resolvedPath, file.target.path) ||
						file.device.backend.runtimeGeneration !== file.device.generation
					)
						throw failure("IDENTITY_CHANGED", "Atomic image read identity changed", 409);
					if (
						result.truncated ||
						result.totalSize > MAX_FILE_REFERENCE_IMAGE_BYTES ||
						result.bytes.byteLength > MAX_FILE_REFERENCE_IMAGE_BYTES
					)
						throw failure(
							"SOURCE_TOO_LARGE",
							"Image exceeds 25 MiB; partial images are not accepted",
							413,
						);
					return { bytes: result.bytes, mimeType };
				},
			);
		},
		async searchFileReferences(narratorId, userId, input, signal) {
			const parsed = searchFileReferencesSchema.safeParse(input);
			if (!parsed.success) throw zodValidationError(parsed.error);
			return run("search", narratorId, userId, "read", signal, async (scope, op, devices) => {
				const query = parsed.data.q.trim();
				if (!query) return { entries: [], truncated: false };
				const deviceId = parsed.data.deviceId ?? scope.defaultDeviceId;
				const device = await deviceFor(scope, deviceId, op, devices);
				await bindingRoot(scope, device, op);
				const root = await authorize(
					scope,
					{ deviceId, path: parsed.data.directory ?? device.cwd },
					op,
					devices,
					true,
				);
				// Literal query, not a user-supplied glob. Matching happens inside the bounded scan.
				await beforeDispatch(scope, device, op, root.context);
				const matches = await op.wait(() =>
					device.backend.glob("**/*", {
						cwd: root.target.path,
						dot: false,
						maxResults: MAX_FILE_REFERENCE_SEARCH_RESULTS + 1,
						maxBytes: MAX_FILE_REFERENCE_SEARCH_BYTES,
						timeoutMs: op.remaining,
						signal: op.signal,
						includeDirectories: true,
						query,
					}),
				);
				const entries: FileReferenceCandidate[] = [];
				let truncated =
					matches.truncated === true || matches.length > MAX_FILE_REFERENCE_SEARCH_RESULTS;
				let responseBytes = Buffer.byteLength('{"entries":[],"truncated":false}');
				for (const match of matches) {
					op.check();
					if (
						match.length > MAX_FILE_REFERENCE_PATH_CHARS ||
						!match.toLowerCase().includes(query.toLowerCase())
					)
						continue;
					const lexical = device.backend.paths.resolve(root.target.path, match);
					if (!device.backend.paths.contains(root.target.path, lexical)) continue;
					try {
						await beforeDispatch(scope, device, op, root.context);
						const stat = await op.wait(() =>
							device.backend.statFile(lexical, { signal: op.signal, timeoutMs: op.remaining }),
						);
						if (!stat || (!stat.isFile && !stat.isDirectory)) continue;
						const candidate = await authorize(
							scope,
							{ deviceId, path: lexical },
							op,
							devices,
							stat.isDirectory,
						);
						const entry: FileReferenceCandidate = {
							...candidate.target,
							name: device.backend.paths.basename(candidate.target.path),
							relativePath: device.backend.paths.relative(root.target.path, candidate.target.path),
							isDirectory: stat.isDirectory,
						};
						const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
						if (
							entries.length >= MAX_FILE_REFERENCE_SEARCH_RESULTS ||
							responseBytes + size > MAX_FILE_REFERENCE_SEARCH_BYTES
						) {
							truncated = true;
							break;
						}
						responseBytes += size;
						entries.push(entry);
					} catch (error) {
						// A denied/disappeared candidate is not a navigation anchor. Backend failures fail closed.
						if (error instanceof AppError && (error.statusCode === 403 || error.statusCode === 404))
							continue;
						throw error;
					}
				}
				return { entries, truncated };
			});
		},
	};
}

/** Lazy production bindings: importing the factory in isolated tests never opens a DB. */
/** Lazy immutable bytes by a server-owned message occurrence. No current map or live source IO. */
export async function previewCapturedFileReference(
	narratorId: string,
	userId: string,
	selector: CapturedFileReferenceSelector,
	signal?: AbortSignal,
): Promise<CapturedFileReferencePreview> {
	const op = new Operation(FILE_REFERENCE_READ_TIMEOUT_MS, signal);
	try {
		if (
			![narratorId, userId, selector.messageId, selector.referenceId].every(
				(value) => typeof value === "string" && value.length > 0 && value.length <= 128,
			)
		)
			throw failure("INVALID_TARGET", "Invalid captured reference selector");
		const [{ db }, schema, { and, eq, sql }, acl] = await op.wait(() =>
			Promise.all([
				import("../db"),
				import("../db/schema"),
				import("drizzle-orm"),
				import("./narrator-acl"),
			]),
		);
		const actor = await op.wait(() =>
			db.query.users.findFirst({ where: eq(schema.users.id, userId), columns: { role: true } }),
		);
		const narrator = await op.wait(() =>
			db.query.narrators.findFirst({
				where: eq(schema.narrators.id, narratorId),
				columns: acl.NARRATOR_ACL_COLUMNS,
			}),
		);
		if (!actor || !narrator) throw new NotFoundError("Narrator", narratorId);
		await op.wait(() =>
			acl.assertNarratorAccess(narrator, { userId, isAdmin: actor.role === "admin" }, "read"),
		);
		const relation = await op.wait(() =>
			db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(schema.narratorMessageRefs.narratorId, narratorId),
					eq(schema.narratorMessageRefs.messageId, selector.messageId),
				),
				columns: { messageId: true },
			}),
		);
		if (!relation) throw new NotFoundError("Captured reference", selector.referenceId);
		// PK length gate before the JSON column is decoded; at most 1 MiB UTF-8 (256K codepoints).
		const summary = db
			.select({
				role: schema.narratorMessages.role,
				characters: sql<number>`length(cast(${schema.narratorMessages.contentJson} as text))`,
			})
			.from(schema.narratorMessages)
			.where(eq(schema.narratorMessages.id, selector.messageId))
			.get();
		if (
			!summary ||
			summary.role !== "user" ||
			!Number.isSafeInteger(summary.characters) ||
			summary.characters > 256 * 1024
		)
			throw failure(
				"SNAPSHOT_UNAVAILABLE",
				"Captured reference message is unavailable or exceeds its bounded lookup budget",
				422,
			);
		const row = await op.wait(() =>
			db.query.narratorMessages.findFirst({
				where: and(
					eq(schema.narratorMessages.id, selector.messageId),
					sql`length(cast(${schema.narratorMessages.contentJson} as text)) <= ${256 * 1024}`,
				),
				columns: { contentJson: true },
			}),
		);
		if (!Array.isArray(row?.contentJson) || row.contentJson.length > 256)
			throw failure("SNAPSHOT_UNAVAILABLE", "Captured reference message is unavailable", 422);
		const matches = row.contentJson.filter(
			(block) => isFileReferenceSnapshot(block) && block.reference.id === selector.referenceId,
		);
		if (matches.length !== 1 || !isFileReferenceSnapshot(matches[0]))
			throw failure(
				"SNAPSHOT_UNAVAILABLE",
				"Captured reference occurrence is unknown or ambiguous",
				422,
			);
		const snapshot = matches[0];
		const metadata = fileReferencesSchema.safeParse([snapshot.reference]);
		if (
			!metadata.success ||
			snapshot.capturedAt.length > 64 ||
			!/^[a-f0-9]{64}$/.test(snapshot.snapshotHash)
		)
			throw failure("SNAPSHOT_UNAVAILABLE", "Captured reference metadata is unavailable", 422);
		const origin = snapshot.sourceOrigin;
		if (
			!origin ||
			origin.version !== 1 ||
			![origin.narratorId, origin.deviceId, origin.canonicalPath].every(
				(value) => typeof value === "string" && value.length > 0 && value.length <= 4096,
			) ||
			!(origin.projectId === null || typeof origin.projectId === "string") ||
			origin.deviceId !== snapshot.reference.deviceId ||
			origin.canonicalPath !== snapshot.reference.path ||
			(origin.cwd !== undefined && (typeof origin.cwd !== "string" || origin.cwd.length > 4096))
		)
			throw failure(
				"SNAPSHOT_UNAVAILABLE",
				"Original captured reference provenance is unavailable; add a new explicit reference",
				422,
			);
		if (
			Buffer.byteLength(snapshot.snapshotText) > MAX_FILE_REFERENCE_TEXT_BYTES ||
			hashFileReferenceText(snapshot.snapshotText) !== snapshot.snapshotHash
		)
			throw failure(
				"SNAPSHOT_UNAVAILABLE",
				"Captured reference bytes are unavailable or exceed 32 KiB",
				422,
			);
		const { assertNarratorCapturedReferenceAuthority } = await op.wait(
			() => import("./workspace-artifact-access"),
		);
		const proof = await op.wait(() =>
			assertNarratorCapturedReferenceAuthority(origin, userId, op.signal),
		);
		const { narratorDeviceWorkspaceService } = await op.wait(
			() => import("./narrator-device-workspace-service"),
		);
		const requestProof = await op.wait(() =>
			narratorDeviceWorkspaceService.assertOriginalEndpointDeviceCurrent(
				narratorId,
				origin.deviceId,
				{ userId, originalProjectId: origin.projectId },
			),
		);
		const currentActor = await op.wait(() =>
			db.query.users.findFirst({ where: eq(schema.users.id, userId), columns: { role: true } }),
		);
		const currentNarrator = await op.wait(() =>
			db.query.narrators.findFirst({
				where: eq(schema.narrators.id, narratorId),
				columns: acl.NARRATOR_ACL_COLUMNS,
			}),
		);
		if (!currentActor || !currentNarrator) throw new NotFoundError("Narrator", narratorId);
		await op.wait(() =>
			acl.assertNarratorAccess(
				currentNarrator,
				{ userId, isAdmin: currentActor.role === "admin" },
				"read",
			),
		);
		proof.assertStillCurrent();
		requestProof.assertStillCurrent();
		if (
			!db
				.select({ id: schema.narratorMessageRefs.id })
				.from(schema.narratorMessageRefs)
				.where(
					and(
						eq(schema.narratorMessageRefs.narratorId, narratorId),
						eq(schema.narratorMessageRefs.messageId, selector.messageId),
					),
				)
				.limit(1)
				.get()
		)
			throw new NotFoundError("Captured reference", selector.referenceId);
		op.check();
		return {
			source: "captured_snapshot",
			readOnly: true,
			reference: snapshot.reference,
			content: snapshot.snapshotText,
			hash: snapshot.snapshotHash,
			capturedAt: snapshot.capturedAt,
		};
	} catch (error) {
		throw publicFailure(op.signal.aborted ? op.signal.reason : error);
	} finally {
		op.close();
	}
}

let deviceWorkspaceService:
	| typeof import("./narrator-device-workspace-service").narratorDeviceWorkspaceService
	| undefined;
const productionDependencies: FileReferenceDependencies = {
	async loadScope(narratorId, userId, need, options) {
		const [{ db }, schema, { eq }, acl, { resolveOAuthNarratorRuntimePolicy }] = await Promise.all([
			import("../db"),
			import("../db/schema"),
			import("drizzle-orm"),
			import("./narrator-acl"),
			import("./oauth-narrator-runtime-policy"),
		]);
		const user = await db.query.users.findFirst({
			where: eq(schema.users.id, userId),
			columns: { role: true },
		});
		const row = await db.query.narrators.findFirst({
			where: eq(schema.narrators.id, narratorId),
			columns: {
				...acl.NARRATOR_ACL_COLUMNS,
				cwd: true,
				defaultDeviceId: true,
				permissionMode: true,
				traits: true,
				relaxedPlan: true,
			},
		});
		if (!user || !row) throw new NotFoundError("Narrator", narratorId);
		await acl.assertNarratorAccess(row, { userId, isAdmin: user.role === "admin" }, need);
		const { assertWorkspaceSelectionInstalled } = await import("./workspace-context-service");
		if (!options?.originalResource) assertWorkspaceSelectionInstalled(narratorId);
		const chapter = row.chapterId
			? await db.query.chapters.findFirst({
					where: eq(schema.chapters.id, row.chapterId),
					columns: { projectId: true, worktreePath: true },
				})
			: undefined;
		if (row.chapterId && !chapter) throw new NotFoundError("Chapter", row.chapterId);
		const projectId = chapter?.projectId ?? row.contextProjectId;
		const project = projectId
			? await db.query.projects.findFirst({
					where: eq(schema.projects.id, projectId),
					columns: { gitPath: true },
				})
			: undefined;
		if (projectId && !project) throw new NotFoundError("Project", projectId);
		const runtimePolicy = await resolveOAuthNarratorRuntimePolicy(narratorId, userId);
		const permissionMode = runtimePolicy?.permissionMode ?? row.permissionMode ?? "default";
		const strictPlan =
			!runtimePolicy &&
			isPlanModeTrait(row.traits) &&
			!resolveEffectiveRelaxedPlan(permissionMode, row.relaxedPlan);
		return {
			narratorId,
			userId,
			projectId: projectId ?? null,
			cwd: "", // Absolute targets need no cwd; relative targets resolve their own pair binding.
			defaultDeviceId: row.defaultDeviceId ?? "local",
			devices: [], // Production uses the indexed per-target endpoint proof, not device enumeration.
			permissionMode: strictPlan ? "readOnly" : permissionMode,
			runtimePolicy,
		};
	},
	async getBackend(deviceId) {
		const { resolveBackend } = await import("../lib/agent/execution/registry");
		return resolveBackend({ requested: deviceId });
	},
	async resolveWorkspace(scope, deviceId, options) {
		const { narratorDeviceWorkspaceService } = await import("./narrator-device-workspace-service");
		return (
			(
				await narratorDeviceWorkspaceService.get(scope.narratorId, deviceId, {
					userId: scope.userId,
					ensureLegacy: options.required,
				})
			)?.context ?? null
		);
	},
	async assertWorkspaceCurrent(scope, workspace) {
		const { narratorDeviceWorkspaceService } = await import("./narrator-device-workspace-service");
		deviceWorkspaceService = narratorDeviceWorkspaceService;
		await narratorDeviceWorkspaceService.assertCurrent(scope.narratorId, workspace, {
			userId: scope.userId,
		});
	},
	assertWorkspaceCurrentSync(scope, workspace) {
		if (!deviceWorkspaceService) throw failure("FORBIDDEN", "Binding guard is unavailable", 403);
		deviceWorkspaceService.assertCurrentSync(scope.narratorId, workspace, { userId: scope.userId });
	},
	async authorizeEndpoint(scope, deviceId) {
		const { narratorDeviceWorkspaceService } = await import("./narrator-device-workspace-service");
		const proof = await narratorDeviceWorkspaceService.assertEndpointDeviceCurrent(
			scope.narratorId,
			deviceId,
			{ userId: scope.userId },
		);
		const { assertWorkspaceSelectionInstalled } = await import("./workspace-context-service");
		return {
			assertStillCurrent() {
				proof.assertStillCurrent();
				assertWorkspaceSelectionInstalled(scope.narratorId);
			},
		};
	},
	async readDecision(scope, context) {
		const { executionPolicyEngine } = await import("./execution-policy/engine");
		const runtime = scope.runtimePolicy;
		if (runtime) {
			if (!runtime.allowedTools.has("Read")) return "deny";
			const { integrationResourceBindingService } = await import(
				"./integration-resource-binding-service"
			);
			const binding =
				context.target.deviceId === "local"
					? null
					: await integrationResourceBindingService.get("device", context.target.deviceId);
			const deviceClass =
				context.target.deviceId === "local"
					? "host"
					: binding?.sourceType === "oauth_client" &&
							binding.sourceId === runtime.clientId &&
							binding.authorityType === "oauth_grant" &&
							binding.authorityId === runtime.grantId
						? "selfRegistered"
						: "global";
			if (runtime.policy.deviceAccess[deviceClass] === "denied") return "deny";
			context = { ...context, deviceClass };
		}
		const policy = await executionPolicyEngine.compile(
			scope.narratorId,
			context,
			runtime?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
		);
		return evaluateFileReferenceReadPolicy(scope, context, policy);
	},
	async isSecretPath(context, path) {
		// Remote paths must never pass through host path semantics. Conservatively deny known
		// credential-store segments on every device, plus the local configured NF home below.
		const segments = (
			context.paths.flavor === "windows" ? path.replaceAll("\\", "/").toLowerCase() : path
		).split("/");
		if (segments.some((part) => [".ssh", ".aws", ".gnupg", ".kube"].includes(part))) return true;
		const nf = segments.indexOf(".narrafork");
		if (nf >= 0) {
			const first = segments[nf + 1] ?? "";
			if (
				[
					"settings.json",
					"codex-credentials.json",
					"update-server.json",
					"update-server-test.json",
					"narrafork.lock",
				].includes(first) ||
				first.startsWith("narrafork.db")
			)
				return true;
		}
		if (context.backend.kind === "remote") return false;
		const [{ isSecretPlatformPath, isSecretUserPath }, { getHome }, { narraforkDir }] =
			await Promise.all([
				import("../lib/fs-secret-paths"),
				import("../lib/platform"),
				import("../lib/settings"),
			]);
		// Canonicalize the protected roots too: a symlinked custom NARRAFORK_HOME must
		// not make its settings/database readable through the target's physical spelling.
		const [platformHome, userHome] = await Promise.all([
			context.backend.resolvePathIdentity(narraforkDir),
			context.backend.resolvePathIdentity(getHome()),
		]);
		return (
			isSecretPlatformPath(path, platformHome.canonicalPath) ||
			isSecretUserPath(path, userHome.canonicalPath)
		);
	},
	async decode(bytes) {
		const { looksBinary, detectFileEncoding, decodeFileBytesAs } = await import(
			"../lib/agent/tools/encoding"
		);
		if (looksBinary(bytes)) throw failure("BINARY", "Only text files can be referenced", 415);
		// The source is already capped at 1 MiB. Use the same complete bounded input as
		// /fs/edit-source: prefix-only detection can choose UTF-8 for an ASCII prefix of
		// a GBK file, producing a different saved-text hash and an unsafe editor round trip.
		const encoding = detectFileEncoding(bytes);
		return { text: decodeFileBytesAs(bytes, encoding), encoding };
	},
	report(event) {
		if (event.failed || event.truncated || event.elapsedMs >= 500)
			void import("../lib/logger").then(({ logger }) =>
				logger.warn("File reference operation", event),
			);
	},
};

/** Editor-only authorization: uses the real reference Read policy without reading text or
 * requiring the live file to exist. Immutable source/conflict versions remain readable
 * after deletion, and commit can report the deletion as an optimistic-lock conflict.
 * Ordinary reference/preview budgets and existence checks remain unchanged. */
export async function authorizeEditorReferenceTarget(
	narratorId: string,
	userId: string,
	path: string,
	originalWorkspace?: WorkspaceContext,
	originalProjectId?: string | null,
): Promise<string> {
	const deps = productionDependencies;
	const scope = await deps.loadScope(narratorId, userId, "read", {
		originalResource: originalWorkspace !== undefined,
	});
	if (scope.runtimePolicy && !scope.runtimePolicy.allowLocalExecution)
		throw failure("FORBIDDEN", "Narrator runtime policy denies local files", 403);
	const backend = await deps.getBackend("local");
	const cwd =
		originalWorkspace?.cwd ??
		(backend.paths.isAbsolute(path) ? backend.paths.resolve(path, "..") : "");
	if (!cwd)
		throw failure("WORKSPACE_UNCONFIGURED", "Editor source requires a configured workspace", 409);
	const { assertNarratorOriginalWorkspaceAuthority } = await import("./workspace-artifact-access");
	const proof = originalWorkspace
		? await assertNarratorOriginalWorkspaceAuthority(narratorId, originalWorkspace, {
				userId,
				...(originalProjectId !== undefined ? { originalProjectId } : {}),
			})
		: await deps.authorizeEndpoint?.(scope, "local");
	proof?.assertStillCurrent();
	const resolvedContext = await createExecutionTargetContext({
		backend,
		target: {
			deviceId: "local",
			backendKind: "local",
			cwd,
			lexicalPath: backend.paths.resolve(cwd, path),
			pathFlavor: backend.pathFlavor,
			runtimeGeneration: backend.runtimeGeneration,
			selectionSource: "explicit",
		},
	});
	const context = { ...resolvedContext, fileReferenceExactOnly: !originalWorkspace };
	const canonical = context.target.canonicalPath;
	if (
		!canonical ||
		(await deps.isSecretPath(context, path)) ||
		(await deps.isSecretPath(context, canonical)) ||
		(await deps.readDecision(scope, context)) !== "allow"
	)
		throw failure("FORBIDDEN", "Read policy denies this editor source", 403);
	proof?.assertStillCurrent();
	return canonical;
}

export const fileReferenceService = createFileReferenceService(productionDependencies);
export const captureFileReferences: FileReferenceService["captureFileReferences"] = (...args) =>
	fileReferenceService.captureFileReferences(...args);
export const resolveFileReferences: FileReferenceService["resolveFileReferences"] = (...args) =>
	fileReferenceService.resolveFileReferences(...args);
export const previewFileReference: FileReferenceService["previewFileReference"] = (...args) =>
	fileReferenceService.previewFileReference(...args);
export const searchFileReferences: FileReferenceService["searchFileReferences"] = (...args) =>
	fileReferenceService.searchFileReferences(...args);
