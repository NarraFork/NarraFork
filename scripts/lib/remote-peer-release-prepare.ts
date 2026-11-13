import { z } from "zod";
import { parseComponentVersions } from "../../shared/helper-distribution";
import { REMOTE_PEER_PLATFORMS } from "../../shared/remote-peer";
import type { GhRunner } from "./github-release";
import { validateGitHubRepository } from "./github-release";
import {
	findPublishedRemotePeerRelease,
	isMissingPeerRemote,
	resolveHelperTagCommit,
} from "./helper-release";
import {
	createGitRemotePeerSource,
	fingerprintRemotePeerInputs,
	REMOTE_PEER_NATIVE_CONTRACT,
	type RemotePeerSource,
} from "./remote-peer-release-inputs";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const remotePeerReleasePlanSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("absent") }).strict(),
	z
		.object({
			action: z.enum(["reuse", "build", "restore"]),
			version: z.string().min(1).max(64),
			protocolVersion: positive.max(2 ** 31 - 1),
			tag: z.string().max(80),
			sourceCommit: sha,
			inputsSha256: digest,
			nativeContract: z
				.array(
					z
						.object({
							platform: z.enum(REMOTE_PEER_PLATFORMS),
							runner: z
								.string()
								.min(1)
								.max(80)
								.regex(/^[A-Za-z0-9.-]+$/),
						})
						.strict(),
				)
				.length(6),
			manifestSha256: digest.optional(),
			buildSource: z
				.object({ runId: positive, runAttempt: positive, workflowCommit: sha })
				.strict()
				.optional(),
		})
		.strict(),
]);
export type RemotePeerReleasePlan = z.infer<typeof remotePeerReleasePlanSchema>;
export function validateRemotePeerReleasePlan(value: unknown): RemotePeerReleasePlan {
	const plan = remotePeerReleasePlanSchema.parse(value);
	if (plan.action !== "absent") {
		const parsed = parseComponentVersions({
			executor: { version: "0.0.1", protocolVersion: 1 },
			remotePeer: { version: plan.version, protocolVersion: plan.protocolVersion },
		}).remotePeer;
		if (
			!parsed ||
			new Set(plan.nativeContract.map(({ platform }) => platform)).size !==
				REMOTE_PEER_PLATFORMS.length ||
			plan.tag !== `remote-peer-v${plan.version}` ||
			(plan.action === "reuse" && (!plan.manifestSha256 || plan.buildSource)) ||
			(plan.action === "restore" && !plan.buildSource) ||
			(plan.action === "build" && (plan.buildSource || plan.manifestSha256))
		)
			throw new Error("Invalid frozen remote-peer release identity");
	}
	return plan;
}
export interface PrepareRemotePeerReleaseOptions {
	root: string;
	commit: string;
	repository: string;
	run?: GhRunner;
	source?: RemotePeerSource;
	signal?: AbortSignal;
}

/** Read-only shared CLI/CI decision. The exact NF target, not today's working pin, is authoritative. */
export async function prepareRemotePeerRelease(
	options: PrepareRemotePeerReleaseOptions,
): Promise<RemotePeerReleasePlan> {
	validateGitHubRepository(options.repository);
	if (!/^[a-f0-9]{40}$/.test(options.commit)) throw new Error("Expected exact NF target commit");
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []),
		AbortSignal.timeout(5 * 60_000),
	]);
	const run: GhRunner | undefined = options.run
		? (args) =>
				options.run?.(args, {
					signal,
					timeoutMs: 30_000,
					maxOutputBytes: 1024 * 1024,
				}) as ReturnType<GhRunner>
		: undefined;
	const source = options.source ?? createGitRemotePeerSource(options.root, signal);
	const configFiles = await source.list(options.commit, "shared/component-versions.json");
	if (!configFiles.length) return { action: "absent" };
	const pin = parseComponentVersions(
		JSON.parse(await source.read(options.commit, "shared/component-versions.json")),
	).remotePeer;
	if (!pin) return { action: "absent" };
	const inputsSha256 = await fingerprintRemotePeerInputs({
		commit: options.commit,
		source,
		protocolVersion: pin.protocolVersion,
		signal,
	});
	const tag = `remote-peer-v${pin.version}`;
	const published = await findPublishedRemotePeerRelease({
		repository: options.repository,
		version: pin.version,
		protocolVersion: pin.protocolVersion,
		run,
		signal,
	}).catch((error: unknown) => {
		if (error instanceof Error && error.message === "Remote peer release identity mismatch")
			throw new Error(
				`remotePeer ${pin.version} public protocol/identity no longer matches this pin; bump remotePeer.version before compiling NF`,
				{ cause: error },
			);
		throw error;
	});
	if (published) {
		const previous = await fingerprintRemotePeerInputs({
			commit: published.commit,
			source,
			protocolVersion: pin.protocolVersion,
			signal,
		}).catch((error: unknown) => {
			signal.throwIfAborted();
			throw new Error(
				`remotePeer ${pin.version} public production inputs cannot be proven unchanged; bump remotePeer.version before compiling NF`,
				{ cause: error },
			);
		});
		if (previous !== inputsSha256)
			throw new Error(
				`remotePeer ${pin.version} is already public but production inputs changed; bump shared/component-versions.json remotePeer.version before compiling NF`,
			);
		return validateRemotePeerReleasePlan({
			action: "reuse",
			...pin,
			tag,
			sourceCommit: published.commit,
			inputsSha256,
			nativeContract: REMOTE_PEER_NATIVE_CONTRACT,
			manifestSha256: published.manifestSha256,
		});
	}
	try {
		const tagged = await resolveHelperTagCommit(
			{ repository: options.repository, run, signal },
			tag,
		);
		if (tagged !== options.commit)
			throw new Error(
				"Existing remote-peer tag points to different source; bump the pin (never force tags)",
			);
	} catch (error) {
		if (!isMissingPeerRemote(error)) throw error;
	}
	return validateRemotePeerReleasePlan({
		action: "build",
		...pin,
		tag,
		sourceCommit: options.commit,
		inputsSha256,
		nativeContract: REMOTE_PEER_NATIVE_CONTRACT,
	});
}

/** Re-verification retains the original peer bytes, never reselects the present-day pin. */
export function restoreRemotePeerReleasePlan(
	plan: RemotePeerReleasePlan | undefined,
	original: {
		runId: number;
		runAttempt: number;
		workflowCommit: string;
	},
): RemotePeerReleasePlan | undefined {
	if (!plan || plan.action === "absent" || plan.action === "reuse") return plan;
	return validateRemotePeerReleasePlan({
		...plan,
		action: "restore",
		buildSource: plan.buildSource ?? {
			runId: original.runId,
			runAttempt: original.runAttempt,
			workflowCommit: original.workflowCommit,
		},
	});
}
