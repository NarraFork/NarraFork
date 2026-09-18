import { describe, expect, test } from "bun:test";
import type { FileReference, FileSelection } from "@shared/file-reference";
import { MAX_FILE_REFERENCE_POSITION } from "@shared/file-reference";
import { MAX_FILE_REFERENCE_IMAGE_BYTES } from "@shared/file-reference-image";
import type {
	ExecutionBackend,
	GlobMatches,
	GlobOptions,
	ReadBytesOptions,
	ReadBytesResult,
} from "../lib/agent/execution/backend";
import { posixPathSemantics, windowsPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError, NotFoundError } from "../lib/errors";
import { DEFAULT_OAUTH_CLIENT_POLICY } from "../lib/oauth-client-policy";
import { fileReferencesSchema, fileSelectionSchema } from "../lib/validators/file-references";
import { compileExecutionPolicy } from "./execution-policy/compiler";
import { normalizeExecutionPolicyRuleSet } from "./execution-policy/normalize";
import type { ExecutionDeviceClass, LegacyExecutionPolicyRuleSet } from "./execution-policy/types";
import {
	createFileReferenceService,
	evaluateFileReferenceReadPolicy,
	type FileReferenceDependencies,
	type FileReferenceScope,
	hashFileReferenceText,
	selectFileReferenceText,
} from "./file-reference-service";

const ref = (path = "/work/file.ts", extra: Partial<FileReference> = {}): FileReference => ({
	id: "one",
	label: "file.ts",
	deviceId: "local",
	path,
	...extra,
});
const selection = (
	startLineNumber: number,
	startColumn: number,
	endLineNumber: number,
	endColumn: number,
): FileSelection => ({ startLineNumber, startColumn, endLineNumber, endColumn });

/** No real DB imports, no filesystem calls, and no globally mocked modules. */
function fixture(
	options: {
		remote?: boolean;
		windows?: boolean;
		readTimeoutMs?: number;
		searchTimeoutMs?: number;
	} = {},
) {
	const paths = options.windows ? windowsPathSemantics : posixPathSemantics;
	const cwd = options.windows ? "C:\\work" : "/work";
	const id = options.remote ? "DeviceCase" : "local";
	const files = new Map<string, string>([[paths.resolve(cwd, "file.ts"), "alpha\nbeta"]]);
	const directories = new Set([cwd]);
	const aliases = new Map<string, string>();
	const events: Array<{
		operation: string;
		elapsedMs: number;
		failed: boolean;
		truncated: boolean;
	}> = [];
	const reads: Array<{ path: string; opts?: ReadBytesOptions }> = [];
	const globs: GlobOptions[] = [];
	const access: Array<{ narratorId: string; userId: string; need: string }> = [];
	let readHook: ((path: string, opts?: ReadBytesOptions) => Promise<ReadBytesResult>) | undefined;
	let globHook: ((opts: GlobOptions) => Promise<GlobMatches>) | undefined;
	let generation = 1;
	let readDecision: "allow" | "ask" | "deny" = "allow";
	let revoked = false;
	let results: GlobMatches = [];
	const scope: FileReferenceScope = {
		narratorId: "narrator",
		userId: "visitor",
		cwd,
		defaultDeviceId: id,
		devices: options.remote
			? [{ id, name: "remote", slug: "remote", online: true, scope: "global" }]
			: [],
		permissionMode: "default",
	};
	const canonical = (path: string) =>
		aliases.get(paths.resolve(cwd, path)) ?? paths.resolve(cwd, path);
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected write/exec primitive");
	};
	const backend = {
		deviceId: id,
		kind: options.remote ? ("remote" as const) : ("local" as const),
		paths,
		pathFlavor: paths.flavor,
		defaultCwd: cwd,
		get runtimeGeneration() {
			return generation;
		},
		supportsFsStatResolvedPath: true,
		supportsFsReadAtomicResolvedPath: true as boolean,
		supportsFsReadBounded: true as boolean,
		async resolvePathIdentity(path: string) {
			const target = canonical(path);
			return {
				lexicalPath: paths.resolve(cwd, path),
				canonicalPath: target,
				exists: files.has(target) || directories.has(target),
				runtimeGeneration: generation,
			};
		},
		async statFile(path: string) {
			const target = canonical(path);
			if (directories.has(target))
				return { isFile: false, isDirectory: true, size: 0, resolvedPath: target };
			if (!files.has(target)) return null;
			return {
				isFile: true,
				isDirectory: false,
				size: Buffer.byteLength(files.get(target) as string),
				resolvedPath: target,
			};
		},
		async readFileBytes(path: string, opts?: ReadBytesOptions): Promise<ReadBytesResult> {
			reads.push({ path, opts });
			if (readHook) return readHook(path, opts);
			const bytes = new TextEncoder().encode(files.get(canonical(path)) ?? "");
			return {
				bytes,
				totalSize: bytes.byteLength,
				truncated: false,
				resolvedPath: canonical(path),
			};
		},
		async glob(_pattern: string, opts: GlobOptions) {
			globs.push(opts);
			return globHook ? globHook(opts) : results;
		},
		writeFileBytes: unexpected,
		removeFile: unexpected,
		mkdirp: unexpected,
		listDir: unexpected,
		fileExists: unexpected,
		grep: unexpected,
		execCommand: unexpected,
		gitStatus: unexpected,
		gitDiff: unexpected,
	} satisfies ExecutionBackend & {
		supportsFsStatResolvedPath: boolean;
		supportsFsReadAtomicResolvedPath: boolean;
		supportsFsReadBounded: boolean;
	};
	const deps: FileReferenceDependencies = {
		async loadScope(narratorId, userId, need) {
			access.push({ narratorId, userId, need });
			if (revoked || userId !== "visitor") throw new NotFoundError("Narrator", narratorId);
			return scope;
		},
		getBackend(deviceId) {
			if (deviceId !== id) throw new Error("Attempted local fallback");
			return backend;
		},
		async readDecision(_scope, context) {
			if (context.target.canonicalPath?.includes("denied")) return "deny";
			if (!paths.contains(cwd, context.target.canonicalPath ?? "")) return "ask";
			return readDecision;
		},
		isSecretPath(_context, path) {
			return path.includes("secret");
		},
		async decode(bytes) {
			return { text: new TextDecoder().decode(bytes), encoding: "utf-8" };
		},
		report(event) {
			events.push(event);
		},
	};
	const service = createFileReferenceService(deps, options);
	return {
		service,
		deps,
		backend,
		scope,
		cwd,
		id,
		files,
		directories,
		aliases,
		reads,
		globs,
		access,
		events,
		setReadHook(hook: typeof readHook) {
			readHook = hook;
		},
		setGlobHook(hook: typeof globHook) {
			globHook = hook;
		},
		setResults(value: GlobMatches) {
			results = value;
		},
		setDecision(value: typeof readDecision) {
			readDecision = value;
		},
		revoke() {
			revoked = true;
		},
		reconnect() {
			generation++;
		},
	};
}

