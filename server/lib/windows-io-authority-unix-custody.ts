import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, normalize, parse, resolve } from "node:path";
import {
	parseWindowsFirstCaptureBytes,
	WINDOWS_FIRST_CAPTURE_LIMITS,
	windowsFirstCaptureEnrollmentInspectionRequestSchema,
	windowsFirstCaptureEnrollmentSchema,
} from "@shared/windows-first-capture";
import {
	canonicalWindowsIoJson,
	parseWindowsIoTicketSignedBytes,
	WINDOWS_IO_AUTHORITY_LIMITS,
	type WindowsIoTicketPayload,
	windowsIoTicketSignedBytes,
} from "@shared/windows-io-authority";
import { z } from "zod";
import {
	createWindowsIoExternalBrokerSigner,
	type WindowsIoExternalBrokerConfig,
	type WindowsIoKeyCustodyAdapter,
} from "./windows-io-authority-broker-client";
import { decodeWindowsIoBase64url, type WindowsIoPublicPin } from "./windows-io-authority-crypto";
import { verifyFirstCaptureEnrollmentInspection } from "./windows-io-authority-first-capture-proof";

const principal = z.number().int().positive().max(0xffffffff);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nativeIdentity = z.strictObject({
	pid: z.number().int().min(2),
	uid: principal,
	parentPid: z.number().int().positive(),
	startTime: z.string().regex(/^[0-9]+$/),
	exe: z.string().min(1).max(4096),
	exeSha256: digest,
	noNewPrivileges: z.literal(true),
	effectiveCapabilities: z.union([z.literal(0), z.literal(1 << 19)]),
	permittedCapabilities: z.union([z.literal(0), z.literal(1 << 19)]),
	ambientCapabilities: z.union([z.literal(0), z.literal(1 << 19)]),
});
const nativeDescriptor = z.strictObject({
	volumeId: z.string().min(1).max(256),
	fileId: z.string().min(1).max(256),
	creationTime: z.string().min(1).max(256),
	pathKey: z.string().min(1).max(4096),
});
const custodyModel = z.enum(["hardware_nonexportable", "os_isolated_software"]);
const publicPin = z.strictObject({
	issuer: z.string().min(1).max(256),
	serviceId: z.string().min(1).max(256),
	keyEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	publicKey: z.string().length(43),
});
const administratorConfigSchema = z.strictObject({
	version: z.literal(1),
	brokerServiceId: z.string().min(1).max(256),
	pin: publicPin,
	brokerUid: principal,
	authUid: principal,
	authGid: principal,
	toolWorkerUids: z.array(principal).min(1).max(64),
	toolWorkerProcesses: z.array(nativeIdentity).min(1).max(64),
	allowRegisteredAuthGrantPublication: z.boolean(),
	dynamicGrantsFile: z.string().min(1).max(4096),
	firstCaptureEnrollmentFile: z.string().min(1).max(4096).optional(),
	binary: z.string().min(1).max(4096),
	binarySha256: digest,
	socket: z.string().min(1).max(4096),
	privateDir: z.string().min(1).max(4096),
	keyFile: z.string().min(1).max(4096),
	stateFile: z.string().min(1).max(4096),
	grantsFile: z.string().min(1).max(4096),
	authProcess: nativeIdentity,
	brokerProcess: nativeIdentity,
	authCodeRoot: z.string().min(1).max(4096),
	authEntry: z.string().min(1).max(4096),
	allowedCustodyModels: z.array(custodyModel).min(1).max(2),
	allowedRoots: z.array(nativeDescriptor).min(1).max(64),
	allowedBindings: z
		.array(
			z.strictObject({
				deviceId: z.string().min(1).max(256),
				executorSourceId: z.string().min(1).max(256),
				helperInstanceId: z.string().min(1).max(256),
				root: nativeDescriptor,
			}),
		)
		.min(1)
		.max(64),
	allowedActions: z.array(z.string().min(1).max(32)).min(1).max(7),
});
const securityFactsSchema = z.strictObject({
	brokerServiceId: z.string(),
	brokerPrincipal: z.string(),
	authServicePrincipal: z.string(),
	toolWorkerPrincipals: z.array(z.string()).min(1).max(64),
	custodyModel: z.literal("os_isolated_software"),
	allowedCustodyModels: z.array(custodyModel).min(1).max(2),
	brokerProcessBound: z.literal(true),
	authServiceProcessBound: z.literal(true),
	signingContractValidated: z.literal(true),
	signerRestrictsRootAndAction: z.literal(true),
	singleActionGrantRequired: z.literal(true),
	durableReplayProtection: z.literal(true),
	// Software seed enters isolated daemon memory: NEVER claim hardware custody.
	keyNonExportable: z.literal(false),
	keyAclAdminAndBrokerOnly: z.literal(true),
	configAclAdminOnly: z.literal(true),
	callerAclAuthServiceOnly: z.literal(true),
	workerCannotImpersonateAuthService: z.literal(true),
	peerAuthenticatedByOs: z.literal(true),
	brokerRestrictsWindowsIoContract: z.literal(true),
});
const probeSchema = z.strictObject({
	version: z.literal(1),
	domain: z.literal("windows_io_broker_security_probe_v1"),
	challenge: z.string().length(43),
	phase: z.enum(["before", "after"]),
	configDigest: digest,
	issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	broker: nativeIdentity,
	caller: nativeIdentity,
	authProcess: nativeIdentity,
	workerProcesses: z.array(nativeIdentity).min(1).max(64),
	custodyModel: z.literal("os_isolated_software"),
	facts: securityFactsSchema,
});
const proofSchema = z.strictObject({
	version: z.literal(1),
	payload: z
		.string()
		.min(1)
		.max(64 * 1024),
	signature: z.string().length(86),
});

