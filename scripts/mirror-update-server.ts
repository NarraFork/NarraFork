import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
	mirrorJobTimeoutMs,
	mirrorTransferTimeoutMs,
	mirrorUploadConcurrency,
	validateMirrorJobTimeoutMs,
} from "../shared/mirror-relay";
import { validateWebDavConfig } from "../shared/webdav-transport";
import { resolveMirrorRelayConfig, resolveMirrorTransport } from "./lib/mirror-relay-stage";
import {
	readMirrorDataFile,
	readMirrorPublicationReceiptSet,
	resolveMirrorWorkflowTriggers,
	verifyProtectedMirrorEnvironment,
} from "./lib/mirror-workflow";
import { resolveUpdateServerMirrorConfig } from "./lib/update-server-bridge-http";
import {
	IndependentMirrorError,
	type IndependentMirrorReceipt,
	MIRROR_TOTAL_BYTES,
	type MirrorPublishedOptions,
	mirrorPublishedMainRelease,
	mirrorReceipt,
} from "./lib/update-server-main-mirror";
import { mirrorPublishedToolsRelease } from "./lib/update-server-tools-mirror";

export { resolveUpdateServerMirrorConfig } from "./lib/update-server-bridge-http";
export type {
	IndependentMirrorReceipt,
	MirrorPublishedOptions,
} from "./lib/update-server-main-mirror";
/** A post-publication operation; its failures never mutate GitHub or participate in Core Release Gate. */
export async function mirrorPublishedGitHubRelease(
	options: MirrorPublishedOptions,
): Promise<IndependentMirrorReceipt> {
	try {
		validateMirrorJobTimeoutMs(options.totalTimeoutMs ?? mirrorJobTimeoutMs(options.kind));
		mirrorUploadConcurrency(options.uploadConcurrency);
		const transport = resolveMirrorTransport({ NF_MIRROR_TRANSPORT: options.transport });
		if (transport === "webdav" && !options.dryRun) {
			if (!options.relay) throw new Error("Explicit WebDAV relay configuration required");
			const delivery = validateWebDavConfig(options.relay.config);
			if (
				delivery.transferTimeoutMs !== undefined &&
				delivery.transferTimeoutMs > (options.totalTimeoutMs ?? mirrorJobTimeoutMs(options.kind))
			)
				throw new Error("Mirror job deadline must cover its streamed object budget");
			resolveMirrorRelayConfig({
				NF_MIRROR_WEBDAV_URL: options.relay.config.url,
				NF_MIRROR_WEBDAV_FEED: options.relay.config.feed,
				NF_MIRROR_RELAY_SIGNING_KEY: options.relay.signingKey,
				...("bearerToken" in options.relay.config.auth
					? { NF_MIRROR_WEBDAV_TOKEN: options.relay.config.auth.bearerToken }
					: {
							NF_MIRROR_WEBDAV_USERNAME: options.relay.config.auth.username,
							NF_MIRROR_WEBDAV_PASSWORD: options.relay.config.auth.password,
						}),
			});
		}
	} catch {
		throw new IndependentMirrorError({ ...mirrorReceipt(options), failureCode: "FAILED_CONFIG" });
	}
	if (options.transport !== "webdav" && !options.dryRun && !options.config)
		return { ...mirrorReceipt(options), status: "SKIPPED_UNCONFIGURED" };
	if (options.transport !== "webdav" && options.config && !options.dryRun) {
		try {
			resolveUpdateServerMirrorConfig({
				NF_UPDATE_SERVER: options.config.serverUrl,
				NF_UPDATE_TOKEN: options.config.token,
			});
		} catch {
			throw new IndependentMirrorError({ ...mirrorReceipt(options), failureCode: "FAILED_CONFIG" });
		}
	}
	return options.kind === "main"
		? mirrorPublishedMainRelease(options)
		: mirrorPublishedToolsRelease(options);
}
/** A multi-publication run cannot overwrite one component's result with another. */
export function mirrorPublicationReceiptPath(
	path: string,
	kind: MirrorPublishedOptions["kind"],
	multiple: boolean,
): string {
	return multiple ? join(dirname(path), kind, basename(path)) : path;
}
/** Sequential producers share the same count, byte budget and absolute deadline, including failures. */
export async function mirrorPublishedGitHubReleaseSet(
	targets: MirrorPublishedOptions[],
	mirror = mirrorPublishedGitHubRelease,
): Promise<IndependentMirrorReceipt[]> {
	if (
		!targets.length ||
		targets.length > 2 ||
		new Set(targets.map((target) => target.kind)).size !== targets.length
	)
		throw new Error("Invalid mirror publication target set");
	const timeout = Math.min(
		...targets.map((target) =>
			validateMirrorJobTimeoutMs(target.totalTimeoutMs ?? mirrorJobTimeoutMs(target.kind)),
		),
	);
	const signal = AbortSignal.any([
		AbortSignal.timeout(timeout),
		...targets.flatMap((target) => (target.signal ? [target.signal] : [])),
	]);
	const maximumBytes = Math.min(
		MIRROR_TOTAL_BYTES,
		...targets.map((target) => target.maxTotalBytes ?? MIRROR_TOTAL_BYTES),
	);
	let count = 0;
	let bytes = 0;
	const receipts: IndependentMirrorReceipt[] = [];
	for (const target of targets) {
		const options: MirrorPublishedOptions = {
			...target,
			signal,
			totalTimeoutMs: timeout,
			reserveAssets: (assets) => {
				const amount = 2 * assets.reduce((sum, asset) => sum + asset.size, 0);
				if (
					!Number.isSafeInteger(maximumBytes) ||
					maximumBytes < 1 ||
					!Number.isSafeInteger(amount) ||
					amount < 1 ||
					assets.some((asset) => !Number.isSafeInteger(asset.size) || asset.size < 1) ||
					count + assets.length > 200 ||
					bytes + amount > maximumBytes
				)
					throw new Error("Shared mirror publication asset/byte budget exceeded");
				count += assets.length;
				bytes += amount;
				target.reserveAssets?.(assets);
			},
		};
		try {
			signal.throwIfAborted();
			receipts.push(await mirror(options));
		} catch (error) {
			receipts.push(
				error instanceof IndependentMirrorError
					? error.receipt
					: {
							...mirrorReceipt(options),
							failureCode: signal.aborted ? "CANCELLED" : "MIRROR_FAILED",
						},
			);
			if (error instanceof IndependentMirrorError && error.transportDiagnostic) {
				try {
					console.error(
						JSON.stringify({
							event: "mirror.transport.failure",
							transport: options.transport,
							...error.transportDiagnostic,
						}),
					);
				} catch {
					// Best-effort diagnostics cannot replace either independent result.
				}
			}
		}
	}
	return receipts;
}
async function output(values: Record<string, string>) {
	if (!process.env.GITHUB_OUTPUT) return;
	for (const [key, value] of Object.entries(values)) {
		if (!/^[a-z_]+$/.test(key) || !/^[A-Za-z0-9._/-]+$/.test(value))
			throw new Error("Unsafe mirror workflow output");
		await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
	}
}
async function main() {
	const { values } = parseArgs({
		options: {
			kind: { type: "string" },
			tag: { type: "string" },
			repository: { type: "string" },
			"dry-run": { type: "boolean" },
			"resolve-trigger": { type: "boolean" },
			"event-file": { type: "string" },
			"receipt-file": { type: "string" },
			"peer-receipt-file": { type: "string" },
			"verify-trigger-receipt": { type: "boolean" },
			"receipt-output": { type: "string", default: "artifacts/mirror/receipt.json" },
		},
		strict: true,
		allowPositionals: false,
	});
	const repository = values.repository ?? process.env.GITHUB_REPOSITORY ?? "";
	const event = values["event-file"]
		? await readMirrorDataFile(values["event-file"], 256 * 1024)
		: undefined;
	let triggers: Awaited<ReturnType<typeof resolveMirrorWorkflowTriggers>> = [];
	if (event && process.env.GITHUB_EVENT_NAME === "workflow_run") {
		triggers = await resolveMirrorWorkflowTriggers(event, repository);
		if (values["resolve-trigger"]) {
			if (triggers.length) await verifyProtectedMirrorEnvironment(repository);
			await output(
				triggers.length
					? {
							eligible: "true",
							artifact_name: triggers[0].artifactName,
							run_id: String(triggers[0].runId),
							peer_receipt: triggers.length === 2 ? "true" : "false",
							...(triggers[1] ? { peer_artifact_name: triggers[1].artifactName } : {}),
						}
					: { eligible: "false" },
			);
			return;
		}
		if (!triggers.length || !values["receipt-file"])
			throw new Error("Successful source publication receipt required");
	} else if (values["resolve-trigger"]) {
		const e = event as { repository?: { full_name: string; default_branch: string } };
		if (
			process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
			e?.repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
			process.env.GITHUB_REF !== `refs/heads/${e.repository.default_branch}`
		)
			throw new Error("Mirror workflow dispatch must use the trusted default branch");
		await verifyProtectedMirrorEnvironment(repository);
		await output({ eligible: "true" });
		return;
	}
	let kind = values.kind;
	let tag = values.tag;
	const publications = triggers.length
		? await readMirrorPublicationReceiptSet(triggers, {
				receiptFile: values["receipt-file"],
				peerReceiptFile: values["peer-receipt-file"],
			})
		: [];
	if (values["verify-trigger-receipt"]) {
		if (!publications.length) throw new Error("Successful source publication receipt required");
		await output({ eligible: "true" });
		return;
	}
	if (publications.length) {
		kind = publications[0].kind;
		tag = publications[0].tag;
	}
	if (!["main", "helpers", "executor", "remote-peer"].includes(kind ?? "") || !tag)
		throw new Error(
			"Use --kind=main|helpers|executor|remote-peer --tag=exact-public-tag --repository=owner/repo",
		);
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	const options: MirrorPublishedOptions = {
		kind: kind as MirrorPublishedOptions["kind"],
		repository,
		tag,
		dryRun: values["dry-run"],
		signal: controller.signal,
	};
	let targets = publications.length
		? publications.map((publication) => ({
				...options,
				kind: publication.kind,
				tag: publication.tag,
				publication,
			}))
		: [options];
	let receipts: IndependentMirrorReceipt[] = [];
	try {
		try {
			options.transport = resolveMirrorTransport(process.env);
			options.uploadConcurrency = mirrorUploadConcurrency(
				process.env.NF_MIRROR_UPLOAD_CONCURRENCY,
				options.transport,
			);
			options.totalTimeoutMs = mirrorJobTimeoutMs(
				options.kind,
				process.env.NF_MIRROR_TOTAL_TIMEOUT_MINUTES,
			);
			mirrorTransferTimeoutMs(process.env.NF_MIRROR_TRANSFER_TIMEOUT_MINUTES);
			if (options.transport === "webdav") {
				options.relay = values["dry-run"] ? undefined : resolveMirrorRelayConfig(process.env);
			} else {
				options.config = values["dry-run"]
					? undefined
					: resolveUpdateServerMirrorConfig(process.env);
			}
			targets = targets.map((target) => ({
				...options,
				kind: target.kind,
				tag: target.tag,
				publication: target.publication,
			}));
		} catch {
			receipts = targets.map((target) => ({
				...mirrorReceipt({ ...target, transport: options.transport }),
				failureCode: "FAILED_CONFIG",
			}));
		}
		if (!receipts.length) receipts = await mirrorPublishedGitHubReleaseSet(targets);
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
		for (const receipt of receipts) {
			const path = mirrorPublicationReceiptPath(
				values["receipt-output"] as string,
				receipt.kind,
				receipts.length > 1,
			);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		}
	}
	for (const receipt of receipts) {
		console.log(
			`Independent mirror ${receipt.kind}/${receipt.tag}: ${receipt.status}${receipt.failureCode ? `/${receipt.failureCode}` : ""}; uploaded=${receipt.uploaded.length}; server-verified=${receipt.verified.length}; transport=${receipt.transport}${receipt.relay ? `; retention=${receipt.relay.retention}; expires=${receipt.relay.expiresAt}` : ""}; GitHub publication unchanged`,
		);
		if (receipt.failureCode === "SERVER_RECEIPT_REQUIRED")
			console.error(
				"Upgrade update server for server-sha256 verification/commit receipts; asset GET fallback is disabled",
			);
		if (receipt.status === "FAILED") process.exitCode = 1;
	}
}
if (import.meta.main)
	main().catch(() => {
		console.error(
			"Independent mirror failed before upload; GitHub publication unchanged (hard cancellation may leave no receipt)",
		);
		process.exitCode = 1;
	});