describe("image file reference previews", () => {
	for (const remote of [false, true]) {
		test(`bounded binary image read through ${remote ? "remote" : "local"} backend, without widening snapshots`, async () => {
			const f = fixture({ remote });
			f.files.set("/work/image.PNG", "\0binary");
			const target = { deviceId: f.id, path: "/work/image.PNG" };
			const result = await f.service.previewFileReferenceImage("narrator", "visitor", target);
			expect(result.mimeType).toBe("image/png");
			expect(result.bytes).toEqual(new TextEncoder().encode("\0binary"));
			expect(f.reads[0].opts?.maxBytes).toBe(MAX_FILE_REFERENCE_IMAGE_BYTES);
			expect(f.reads[0].opts?.expectedResolvedPath).toBe(target.path);
			expect(f.reads[0].opts?.signal).toBeInstanceOf(AbortSignal);
			expect(f.reads[0].opts?.timeoutMs).toBeLessThanOrEqual(10_000);
			expect(f.access.every((entry) => entry.need === "read")).toBe(true);
			expect(f.events[0]).toMatchObject({ operation: "image-preview", failed: false });
			await expect(
				f.service.captureFileReferences("narrator", "visitor", [
					ref(target.path, { deviceId: f.id }),
				]),
			).rejects.toMatchObject({ code: "FILE_REFERENCE_BINARY" });
		});
	}
	test("MIME whitelist uses canonical extension, including SVG but never HTML", async () => {
		const f = fixture();
		for (const [extension, mime] of [
			["svg", "image/svg+xml"],
			["jpeg", "image/jpeg"],
			["gif", "image/gif"],
			["webp", "image/webp"],
			["bmp", "image/bmp"],
			["ico", "image/x-icon"],
			["avif", "image/avif"],
		]) {
			const path = `/work/image.${extension}`;
			f.files.set(path, "image");
			expect(
				(await f.service.previewFileReferenceImage("narrator", "visitor", { deviceId: f.id, path }))
					.mimeType,
			).toBe(mime);
		}
		f.files.set("/work/page.html", "<html/>");
		f.aliases.set("/work/fake.png", "/work/page.html");
		await expect(
			f.service.previewFileReferenceImage("narrator", "visitor", {
				deviceId: f.id,
				path: "/work/fake.png",
			}),
		).rejects.toMatchObject({ statusCode: 415 });
	});
	test("preflight cap and post-read growth/truncation/actual byte cap reject partial images", async () => {
		const f = fixture();
		const target = { deviceId: f.id, path: "/work/image.png" };
		f.files.set(target.path, "x".repeat(MAX_FILE_REFERENCE_IMAGE_BYTES + 1));
		await expect(
			f.service.previewFileReferenceImage("narrator", "visitor", target),
		).rejects.toMatchObject({ statusCode: 413 });
		expect(f.reads).toHaveLength(0);
		f.files.set(target.path, "x");
		for (const result of [
			{ bytes: new Uint8Array(1), totalSize: MAX_FILE_REFERENCE_IMAGE_BYTES + 1, truncated: false },
			{ bytes: new Uint8Array(1), totalSize: 1, truncated: true },
			{ bytes: new Uint8Array(MAX_FILE_REFERENCE_IMAGE_BYTES + 1), totalSize: 1, truncated: false },
		]) {
			f.setReadHook(async () => ({ ...result, resolvedPath: target.path }));
			await expect(
				f.service.previewFileReferenceImage("narrator", "visitor", target),
			).rejects.toMatchObject({ statusCode: 413 });
		}
	});
	test("permissions, secret paths, reconnect and canonical mismatch remain fail-closed", async () => {
		for (const scenario of [
			"ask",
			"deny",
			"secret",
			"escape",
			"reconnect",
			"mismatch",
			"missing",
			"revoked",
			"policy-change",
			"offline",
			"capability",
		] as const) {
			const f = fixture({ remote: true });
			const target = { deviceId: f.id, path: "/work/image.png" };
			f.files.set(target.path, "image");
			if (scenario === "ask" || scenario === "deny") f.setDecision(scenario);
			if (scenario === "secret" || scenario === "escape")
				f.aliases.set(
					target.path,
					scenario === "secret" ? "/work/secret.png" : "/outside/image.png",
				);
			if (scenario === "offline") f.scope.devices = [{ ...f.scope.devices[0], online: false }];
			if (scenario === "capability") f.backend.supportsFsReadBounded = false;
			f.setReadHook(async () => {
				if (scenario === "reconnect") f.reconnect();
				if (scenario === "revoked") f.revoke();
				if (scenario === "policy-change") f.setDecision("deny");
				return {
					bytes: new Uint8Array(1),
					totalSize: 1,
					truncated: false,
					resolvedPath:
						scenario === "missing"
							? undefined
							: scenario === "mismatch"
								? "/work/other.png"
								: target.path,
				};
			});
			await expect(
				f.service.previewFileReferenceImage("narrator", "visitor", target),
			).rejects.toBeInstanceOf(AppError);
		}
	});
	test("Windows image paths and the exact 25 MiB boundary are accepted without text decoding", async () => {
		const f = fixture({ remote: true, windows: true });
		const target = { deviceId: f.id, path: "C:\\work\\image.png" };
		f.files.set(target.path, "x");
		f.deps.decode = async () => {
			throw new Error("Image must not decode as text");
		};
		f.setReadHook(async () => ({
			bytes: new Uint8Array(MAX_FILE_REFERENCE_IMAGE_BYTES),
			totalSize: MAX_FILE_REFERENCE_IMAGE_BYTES,
			truncated: false,
			resolvedPath: target.path,
		}));
		expect(
			(await f.service.previewFileReferenceImage("narrator", "visitor", target)).bytes.byteLength,
		).toBe(MAX_FILE_REFERENCE_IMAGE_BYTES);
		expect(f.reads[0].opts?.expectedResolvedPath).toBe(target.path);
	});
	test("deadline and cancellation abort the backend and report failure", async () => {
		for (const cancel of [false, true]) {
			const f = fixture({ readTimeoutMs: 30 });
			const target = { deviceId: f.id, path: "/work/image.png" };
			f.files.set(target.path, "image");
			const controller = new AbortController();
			f.setReadHook(async () => {
				if (cancel) controller.abort();
				return new Promise(() => {});
			});
			await expect(
				f.service.previewFileReferenceImage("narrator", "visitor", target, controller.signal),
			).rejects.toMatchObject({ statusCode: cancel ? 499 : 408 });
			expect(f.reads[0].opts?.signal?.aborted).toBe(true);
			expect(f.events[0]).toMatchObject({ operation: "image-preview", failed: true });
		}
	});
});