/** Public administrator pins only. Never pass a seed, token, UID claim or test runner here. */
export interface WindowsIoUnixCustodyOptions {
	binaryPath: string;
	administratorConfigPath: string;
	pin: WindowsIoPublicPin;
}
type AdministratorConfig = z.infer<typeof administratorConfigSchema>;
type Probe = z.infer<typeof probeSchema>;
function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function strictJson<T>(bytes: Uint8Array, schema: z.ZodType<T>, canonical: boolean): T {
	const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const result = schema.parse(JSON.parse(raw));
	// Roundtrip rejects duplicate/unknown keys and noncanonical number/escape spelling.
	if ((canonical ? canonicalWindowsIoJson(result) : JSON.stringify(result)) !== raw)
		throw new Error("WINDOWS_IO_CUSTODY_NONCANONICAL_PROOF");
	return result;
}
async function protectedObject(path: string, directory = false): Promise<void> {
	if (!isAbsolute(path) || normalize(path) !== path)
		throw new Error("WINDOWS_IO_CUSTODY_ABSOLUTE_PATH_REQUIRED");
	const root = parse(path).root;
	let current = root;
	const parts = path.slice(root.length).split("/").filter(Boolean);
	for (let index = -1; index < parts.length; index++) {
		if (index >= 0) current = resolve(current, parts[index]);
		const stat = await lstat(current);
		const last = index === parts.length - 1;
		if (
			stat.isSymbolicLink() ||
			stat.uid !== 0 ||
			(stat.mode & 0o022) !== 0 ||
			(!last && !stat.isDirectory()) ||
			(last && (directory ? !stat.isDirectory() : !stat.isFile()))
		)
			throw new Error("WINDOWS_IO_CUSTODY_ADMIN_PATH_UNPROTECTED");
	}
}
async function readProtected(path: string, limit: number): Promise<Uint8Array> {
	await protectedObject(path);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await file.stat();
		if (!before.isFile() || before.uid !== 0 || (before.mode & 0o022) !== 0 || before.size > limit)
			throw new Error("WINDOWS_IO_CUSTODY_FILE_BUDGET_OR_OWNERSHIP");
		const bytes = new Uint8Array(before.size + 1);
		let used = 0;
		while (used < bytes.length) {
			const { bytesRead } = await file.read(bytes, used, bytes.length - used, used);
			if (bytesRead === 0) break;
			used += bytesRead;
		}
		const after = await file.stat();
		if (
			used > limit ||
			before.size !== used ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs
		)
			throw new Error("WINDOWS_IO_CUSTODY_FILE_CHANGED");
		return bytes.slice(0, used);
	} finally {
		await file.close();
	}
}
async function administratorState(options: WindowsIoUnixCustodyOptions) {
	if (process.platform !== "linux")
		throw new Error("WINDOWS_IO_UNIX_CUSTODY_REQUIRES_LINUX_SO_PEERCRED");
	const raw = await readProtected(options.administratorConfigPath, 64 * 1024);
	// Administrator files can be pretty-printed; the daemon checks duplicate keys.
	// Here parse via schema, then its native proof binds the entire original bytes.
	const config = administratorConfigSchema.parse(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
	);
	if (
		config.binary !== options.binaryPath ||
		canonicalWindowsIoJson(config.pin) !== canonicalWindowsIoJson(options.pin) ||
		config.brokerUid === config.authUid ||
		config.authUid !== process.getuid?.() ||
		config.authProcess.pid !== process.pid ||
		config.authProcess.uid !== config.authUid ||
		config.brokerProcess.uid !== config.brokerUid ||
		config.brokerProcess.exe !== config.binary ||
		config.brokerProcess.exeSha256 !== config.binarySha256 ||
		config.toolWorkerUids.some((uid) => uid === config.authUid || uid === config.brokerUid) ||
		new Set(config.toolWorkerUids).size !== config.toolWorkerUids.length ||
		config.authProcess.effectiveCapabilities !== 0 ||
		config.authProcess.permittedCapabilities !== 0 ||
		config.authProcess.ambientCapabilities !== 0 ||
		config.toolWorkerProcesses.length !== config.toolWorkerUids.length ||
		config.toolWorkerProcesses.some(
			(worker, index) =>
				worker.uid !== config.toolWorkerUids[index] ||
				worker.effectiveCapabilities !== 0 ||
				worker.permittedCapabilities !== 0 ||
				worker.ambientCapabilities !== 0,
		)
	)
		throw new Error("WINDOWS_IO_CUSTODY_ISOLATION_OR_PIN_MISMATCH");
	await protectedObject(options.binaryPath);
	const executable = await lstat(options.binaryPath);
	if (executable.size > 64 * 1024 * 1024 || (executable.mode & 0o111) === 0)
		throw new Error("WINDOWS_IO_CUSTODY_BINARY_BUDGET_OR_MODE");
	// Large executable hashing belongs to the bounded Go subprocess/service, not
	// Bun's HTTP/WS main thread. Its signed native proof binds both actual kernel
	// executable hashes to the administrator pin; here check admin ownership only.
	await protectedObject(config.authProcess.exe);
	await protectedObject(config.authCodeRoot, true);
	await protectedObject(config.authEntry);
	return { config, digest: sha256(raw) };
}
async function boundedRead(stream: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal) {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		while (true) {
			signal.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new Error("WINDOWS_IO_CUSTODY_OUTPUT_BUDGET");
			chunks.push(value);
		}
		signal.throwIfAborted();
		const out = new Uint8Array(size);
		let at = 0;
		for (const chunk of chunks) {
			out.set(chunk, at);
			at += chunk.byteLength;
		}
		return out;
	} finally {
		signal.removeEventListener("abort", cancel);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
async function invoke(
	options: WindowsIoUnixCustodyOptions,
	request: Uint8Array,
	signal: AbortSignal,
	limit: number,
) {
	signal.throwIfAborted();
	if (
		request.byteLength === 0 ||
		request.byteLength > WINDOWS_IO_AUTHORITY_LIMITS.helperMessageBytes ||
		limit < 1 ||
		limit > 64 * 1024
	)
		throw new Error("WINDOWS_IO_CUSTODY_IPC_BUDGET");
	const child = Bun.spawn(
		[options.binaryPath, "--client", "--config", options.administratorConfigPath],
		{
			cwd: dirname(options.binaryPath),
			env: {},
			stdin: new Blob([new Uint8Array(request)]),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stop = () => {
		child.kill();
	};
	signal.addEventListener("abort", stop, { once: true });
	try {
		if (signal.aborted) stop();
		const [bytes, , exit] = await Promise.all([
			boundedRead(child.stdout, limit, signal),
			boundedRead(child.stderr, 4096, signal),
			child.exited,
		]);
		signal.throwIfAborted();
		if (exit !== 0) throw new Error("WINDOWS_IO_SIGNING_BROKER_NATIVE_UNREADY");
		return { bytes, pid: child.pid };
	} finally {
		signal.removeEventListener("abort", stop);
		child.kill();
	}
}
function verifyProbe(
	bytes: Uint8Array,
	pin: WindowsIoPublicPin,
	config: AdministratorConfig,
	configDigest: string,
	challenge: string,
	phase: "before" | "after",
	childPid: number,
): Probe {
	const proof = strictJson(bytes, proofSchema, false);
	const raw = decodeWindowsIoBase64url(proof.payload, 48 * 1024);
	const publicBytes = decodeWindowsIoBase64url(pin.publicKey, 32);
	if (publicBytes.byteLength !== 32) throw new Error("WINDOWS_IO_CUSTODY_INVALID_PIN");
	const key = createPublicKey({
		key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicBytes]),
		format: "der",
		type: "spki",
	});
	if (!verify(null, raw, key, decodeWindowsIoBase64url(proof.signature, 64)))
		throw new Error("WINDOWS_IO_CUSTODY_INVALID_NATIVE_SIGNATURE");
	const result = strictJson(raw, probeSchema, true);
	const now = Date.now();
	if (
		result.challenge !== challenge ||
		result.phase !== phase ||
		result.configDigest !== configDigest ||
		result.issuedAt > now ||
		now - result.issuedAt > WINDOWS_IO_AUTHORITY_LIMITS.signingTimeoutMs ||
		canonicalWindowsIoJson(result.broker) !== canonicalWindowsIoJson(config.brokerProcess) ||
		canonicalWindowsIoJson(result.authProcess) !== canonicalWindowsIoJson(config.authProcess) ||
		result.caller.pid !== childPid ||
		result.caller.parentPid !== process.pid ||
		result.caller.uid !== config.authUid ||
		result.caller.exe !== config.binary ||
		result.caller.exeSha256 !== config.binarySha256 ||
		result.caller.effectiveCapabilities !== 0 ||
		result.caller.permittedCapabilities !== 0 ||
		result.caller.ambientCapabilities !== 0 ||
		canonicalWindowsIoJson(result.workerProcesses) !==
			canonicalWindowsIoJson(config.toolWorkerProcesses) ||
		result.facts.brokerServiceId !== config.brokerServiceId ||
		result.facts.brokerPrincipal !== `uid:${config.brokerUid}` ||
		result.facts.authServicePrincipal !== `uid:${config.authUid}` ||
		canonicalWindowsIoJson(result.facts.allowedCustodyModels) !==
			canonicalWindowsIoJson(config.allowedCustodyModels) ||
		canonicalWindowsIoJson(result.facts.toolWorkerPrincipals) !==
			canonicalWindowsIoJson(config.toolWorkerUids.map((uid) => `uid:${uid}`).sort())
	)
		throw new Error("WINDOWS_IO_CUSTODY_NATIVE_BINDING_MISMATCH");
	return result;
}
const signRequestSchema = z.strictObject({
	version: z.literal(1),
	method: z.literal("sign_windows_io_authorization"),
	payload: z
		.string()
		.min(1)
		.max(22 * 1024),
});
const grantReceiptSchema = z.strictObject({
	version: z.literal(1),
	payloadDigest: digest,
	expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
async function publishNativeGrant(
	options: WindowsIoUnixCustodyOptions,
	payload: WindowsIoTicketPayload,
	signal: AbortSignal,
) {
	const before = await administratorState(options);
	if (
		!before.config.allowRegisteredAuthGrantPublication ||
		!before.config.allowedCustodyModels.includes("os_isolated_software")
	)
		throw new Error("WINDOWS_IO_AUTH_GRANT_PUBLICATION_NOT_ADMIN_DELEGATED");
	const raw = windowsIoTicketSignedBytes(payload);
	const request = new TextEncoder().encode(
		JSON.stringify({
			version: 1,
			method: "authorize_windows_io_operation",
			payload: Buffer.from(raw).toString("base64url"),
		}),
	);
	const result = await invoke(options, request, signal, 1024);
	const receipt = strictJson(result.bytes, grantReceiptSchema, false);
	const after = await administratorState(options);
	signal.throwIfAborted();
	if (
		before.digest !== after.digest ||
		receipt.payloadDigest !== sha256(raw) ||
		receipt.expiresAt !== payload.expiresAt
	)
		throw new Error("WINDOWS_IO_NATIVE_GRANT_BINDING_MISMATCH");
}
/** Only the administrator-enrolled immutable authority process can publish. Call
 * after genuine actor/ACL/original-operation revalidation; NOT a model/API body
 * privilege primitive. The daemon checks the exact bounded contract and OS caller. */
export function createWindowsIoUnixGrantPublisher(options: WindowsIoUnixCustodyOptions) {
	const frozen = Object.freeze({ ...options, pin: Object.freeze({ ...options.pin }) });
	return {
		async publishAuthorizedPayloadGrant(
			payload: WindowsIoTicketPayload,
			signal: AbortSignal,
		): Promise<void> {
			const bounded = AbortSignal.any([
				signal,
				AbortSignal.timeout(WINDOWS_IO_AUTHORITY_LIMITS.signingTimeoutMs),
			]);
			bounded.throwIfAborted();
			await createWindowsIoUnixCustodyAdapter(frozen).inspectSecurityContext(bounded);
			await publishNativeGrant(frozen, payload, bounded);
		},
	};
}
/** Uses actual root-owned executable, kernel peer credential checks and pinned signed
 * challenge evidence. No injected booleans/process runners are accepted. No default
 * deployment is created: absent registration, isolated UIDs, grants or protected key
 * storage fail closed. Software custody additionally needs explicit admin policy. */
export function createWindowsIoUnixCustodyAdapter(
	options: WindowsIoUnixCustodyOptions,
): WindowsIoKeyCustodyAdapter {
	const frozen = Object.freeze({ ...options, pin: Object.freeze({ ...options.pin }) });
	return {
		async inspectSecurityContext(signal) {
			const bounded = AbortSignal.any([
				signal,
				AbortSignal.timeout(WINDOWS_IO_AUTHORITY_LIMITS.signingTimeoutMs),
			]);
			bounded.throwIfAborted();
			const initial = await administratorState(frozen);
			const challenge = randomBytes(32).toString("base64url");
			let last: Probe | undefined;
			for (const phase of ["before", "after"] as const) {
				const request = new TextEncoder().encode(
					JSON.stringify({ version: 1, method: "inspect_windows_io_security", challenge, phase }),
				);
				const response = await invoke(frozen, request, bounded, 64 * 1024);
				last = verifyProbe(
					response.bytes,
					frozen.pin,
					initial.config,
					initial.digest,
					challenge,
					phase,
					response.pid,
				);
			}
			const final = await administratorState(frozen);
			bounded.throwIfAborted();
			if (initial.digest !== final.digest || !last)
				throw new Error("WINDOWS_IO_CUSTODY_CHANGED_DURING_PROBE");
			return last.facts;
		},
		async exchange(request, signal, responseByteLimit) {
			const bounded = AbortSignal.any([
				signal,
				AbortSignal.timeout(WINDOWS_IO_AUTHORITY_LIMITS.signingTimeoutMs),
			]);
			bounded.throwIfAborted();
			const before = await administratorState(frozen);
			const parsed = strictJson(request, signRequestSchema, false);
			const payload = parseWindowsIoTicketSignedBytes(
				decodeWindowsIoBase64url(parsed.payload, WINDOWS_IO_AUTHORITY_LIMITS.payloadBytes),
			);
			// The service factory has already revalidated authentic actor and exact
			// original-operation ACL before reaching this external signer. Publication
			// is additionally delegated in live root policy, not a request boolean.
			if (before.config.allowRegisteredAuthGrantPublication)
				await publishNativeGrant(frozen, payload, bounded);
			const result = await invoke(frozen, request, bounded, responseByteLimit);
			const after = await administratorState(frozen);
			bounded.throwIfAborted();
			if (before.digest !== after.digest)
				throw new Error("WINDOWS_IO_CUSTODY_CHANGED_DURING_SIGNING");
			return result.bytes;
		},
	};
}
export function createWindowsIoUnixBrokerSigner(
	config: WindowsIoExternalBrokerConfig,
	options: WindowsIoUnixCustodyOptions,
) {
	if (canonicalWindowsIoJson(config.pin) !== canonicalWindowsIoJson(options.pin))
		throw new Error("WINDOWS_IO_CUSTODY_PIN_MISMATCH");
	return createWindowsIoExternalBrokerSigner(config, createWindowsIoUnixCustodyAdapter(options));
}
/** Bounded administrator public-file read only. No ordinary workspace/config paths,
 * secrets or process runners can instantiate a custody proof through this function. */
export async function readWindowsIoProtectedPublicFile(
	path: string,
	limit: number,
): Promise<Uint8Array> {
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > WINDOWS_FIRST_CAPTURE_LIMITS.configurationBytes
	)
		throw new Error("WINDOWS_IO_PUBLIC_CONFIGURATION_BUDGET");
	return readProtected(path, limit);
}
export function createWindowsIoUnixFirstCaptureEnrollmentInspector(
	options: WindowsIoUnixCustodyOptions,
	enrollmentFile: string,
) {
	const frozen = Object.freeze({ ...options, pin: Object.freeze({ ...options.pin }) });
	return async (signal: AbortSignal) => {
		const bounded = AbortSignal.any([
			signal,
			AbortSignal.timeout(WINDOWS_IO_AUTHORITY_LIMITS.signingTimeoutMs),
		]);
		bounded.throwIfAborted();
		const before = await administratorState(frozen);
		if (before.config.firstCaptureEnrollmentFile !== enrollmentFile)
			throw new Error("WINDOWS_IO_FIRST_CAPTURE_ENROLLMENT_NOT_ADMIN_REGISTERED");
		const initialBytes = await readProtected(
			enrollmentFile,
			WINDOWS_FIRST_CAPTURE_LIMITS.configurationBytes,
		);
		const initial = parseWindowsFirstCaptureBytes(
			initialBytes,
			windowsFirstCaptureEnrollmentSchema,
		);
		const allowed = before.config.allowedBindings.some(
			(binding) =>
				binding.deviceId === initial.deviceId &&
				binding.executorSourceId === initial.executorSourceId &&
				binding.helperInstanceId === initial.helperInstanceId &&
				canonicalWindowsIoJson(binding.root) === canonicalWindowsIoJson(initial.root),
		);
		if (
			!allowed ||
			!before.config.allowedActions.includes("capture_exact") ||
			!before.config.allowedRoots.some(
				(root) => canonicalWindowsIoJson(root) === canonicalWindowsIoJson(initial.root),
			)
		)
			throw new Error("WINDOWS_IO_FIRST_CAPTURE_ENROLLMENT_OUTSIDE_ADMIN_BINDINGS");
		const challenge = randomBytes(24).toString("base64url");
		const request = windowsFirstCaptureEnrollmentInspectionRequestSchema.parse({
			version: 1,
			method: "inspect_windows_first_capture_enrollment",
			challenge,
		});
		const response = await invoke(
			frozen,
			new TextEncoder().encode(JSON.stringify(request)),
			bounded,
			WINDOWS_FIRST_CAPTURE_LIMITS.publicBytes,
		);
		const raw = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
		const envelope: unknown = JSON.parse(raw);
		if (JSON.stringify(envelope) !== raw)
			throw new Error("WINDOWS_IO_FIRST_CAPTURE_NONCANONICAL_ENVELOPE");
		const inspected = verifyFirstCaptureEnrollmentInspection(envelope, {
			brokerPublicKey: frozen.pin.publicKey,
			brokerServiceId: before.config.brokerServiceId,
			configDigest: before.digest,
			challenge,
			now: Date.now(),
		});
		const after = await administratorState(frozen);
		const finalBytes = await readProtected(
			enrollmentFile,
			WINDOWS_FIRST_CAPTURE_LIMITS.configurationBytes,
		);
		bounded.throwIfAborted();
		if (
			before.digest !== after.digest ||
			!Buffer.from(initialBytes).equals(Buffer.from(finalBytes)) ||
			canonicalWindowsIoJson(inspected.enrollment) !== canonicalWindowsIoJson(initial)
		)
			throw new Error("WINDOWS_IO_FIRST_CAPTURE_ENROLLMENT_CHANGED_DURING_PROBE");
		return Object.freeze({
			enrollment: inspected.enrollment,
			enrollmentDigest: inspected.enrollmentFileDigest,
			configDigest: inspected.configDigest,
		});
	};
}