function oauthFixture(deviceClass: ExecutionDeviceClass, rules: LegacyExecutionPolicyRuleSet = {}) {
	const f = fixture({ remote: deviceClass !== "host" });
	f.scope.permissionMode = "bypassPermissions";
	f.scope.runtimePolicy = {
		grantId: "grant",
		clientId: "client",
		userId: "visitor",
		projectId: null,
		defaultDeviceId: f.id,
		deviceIds: [f.id],
		permissionMode: "bypassPermissions",
		systemPrompt: undefined,
		dangerReflectionPrompt: undefined,
		useRobotDiagnosticPreset: false,
		policy: {
			...DEFAULT_OAUTH_CLIENT_POLICY,
			deviceAccess: { host: "readOnly", global: "readOnly", selfRegistered: "readOnly" },
		},
		allowedTools: new Set(["Read", "Glob", "Grep"]),
		allowLocalExecution: true,
		allowKnowledgeWrite: false,
	};
	f.directories.add("/outside");
	f.files.set("/outside/plain.ts", "outside saved text");
	f.deps.readDecision = async (scope, target) => {
		const context = { ...target, deviceClass };
		return evaluateFileReferenceReadPolicy(
			scope,
			context,
			compileExecutionPolicy(normalizeExecutionPolicyRuleSet(rules, "narrator"), context),
		);
	};
	return f;
}

describe("OAuth effective Read-only file reference authorization", () => {
	for (const deviceClass of ["host", "global", "selfRegistered"] as const) {
		test(`${deviceClass} readonly overrides stored/runtime bypass for all reference entry points`, async () => {
			const f = oauthFixture(deviceClass);
			const target = { deviceId: f.id, path: "/outside/plain.ts" };
			await expect(
				f.service.captureFileReferences("narrator", "visitor", [
					ref(target.path, { deviceId: f.id }),
				]),
			).rejects.toMatchObject({ code: "FILE_REFERENCE_FORBIDDEN" });
			await expect(
				f.service.previewFileReference("narrator", "visitor", target),
			).rejects.toMatchObject({ code: "FILE_REFERENCE_FORBIDDEN" });
			await expect(
				f.service.resolveFileReferences("narrator", "visitor", [target]),
			).rejects.toMatchObject({ code: "FILE_REFERENCE_FORBIDDEN" });
			await expect(
				f.service.searchFileReferences("narrator", "visitor", {
					q: "plain",
					deviceId: f.id,
					directory: "/outside",
				}),
			).rejects.toMatchObject({ code: "FILE_REFERENCE_FORBIDDEN" });
			expect(f.reads).toHaveLength(0);
			expect(f.globs).toHaveLength(0);
			const [inside] = await f.service.captureFileReferences("narrator", "visitor", [
				ref(undefined, { deviceId: f.id }),
			]);
			expect(inside.snapshotText).toBe("alpha\nbeta");
		});
	}
	test("effective readonly keeps explicit read whitelist and denyAll precedence", async () => {
		const f = oauthFixture("host", {
			whitelistDirs: [{ path: "/outside", accessLevel: "readOnly" }],
			blacklistDirs: [
				{ path: "/outside/private", denyLevel: "denyAll" },
				{ path: "/work/blocked", denyLevel: "denyAll" },
			],
		});
		const [allowed] = await f.service.captureFileReferences("narrator", "visitor", [
			ref("/outside/plain.ts"),
		]);
		expect(allowed.snapshotText).toBe("outside saved text");
		for (const path of ["/outside/private/file.ts", "/work/blocked/file.ts"]) {
			f.files.set(path, "must not read");
			await expect(
				f.service.captureFileReferences("narrator", "visitor", [ref(path)]),
			).rejects.toMatchObject({ code: "FILE_REFERENCE_FORBIDDEN" });
		}
		expect(f.reads).toHaveLength(1);
	});
	test("runtime readonly cannot inherit bypass from a stale persisted scope", async () => {
		const f = oauthFixture("host");
		if (!f.scope.runtimePolicy) throw new Error("Missing fixture policy");
		f.scope.runtimePolicy.permissionMode = "readOnly";
		f.scope.runtimePolicy.policy.deviceAccess.host = "readWrite";
		await expect(
			f.service.captureFileReferences("narrator", "visitor", [ref("/outside/plain.ts")]),
		).rejects.toMatchObject({ code: "FILE_REFERENCE_FORBIDDEN" });
		expect(f.reads).toHaveLength(0);
	});
	test("effective readonly hides external canonical candidates without reading source bytes", async () => {
		const f = oauthFixture("global");
		f.aliases.set("/work/link-plain.ts", "/outside/plain.ts");
		f.setResults(["file.ts", "link-plain.ts"]);
		const result = await f.service.searchFileReferences("narrator", "visitor", { q: ".ts" });
		expect(result.entries.map((entry) => entry.path)).toEqual(["/work/file.ts"]);
		expect(f.reads).toHaveLength(0);
	});
	test("device mode tightening during atomic read prevents snapshot release", async () => {
		const f = oauthFixture("selfRegistered");
		if (!f.scope.runtimePolicy) throw new Error("Missing fixture policy");
		f.scope.runtimePolicy.policy.deviceAccess.selfRegistered = "readWrite";
		f.setReadHook(async (path, opts) => {
			if (!f.scope.runtimePolicy) throw new Error("Missing fixture policy");
			f.scope.runtimePolicy.policy.deviceAccess.selfRegistered = "readOnly";
			return {
				bytes: new TextEncoder().encode(f.files.get(path)),
				totalSize: 18,
				truncated: false,
				resolvedPath: opts?.expectedResolvedPath,
			};
		});
		await expect(
			f.service.captureFileReferences("narrator", "visitor", [
				ref("/outside/plain.ts", { deviceId: f.id }),
			]),
		).rejects.toMatchObject({ code: "FILE_REFERENCE_FORBIDDEN" });
		expect(f.reads).toHaveLength(1);
	});
});

describe("file-reference metadata and positions", () => {
	test("client snapshots, duplicate IDs and malformed coordinates are rejected", () => {
		for (const field of ["snapshotText", "snapshotHash", "capturedAt", "type", "reference"])
			expect(fileReferencesSchema.safeParse([{ ...ref(), [field]: "forged" }]).success).toBe(false);
		expect(fileReferencesSchema.safeParse([ref(), ref()]).success).toBe(false);
		expect(
			fileSelectionSchema.safeParse(selection(1, 1, MAX_FILE_REFERENCE_POSITION + 1, 1)).success,
		).toBe(false);
		expect(fileReferencesSchema.safeParse([ref("/work/x\0y")]).success).toBe(false);
		expect(
			fileReferencesSchema.safeParse(
				Array.from({ length: 17 }, (_, i) => ref(undefined, { id: String(i) })),
			).success,
		).toBe(false);
		expect(
			fileReferencesSchema.safeParse(
				Array.from({ length: 16 }, (_, i) =>
					ref(undefined, { id: String(i), label: "汉".repeat(4096) }),
				),
			).success,
		).toBe(false);
	});
	test("whole-line exclusive end beyond last line canonicalizes only to EOF", () => {
		expect(selectFileReferenceText("one\r\n中文😀", selection(2, 3, 3, 1))).toEqual({
			text: "😀",
			selection: selection(2, 3, 2, 5),
		});
		expect(selectFileReferenceText("a\n", selection(1, 1, 3, 1))).toEqual({
			text: "a\n",
			selection: selection(1, 1, 2, 1),
		});
		expect(selectFileReferenceText("", selection(1, 1, 2, 1))).toEqual({
			text: "",
			selection: selection(1, 1, 1, 1),
		});
	});
	test("invalid ranges never silently become full-file references", () => {
		for (const s of [
			selection(2, 1, 2, 2),
			selection(1, 1, 3, 1),
			selection(1, 1, 2, 2),
			selection(1, 5, 1, 6),
			selection(0, 1, 1, 1),
			selection(1, 4, 1, 2),
		])
			expect(() => selectFileReferenceText("abc", s)).toThrow();
	});
});

describe("safe file capture and preview", () => {
	test("preview and expectedHash use saved decoded text; snapshot hashes only selected text", async () => {
		const f = fixture();
		f.files.set("/work/file.ts", "one\r\n中文😀");
		const preview = await f.service.previewFileReference("narrator", "visitor", {
			deviceId: "local",
			path: "/work/file.ts",
		});
		const references = [
			ref("./alias", { selection: selection(2, 3, 3, 1), expectedHash: preview.hash }),
		];
		f.aliases.set("/work/alias", "/work/file.ts");
		const [saved] = await f.service.captureFileReferences("narrator", "visitor", references);
		expect(preview.hash).toBe(hashFileReferenceText("one\r\n中文😀"));
		expect(saved.reference.path).toBe("/work/file.ts");
		expect(saved.reference.selection).toEqual(selection(2, 3, 2, 5));
		expect(saved.snapshotText).toBe("😀");
		expect(saved.snapshotHash).toBe(hashFileReferenceText("😀"));
		expect(saved.capturedAt).toMatch(/^\d{4}-/);
		expect(f.reads[1].opts?.expectedResolvedPath).toBe("/work/file.ts");
		expect(f.reads[1].opts?.maxBytes).toBe(1024 * 1024);
		expect(f.reads[1].opts?.timeoutMs).toBeLessThanOrEqual(10_000);
		expect(references[0].path).toBe("./alias");
		f.files.delete("/work/file.ts");
		expect(saved.snapshotText).toBe("😀");
	});
	test("changed saved document rejects selection without returning partial snapshots", async () => {
		const f = fixture();
		const oldHash = hashFileReferenceText("old");
		await expect(
			f.service.captureFileReferences("narrator", "visitor", [
				ref(undefined, { expectedHash: oldHash, selection: selection(1, 1, 1, 2) }),
			]),
		).rejects.toMatchObject({ code: "FILE_REFERENCE_STALE", statusCode: 409 });
	});
	test("ACL checks the actual user, with write only for capture", async () => {
		const f = fixture();
		await expect(
			f.service.captureFileReferences("narrator", "owner-not-caller", [ref()]),
		).rejects.toBeInstanceOf(NotFoundError);
		expect(f.reads).toHaveLength(0);
		await f.service.captureFileReferences("narrator", "visitor", [ref()]);
		expect(f.access.at(-1)).toEqual({ narratorId: "narrator", userId: "visitor", need: "write" });
	});
	test("ask and deny never become allow, even within cwd", async () => {
		for (const decision of ["ask", "deny"] as const) {
			const f = fixture();
			f.setDecision(decision);
			await expect(
				f.service.captureFileReferences("narrator", "visitor", [ref()]),
			).rejects.toMatchObject({ statusCode: 403 });
			expect(f.reads).toHaveLength(0);
		}
	});
	test("canonical symlink escape and secret aliases fail before reading", async () => {
		for (const canonical of ["/outside/file.ts", "/work/secret.ts"]) {
			const f = fixture();
			f.aliases.set("/work/file.ts", canonical);
			f.files.set(canonical, "protected");
			await expect(
				f.service.captureFileReferences("narrator", "visitor", [ref()]),
			).rejects.toMatchObject({ statusCode: 403 });
			expect(f.reads).toHaveLength(0);
		}
	});
	test("atomic read canonical mismatch or missing identity is fatal", async () => {
		for (const resolvedPath of [undefined, "/work/different"]) {
			const f = fixture();
			f.setReadHook(async () => ({
				bytes: new Uint8Array(1),
				totalSize: 1,
				truncated: false,
				resolvedPath,
			}));
			await expect(
				f.service.captureFileReferences("narrator", "visitor", [ref()]),
			).rejects.toMatchObject({ code: "FILE_REFERENCE_IDENTITY_CHANGED" });
		}
	});
	test("source cap, growth/truncation, binary and snapshot cap fail explicitly", async () => {
		const large = fixture();
		large.files.set("/work/file.ts", "x".repeat(1024 * 1024 + 1));
		await expect(
			large.service.captureFileReferences("narrator", "visitor", [ref()]),
		).rejects.toMatchObject({ code: "FILE_REFERENCE_SOURCE_TOO_LARGE" });
		expect(large.reads).toHaveLength(0);
		const partial = fixture();
		partial.setReadHook(async () => ({
			bytes: new Uint8Array(1),
			totalSize: 2,
			truncated: true,
			resolvedPath: "/work/file.ts",
		}));
		await expect(
			partial.service.previewFileReference("narrator", "visitor", {
				deviceId: "local",
				path: "/work/file.ts",
			}),
		).rejects.toMatchObject({ statusCode: 413 });
		const binary = fixture();
		binary.files.set("/work/file.ts", "\0binary");
		await expect(
			binary.service.captureFileReferences("narrator", "visitor", [ref()]),
		).rejects.toMatchObject({ code: "FILE_REFERENCE_BINARY" });
		const text = fixture();
		text.files.set("/work/file.ts", "汉".repeat(11000));
		await expect(
			text.service.captureFileReferences("narrator", "visitor", [ref()]),
		).rejects.toMatchObject({ code: "FILE_REFERENCE_SNAPSHOT_TOO_LARGE" });
	});
	test("a 1 MiB source can supply a small range; aggregate snapshot cap is enforced", async () => {
		const f = fixture();
		f.files.set("/work/file.ts", "x".repeat(1024 * 1024));
		expect(
			(
				await f.service.captureFileReferences("narrator", "visitor", [
					ref(undefined, { selection: selection(1, 1, 1, 10) }),
				])
			)[0].snapshotText,
		).toHaveLength(9);
		f.files.set("/work/file.ts", "x".repeat(32 * 1024));
		await expect(
			f.service.captureFileReferences(
				"narrator",
				"visitor",
				Array.from({ length: 5 }, (_, i) => ref(undefined, { id: String(i) })),
			),
		).rejects.toMatchObject({ code: "FILE_REFERENCE_SNAPSHOT_TOO_LARGE" });
	});
	test("resolve validates positions but never includes source text", async () => {
		const f = fixture();
		const targets = await f.service.resolveFileReferences("narrator", "visitor", [
			{ deviceId: "local", path: "./file.ts", selection: selection(2, 1, 3, 1) },
		]);
		expect(targets).toEqual([
			{ deviceId: "local", path: "/work/file.ts", selection: selection(2, 1, 2, 5) },
		]);
		expect(JSON.stringify(targets)).not.toContain("alpha");
		await expect(
			f.service.resolveFileReferences("narrator", "visitor", [
				{ deviceId: "local", path: "file.ts", selection: selection(8, 1, 9, 1) },
			]),
		).rejects.toMatchObject({ code: "FILE_REFERENCE_INVALID_SELECTION" });
		await expect(
			f.service.captureFileReferences("narrator", "visitor", [ref("/work")]),
		).rejects.toMatchObject({ code: "FILE_REFERENCE_INVALID_TARGET" });
	});
	test("read concurrency is at most two", async () => {
		const f = fixture();
		let active = 0;
		let peak = 0;
		f.setReadHook(async (_path, opts) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return {
				bytes: new TextEncoder().encode("ok"),
				totalSize: 2,
				truncated: false,
				resolvedPath: opts?.expectedResolvedPath,
			};
		});
		await f.service.captureFileReferences(
			"narrator",
			"visitor",
			Array.from({ length: 16 }, (_, i) => ref(undefined, { id: String(i) })),
		);
		expect(peak).toBe(2);
	});
	test("shared deadline aborts outstanding reads and no remaining references start", async () => {
		const f = fixture({ readTimeoutMs: 25 });
		let cancelled = 0;
		f.setReadHook(
			(_path, opts) =>
				new Promise((_resolve, reject) =>
					opts?.signal?.addEventListener(
						"abort",
						() => {
							cancelled++;
							reject(opts.signal?.reason);
						},
						{ once: true },
					),
				),
		);
		await expect(
			f.service.captureFileReferences(
				"narrator",
				"visitor",
				Array.from({ length: 8 }, (_, i) => ref(undefined, { id: String(i) })),
			),
		).rejects.toMatchObject({ code: "FILE_REFERENCE_TIMEOUT" });
		expect(cancelled).toBe(2);
		expect(f.reads).toHaveLength(2);
		expect(f.events[0].failed).toBe(true);
	});
	test("external cancellation before ACL and ACL revocation during a read fail closed", async () => {
		const f = fixture();
		const abort = new AbortController();
		abort.abort();
		await expect(
			f.service.captureFileReferences("narrator", "visitor", [ref()], abort.signal),
		).rejects.toMatchObject({ code: "FILE_REFERENCE_CANCELLED" });
		expect(f.access).toHaveLength(0);
		f.setReadHook(async (_path, opts) => {
			f.revoke();
			return {
				bytes: new Uint8Array(),
				totalSize: 0,
				truncated: false,
				resolvedPath: opts?.expectedResolvedPath,
			};
		});
		await expect(
			f.service.captureFileReferences("narrator", "visitor", [ref()]),
		).rejects.toBeInstanceOf(NotFoundError);
	});
	test("remote device authorization, offline, legacy capabilities and generation drift never fallback", async () => {
		for (const variant of [
			"unauthorized",
			"offline",
			"legacy",
			"unbounded",
			"generation",
		] as const) {
			const f = fixture({ remote: true });
			if (variant === "unauthorized") f.scope.devices = [];
			if (variant === "offline") f.scope.devices = [{ ...f.scope.devices[0], online: false }];
			if (variant === "legacy") f.backend.supportsFsReadAtomicResolvedPath = false;
			if (variant === "unbounded") f.backend.supportsFsReadBounded = false;
			if (variant === "generation")
				f.setReadHook(async (_path, opts) => {
					f.reconnect();
					return {
						bytes: new Uint8Array(),
						totalSize: 0,
						truncated: false,
						resolvedPath: opts?.expectedResolvedPath,
					};
				});
			await expect(
				f.service.captureFileReferences("narrator", "visitor", [
					ref(undefined, { deviceId: f.id }),
				]),
			).rejects.toBeInstanceOf(AppError);
			if (variant !== "generation") expect(f.reads).toHaveLength(0);
		}
	});
	test("Windows targets use remote grammar and preserve device ID case", async () => {
		const f = fixture({ remote: true, windows: true });
		const [saved] = await f.service.captureFileReferences("narrator", "visitor", [
			ref(".\\file.ts", { deviceId: f.id }),
		]);
		expect(saved.reference.path).toBe("C:\\work\\file.ts");
		expect(saved.reference.deviceId).toBe("DeviceCase");
		for (const path of ["C:\\work\\file.ts:private", "\\\\.\\pipe\\secret", "C:relative.ts"]) {
			await expect(
				f.service.captureFileReferences("narrator", "visitor", [ref(path, { deviceId: f.id })]),
			).rejects.toMatchObject({ code: "FILE_REFERENCE_INVALID_TARGET" });
		}
	});
});

test("Read policy revoked during capture and unsupported executor RPCs fail explicitly", async () => {
	const f = fixture();
	f.setReadHook(async (_path, opts) => {
		f.setDecision("deny");
		return {
			bytes: new Uint8Array(),
			totalSize: 0,
			truncated: false,
			resolvedPath: opts?.expectedResolvedPath,
		};
	});
	await expect(
		f.service.captureFileReferences("narrator", "visitor", [ref()]),
	).rejects.toMatchObject({ code: "FILE_REFERENCE_FORBIDDEN" });
	const remote = fixture({ remote: true });
	remote.setGlobHook(async () => {
		throw Object.assign(new Error("missing glob.bounded.v1"), { name: "DeviceCapabilityError" });
	});
	await expect(
		remote.service.searchFileReferences("narrator", "visitor", { q: "file" }),
	).rejects.toMatchObject({ code: "FILE_REFERENCE_UNSUPPORTED", statusCode: 422 });
});

describe("bounded metadata-only file search", () => {
	test("empty query checks narrator ACL but never scans or resolves a backend", async () => {
		const f = fixture();
		f.deps.getBackend = () => {
			throw new Error("must not resolve");
		};
		expect(await f.service.searchFileReferences("narrator", "visitor", { q: "  " })).toEqual({
			entries: [],
			truncated: false,
		});
		expect(f.globs).toHaveLength(0);
	});
	test("default remote device is made explicit; denied/secret entries cannot become anchors", async () => {
		const f = fixture({ remote: true });
		f.files.set("/work/file-denied.ts", "denied");
		f.files.set("/work/file-secret.ts", "secret");
		f.directories.add("/work/file-dir");
		f.setResults(["file.ts", "file-denied.ts", "file-secret.ts", "file-dir", "../file.ts"]);
		const result = await f.service.searchFileReferences("narrator", "visitor", { q: "file" });
		expect(result.entries.map((e) => [e.deviceId, e.name, e.isDirectory])).toEqual([
			[f.id, "file.ts", false],
			[f.id, "file-dir", true],
		]);
		expect(f.reads).toHaveLength(0);
		expect(f.globs[0]).toMatchObject({
			cwd: "/work",
			query: "file",
			maxResults: 51,
			maxBytes: 128 * 1024,
			includeDirectories: true,
		});
		expect(f.globs[0].timeoutMs).toBeLessThanOrEqual(2000);
		expect(f.globs[0].signal).toBeInstanceOf(AbortSignal);
	});
	test("search count, response bytes and underlying scan truncation are surfaced", async () => {
		const f = fixture();
		const paths = Array.from({ length: 51 }, (_, i) => `file-${i}.ts`);
		for (const path of paths) f.files.set(`/work/${path}`, "x");
		f.setResults(paths);
		const result = await f.service.searchFileReferences("narrator", "visitor", { q: "file" });
		expect(result.entries).toHaveLength(50);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
		const hugePaths = Array.from({ length: 25 }, (_, i) => `file-${i}-${"汉".repeat(3500)}`);
		for (const path of hugePaths) f.files.set(`/work/${path}`, "x");
		f.setResults(hugePaths);
		const byBytes = await f.service.searchFileReferences("narrator", "visitor", { q: "file" });
		expect(byBytes.truncated).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(byBytes))).toBeLessThanOrEqual(128 * 1024);
		f.setResults(Object.assign([], { truncated: true }));
		expect(
			(await f.service.searchFileReferences("narrator", "visitor", { q: "file" })).truncated,
		).toBe(true);
	});
	test("query length is validated and directory read denial prevents scanning", async () => {
		const f = fixture();
		await expect(
			f.service.searchFileReferences("narrator", "visitor", { q: "x".repeat(257) }),
		).rejects.toMatchObject({ statusCode: 400 });
		f.setDecision("deny");
		await expect(
			f.service.searchFileReferences("narrator", "visitor", { q: "file" }),
		).rejects.toMatchObject({ statusCode: 403 });
		expect(f.globs).toHaveLength(0);
	});
	test("a scan with no matches is actually cancelled on the total budget", async () => {
		const f = fixture({ searchTimeoutMs: 20 });
		let cancelled = false;
		f.setGlobHook(
			(opts) =>
				new Promise((_resolve, reject) =>
					opts.signal?.addEventListener(
						"abort",
						() => {
							cancelled = true;
							reject(opts.signal?.reason);
						},
						{ once: true },
					),
				),
		);
		await expect(
			f.service.searchFileReferences("narrator", "visitor", { q: "no-match" }),
		).rejects.toMatchObject({ code: "FILE_REFERENCE_TIMEOUT" });
		expect(cancelled).toBe(true);
		expect(f.reads).toHaveLength(0);
	});
});
