import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { isValidGitHubRepository } from "../../shared/github-repository";
import {
	type HelperDistributionDependencies,
	parseHelperDistributionDependencies,
} from "../../shared/helper-distribution";
import { compareReleaseVersions, isValidReleaseVersion } from "../../shared/release-version";
import {
	parseRemoteFrontendCapability,
	type RemoteFrontendCapability,
} from "../../shared/remote-access/application";
import { EXECUTOR_VERSION_RE } from "../../shared/remote-executor-manifest";
import { parseRecoveryManifestVersions } from "../../shared/update-identity";
import { updateServerChildEnvironment } from "../../shared/update-server-child-env";
import {
	CI_RELEASE_BUN,
	CI_RELEASE_REPOSITORY,
	CI_RELEASE_TARGETS,
	CI_RELEASE_WORKFLOW,
	type CiReleasePlan,
} from "./ci-release-types";
import {
	collectComponentReleaseEvidence,
	readTargetComponentDependencies,
	verifyComponentReleaseEvidence,
} from "./component-release-inputs";
import { type GhRunner, releaseChannel } from "./github-release";
import { listGitHubReleaseSummaries } from "./github-release-summary";
import {
	remotePeerReleasePlanSchema,
	validateRemotePeerReleasePlan,
} from "./remote-peer-release-prepare";

export const CI_API_TIMEOUT_MS = 30_000;
export const CI_API_MAX_BYTES = 1024 * 1024;
const sha = z
	.string()
	.length(40)
	.regex(/^[a-f0-9]{40}$/);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const version = z.string().refine(isValidReleaseVersion);
const filename = z
	.string()
	.max(200)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const asset = z.object({ id, name: filename, size: id }).strict();
const changelogSchema = z
	.object({
		version,
		date: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.refine((value) => {
				const date = new Date(`${value}T00:00:00.000Z`);
				return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
			}),
		en: z
			.string()
			.trim()
			.min(1)
			.max(256 * 1024),
		"zh-CN": z
			.string()
			.trim()
			.min(1)
			.max(256 * 1024),
	})
	.strict();
const artifactIdentitySchema = z
	.object({
		id,
		digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		size: id.max(2 * 1024 ** 3),
	})
	.strict();
const buildSourceSchema = z
	.object({
		runId: id,
		runAttempt: id,
		workflowCommit: sha,
		controlArtifact: artifactIdentitySchema,
		remoteFrontend: artifactIdentitySchema.optional(),
		platforms: z
			.array(
				z
					.object({
						target: z.enum(CI_RELEASE_TARGETS.map(({ target }) => target)),
						artifact: artifactIdentitySchema,
					})
					.strict(),
			)
			.min(1)
			.max(8),
	})
	.strict();
const componentEvidenceSchema = z
	.object({
		executor: z
			.object({
				version: version.max(64),
				protocolVersion: z
					.number()
					.int()
					.positive()
					.max(2 ** 31 - 1),
				tag: z.string().max(80),
				commit: sha,
				manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
				buildInputsSha256: z.string().regex(/^[a-f0-9]{64}$/),
			})
			.strict(),
	})
	.strict();
const planSchema = z
	.object({
		schemaVersion: z.literal(1),
		repository: z.string().refine(isValidGitHubRepository),
		defaultBranch: z.string().refine(isValidDefaultBranch).optional(),
		tag: z.string(),
		version,
		commit: sha,
		workflowCommit: sha,
		bunVersion: z.literal(CI_RELEASE_BUN),
		channel: z.enum(["stable", "beta"]),
		changelog: changelogSchema,
		runId: id,
		runAttempt: id,
		buildSource: buildSourceSchema.optional(),
		componentEvidence: componentEvidenceSchema.optional(),
		remotePeer: remotePeerReleasePlanSchema.optional(),
		remoteFrontend: z.unknown().transform(parseRemoteFrontendCapability).optional(),
		baselines: z
			.array(
				z
					.object({
						releaseId: id,
						version,
						platform: z.string(),
						binaryAsset: asset,
						metadataAsset: asset,
						metadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
						metadata: z
							.object({
								name: filename,
								platform: z.string(),
								target: z.string(),
								version,
								commit: z.string().regex(/^[a-f0-9]{7,40}$/),
								repository: z.string().refine(isValidGitHubRepository).optional(),
								buildDate: z.string().datetime(),
								size: id.max(1024 ** 3),
								sha256: z.string().regex(/^[a-f0-9]{64}$/),
								sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
								recoveryManifestVersions: z
									.unknown()
									.transform((value) => parseRecoveryManifestVersions(value))
									.optional(),
								helperDistribution: z
									.unknown()
									.transform((value) => parseHelperDistributionDependencies(value))
									.optional(),
							})
							.strict(),
					})
					.strict(),
			)
			.max(16),
	})
	.strict();

/** An injected runner is a fixture seam; production always has time/output bounds. */
export function ciGhRunner(env: NodeJS.ProcessEnv = process.env): GhRunner {
	return (args) => {
		try {
			return execFileSync("gh", args, {
				encoding: "utf8",
				timeout: CI_API_TIMEOUT_MS,
				maxBuffer: CI_API_MAX_BYTES,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...updateServerChildEnvironment(env),
					GH_HOST: "github.com",
					GH_PROMPT_DISABLED: "1",
				},
			});
		} catch (error) {
			const detail = error as { stderr?: string | Buffer; message?: string };
			throw new Error(`gh failed: ${String(detail.stderr ?? detail.message).slice(0, 8192)}`);
		}
	};
}

export async function ciApi(
	run: GhRunner,
	path: string,
	repository = CI_RELEASE_REPOSITORY,
	projection?: string,
): Promise<unknown> {
	if (!isValidGitHubRepository(repository)) throw new Error("Invalid CI repository");
	const output = await run([
		"api",
		`repos/${repository}${path ? `/${path}` : ""}`,
		...(projection ? ["--jq", projection] : []),
	]);
	if (Buffer.byteLength(output) > CI_API_MAX_BYTES) throw new Error("GitHub API output limit");
	return JSON.parse(output);
}

export async function ciApiList(
	run: GhRunner,
	path: string,
	key?: string,
	repository = CI_RELEASE_REPOSITORY,
): Promise<unknown[]> {
	const entries: unknown[] = [];
	let total: number | undefined;
	for (let page = 1; page <= 10; page++) {
		const response = await ciApi(
			run,
			`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
			repository,
		);
		const items = key ? (response as Record<string, unknown>)?.[key] : response;
		if (!Array.isArray(items) || items.length > 100) throw new Error("Invalid GitHub API page");
		if (key) {
			const count = z
				.number()
				.int()
				.nonnegative()
				.max(1000)
				.parse((response as Record<string, unknown>).total_count);
			if (total !== undefined && total !== count)
				throw new Error("GitHub API pagination changed during lookup");
			total = count;
		}
		entries.push(...items);
		if (total !== undefined && entries.length > total)
			throw new Error("GitHub API pagination count mismatch");
		if (items.length < 100 || entries.length === total) {
			if (total !== undefined && entries.length !== total)
				throw new Error("GitHub API pagination truncated");
			return entries;
		}
	}
	throw new Error("GitHub API pagination limit reached");
}

export function validateCiReleaseTag(tag: string): string {
	if (
		typeof tag !== "string" ||
		tag.trim() !== tag ||
		!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag) ||
		!isValidReleaseVersion(tag.slice(1))
	) {
		throw new Error("Invalid release tag; expected canonical vX.Y.Z");
	}
	return tag.slice(1);
}

export function validateCiReleasePlan(value: unknown): CiReleasePlan {
	const plan = planSchema.parse(value);
	if (
		validateCiReleaseTag(plan.tag) !== plan.version ||
		plan.changelog.version !== plan.version ||
		plan.channel !== releaseChannel(plan.version)
	)
		throw new Error("Release plan version/channel mismatch");
	if (plan.remotePeer) {
		const peer = validateRemotePeerReleasePlan(plan.remotePeer);
		if (peer.action !== "absent" && peer.action !== "reuse" && peer.sourceCommit !== plan.commit)
			throw new Error("Peer build must use the frozen NF source commit");
	}
	if (plan.componentEvidence) {
		const executor = plan.componentEvidence.executor;
		if (
			!EXECUTOR_VERSION_RE.test(executor.version) ||
			executor.tag !== `executor-v${executor.version}`
		)
			throw new Error("Invalid component evidence version/tag identity");
	}
	if (plan.buildSource) {
		const source = plan.buildSource;
		const targets = new Set(source.platforms.map(({ target }) => target));
		const artifactIds = new Set(source.platforms.map(({ artifact }) => artifact.id));
		if (
			Boolean(plan.remoteFrontend) !== Boolean(source.remoteFrontend) ||
			(source.remoteFrontend &&
				(source.remoteFrontend.size > 130 * 1024 ** 2 ||
					source.remoteFrontend.id === source.controlArtifact.id ||
					artifactIds.has(source.remoteFrontend.id)))
		)
			throw new Error("Missing or invalid frozen remote frontend build artifact");
		if (
			source.runId === plan.runId ||
			![1, CI_RELEASE_TARGETS.length].includes(source.platforms.length) ||
			targets.size !== source.platforms.length ||
			artifactIds.size !== source.platforms.length ||
			artifactIds.has(source.controlArtifact.id) ||
			source.controlArtifact.size > 4 * 1024 * 1024
		)
			throw new Error("Invalid original build provenance or target set");
	}
	const seen = new Set<string>();
	const count = new Map<string, number>();
	for (const base of plan.baselines) {
		if (base.metadata.helperDistribution !== undefined)
			parseHelperDistributionDependencies(base.metadata.helperDistribution);
		const target = CI_RELEASE_TARGETS.find((item) => item.platform === base.platform);
		const key = `${base.platform}/${base.version}`;
		if (
			!target ||
			seen.has(key) ||
			(count.get(base.platform) ?? 0) >= 2 ||
			compareReleaseVersions(base.version, plan.version) >= 0 ||
			base.metadata.version !== base.version ||
			base.metadata.platform !== base.platform ||
			base.metadata.target !== `bun-${target.target}` ||
			base.binaryAsset.name !== `narrafork-${base.version}-${target.suffix}` ||
			base.metadata.name !== base.binaryAsset.name ||
			base.binaryAsset.size !== base.metadata.size ||
			base.metadataAsset.name !== `${base.binaryAsset.name}.metadata.json` ||
			base.metadataAsset.size > 64 * 1024
		)
			throw new Error("Invalid release baseline identity");
		seen.add(key);
		count.set(base.platform, (count.get(base.platform) ?? 0) + 1);
	}
	return plan;
}

/** Evidence refers to the sealed artifact's pin, never the current control checkout's pin. */
export function validateCiComponentDependencies(
	plan: CiReleasePlan,
	dependencies: HelperDistributionDependencies | undefined,
): void {
	if (!plan.componentEvidence) return;
	const declared =
		dependencies === undefined ? undefined : parseHelperDistributionDependencies(dependencies);
	const evidence = plan.componentEvidence.executor;
	if (
		declared === undefined ||
		declared.executor.version !== evidence.version ||
		declared.executor.protocolVersion !== evidence.protocolVersion ||
		declared.executor.tag !== evidence.tag
	)
		throw new Error("Release component evidence/dependency identity mismatch");
}

export function validateCiDispatch(
	env: NodeJS.ProcessEnv,
	defaultBranch = "main",
): {
	repository: string;
	defaultBranch: string;
	workflowCommit: string;
	runId: number;
	runAttempt: number;
} {
	const repository = env.GITHUB_REPOSITORY;
	if (
		!isValidGitHubRepository(repository) ||
		!isValidDefaultBranch(defaultBranch) ||
		env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
		env.GITHUB_REF !== `refs/heads/${defaultBranch}` ||
		env.GITHUB_WORKFLOW_REF !== `${repository}/${CI_RELEASE_WORKFLOW}@refs/heads/${defaultBranch}`
	) {
		throw new Error("Release requires this repository's default branch workflow_dispatch");
	}
	const workflowCommit = sha.parse(env.GITHUB_WORKFLOW_SHA);
	if (env.GITHUB_SHA !== workflowCommit) throw new Error("Workflow and dispatch commit mismatch");
	return {
		repository,
		defaultBranch,
		workflowCommit,
		runId: parseCiId(env.GITHUB_RUN_ID),
		runAttempt: parseCiId(env.GITHUB_RUN_ATTEMPT),
	};
}

function isValidDefaultBranch(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 255 &&
		!Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) &&
		!/[~^:?*[\\]/.test(value) &&
		!value.includes("..") &&
		!value.includes("@{") &&
		!value
			.split("/")
			.some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
	);
}

/** Resolve the repository's branch from authenticated API, never a dispatch input. */
export async function resolveCiDispatch(run: GhRunner, env: NodeJS.ProcessEnv) {
	// Reject malformed event/ref/SHA locally before querying the authenticated repository API.
	validateCiDispatch(env, env.GITHUB_REF?.replace(/^refs\/heads\//, "") ?? "");
	const repository = env.GITHUB_REPOSITORY;
	if (!isValidGitHubRepository(repository)) throw new Error("Invalid CI repository");
	const info = z
		.object({
			full_name: z.string(),
			default_branch: z.string().refine(isValidDefaultBranch),
		})
		.parse(await ciApi(run, "", repository));
	if (info.full_name.toLowerCase() !== repository.toLowerCase())
		throw new Error("CI repository API identity mismatch");
	return validateCiDispatch(env, info.default_branch);
}

export function parseCiId(value: unknown): number {
	if (typeof value === "number") return id.parse(value);
	if (typeof value !== "string" || !/^[1-9]\d*$/.test(value))
		throw new Error("Invalid GitHub run/artifact ID");
	return id.parse(Number(value));
}

export async function resolveCiTag(
	run: GhRunner,
	tag: string,
	repository = CI_RELEASE_REPOSITORY,
): Promise<string> {
	validateCiReleaseTag(tag);
	const objectSchema = z.object({ object: z.object({ type: z.string(), sha }) });
	let object = objectSchema.parse(await ciApi(run, `git/ref/tags/${tag}`, repository)).object;
	for (let depth = 0; object.type === "tag" && depth < 4; depth++) {
		object = objectSchema.parse(await ciApi(run, `git/tags/${object.sha}`, repository)).object;
	}
	if (object.type !== "commit") throw new Error("Tag does not resolve to a commit");
	return object.sha;
}

export async function assertCiMainAncestor(
	run: GhRunner,
	commit: string,
	repository = CI_RELEASE_REPOSITORY,
	defaultBranch = "main",
): Promise<void> {
	sha.parse(commit);
	if (!isValidDefaultBranch(defaultBranch)) throw new Error("Invalid default branch");
	const main = z
		.object({ object: z.object({ type: z.literal("commit"), sha }) })
		.parse(await ciApi(run, `git/ref/heads/${encodeURIComponent(defaultBranch)}`, repository))
		.object.sha;
	const comparison = z
		.object({ status: z.string(), merge_base_commit: z.object({ sha }) })
		.parse(
			await ciApi(
				run,
				`compare/${commit}...${main}?per_page=1`,
				repository,
				"{status, merge_base_commit: {sha: .merge_base_commit.sha}}",
			),
		);
	if (
		!["ahead", "identical"].includes(comparison.status) ||
		comparison.merge_base_commit.sha !== commit
	) {
		throw new Error(`Release commit is not an ancestor of remote ${defaultBranch}`);
	}
}

async function readCommittedJson(
	run: GhRunner,
	commit: string,
	path: string,
	repository: string,
): Promise<unknown> {
	const data = z
		.object({
			type: z.literal("file"),
			encoding: z.literal("base64"),
			size: z
				.number()
				.int()
				.nonnegative()
				.max(512 * 1024),
			content: z.string(),
		})
		.parse(await ciApi(run, `contents/${path}?ref=${commit}`, repository));
	const bytes = Buffer.from(data.content, "base64");
	if (bytes.length !== data.size) throw new Error("Committed file size mismatch");
	return JSON.parse(bytes.toString("utf8"));
}

/** Only a transport-confirmed 404 means historical absence. Parse/network failures stay fatal. */
export async function readTargetRemoteFrontendCapability(
	run: GhRunner,
	commit: string,
	repository: string,
): Promise<RemoteFrontendCapability | undefined> {
	let output: string;
	try {
		output = await run([
			"api",
			`repos/${repository}/contents/shared/remote-access/frontend-capability.json?ref=${commit}`,
		]);
	} catch (error) {
		if (error instanceof Error && /\bHTTP 404\b/.test(error.message)) return undefined;
		throw error;
	}
	if (Buffer.byteLength(output) > CI_API_MAX_BYTES)
		throw new Error("Remote capability response too large");
	const data = z
		.object({
			type: z.literal("file"),
			encoding: z.literal("base64"),
			size: z.number().int().positive().max(4096),
			content: z.string().max(8192),
		})
		.parse(JSON.parse(output));
	const bytes = Buffer.from(data.content, "base64");
	if (bytes.length !== data.size) throw new Error("Committed remote capability size mismatch");
	return parseRemoteFrontendCapability(JSON.parse(bytes.toString("utf8")));
}

async function targetIdentity(
	run: GhRunner,
	commit: string,
	releaseVersion: string,
	repository: string,
) {
	const pkg = z
		.object({
			version: z.literal(releaseVersion),
			packageManager: z.literal(`bun@${CI_RELEASE_BUN}`),
		})
		.parse(await readCommittedJson(run, commit, "package.json", repository));
	const changelog = changelogSchema.parse(
		await readCommittedJson(run, commit, `changelogs/v${pkg.version}.json`, repository),
	);
	if (changelog.version !== releaseVersion) throw new Error("Changelog version mismatch");
	// The strict interface must exist at the target, not just in the trusted control checkout.
	const marker = z.object({ type: z.literal("file"), size: z.number().positive() });
	marker.parse(
		await ciApi(run, `contents/scripts/lib/ci-release-types.ts?ref=${commit}`, repository),
	);
	return changelog;
}

export async function assertReleaseEnvironment(
	run: GhRunner,
	repository = CI_RELEASE_REPOSITORY,
	defaultBranch = "main",
): Promise<void> {
	const environment = z
		.object({
			name: z.literal("release"),
			protection_rules: z.array(
				z.object({
					type: z.string(),
					reviewers: z
						.array(
							z.object({
								type: z.enum(["User", "Team"]),
								reviewer: z.object({ id }),
							}),
						)
						.optional(),
				}),
			),
			deployment_branch_policy: z.object({
				protected_branches: z.literal(false),
				custom_branch_policies: z.literal(true),
			}),
		})
		.parse(await ciApi(run, "environments/release", repository));
	if (
		!environment.protection_rules.some(
			(rule) => rule.type === "required_reviewers" && (rule.reviewers?.length ?? 0) > 0,
		)
	) {
		throw new Error("Release environment requires existing required reviewers");
	}
	const branches = await ciApiList(
		run,
		"environments/release/deployment-branch-policies",
		"branch_policies",
		repository,
	);
	if (
		branches.length !== 1 ||
		!z.object({ name: z.literal(defaultBranch), type: z.literal("branch") }).safeParse(branches[0])
			.success
	) {
		throw new Error(`Release environment must allow only the ${defaultBranch} branch`);
	}
}

export interface CiReleaseComponentChecks {
	readDependencies?: typeof readTargetComponentDependencies;
	collectEvidence?: typeof collectComponentReleaseEvidence;
	verifyEvidence?: typeof verifyComponentReleaseEvidence;
}

export interface CreateCiReleasePlanOptions {
	root: string;
	tag: string;
	publish: boolean;
	/** Read-only preparation or repair of the index for an already published release. */
	indexOnly?: boolean;
	signal?: AbortSignal;
	/** Fixture injection only; production uses bounded read-only component checks. */
	componentChecks?: CiReleaseComponentChecks;
	sourceRunId?: string | number;
	env?: NodeJS.ProcessEnv;
	run?: GhRunner;
}

export async function createCiReleasePlan(
	options: CreateCiReleasePlanOptions,
): Promise<CiReleasePlan> {
	const releaseVersion = validateCiReleaseTag(options.tag);
	const env = options.env ?? process.env;
	const run = options.run ?? ciGhRunner(env);
	const dispatch = await resolveCiDispatch(run, env);
	const { repository, defaultBranch } = dispatch;
	if (options.sourceRunId !== undefined) parseCiId(options.sourceRunId);
	const commit = await resolveCiTag(run, options.tag, repository);
	await assertCiMainAncestor(run, commit, repository, defaultBranch);
	await assertCiMainAncestor(run, dispatch.workflowCommit, repository, defaultBranch);
	const changelog = await targetIdentity(run, commit, releaseVersion, repository);
	const remoteFrontend = options.indexOnly
		? undefined
		: await readTargetRemoteFrontendCapability(run, commit, repository);
	if (options.sourceRunId === undefined || options.indexOnly) {
		const releases = await listGitHubReleaseSummaries(run, repository);
		if (options.indexOnly) {
			const matches = releases.filter((release) => release.tagName === options.tag);
			if (matches.length !== 1 || matches[0].draft || matches[0].assetCount === 0)
				throw new Error("Index-only requires an existing published release with assets");
		} else if (
			releases.some(
				(release) => release.tagName === options.tag && (!release.draft || release.assetCount > 0),
			)
		) {
			throw new Error(
				"Existing release assets require the original source_run_id bundle; rebuilding is forbidden",
			);
		}
	}
	let componentEvidence: CiReleasePlan["componentEvidence"];
	let dependencies: HelperDistributionDependencies | undefined;
	if (options.publish) await assertReleaseEnvironment(run, repository, defaultBranch);
	// Repairs authorize writes to an existing publication, not a new component release.
	if (options.publish && !options.indexOnly) {
		const componentOptions = {
			repository,
			targetCommit: commit,
			run: options.run,
			signal: options.signal,
		};
		dependencies = await (
			options.componentChecks?.readDependencies ?? readTargetComponentDependencies
		)(componentOptions);
		if (dependencies !== undefined)
			componentEvidence = await (
				options.componentChecks?.collectEvidence ?? collectComponentReleaseEvidence
			)({ ...componentOptions, dependencies });
		if (dependencies !== undefined && componentEvidence === undefined)
			throw new Error("Missing component publication evidence for configured target");
	}
	const plan = validateCiReleasePlan({
		schemaVersion: 1,
		tag: options.tag,
		version: releaseVersion,
		commit,
		...dispatch,
		bunVersion: CI_RELEASE_BUN,
		channel: releaseChannel(releaseVersion),
		changelog,
		baselines: [],
		...(componentEvidence === undefined ? {} : { componentEvidence }),
		...(remoteFrontend === undefined ? {} : { remoteFrontend }),
	});
	validateCiComponentDependencies(plan, dependencies);
	return plan;
}

export async function revalidateCiReleasePlan(
	value: CiReleasePlan,
	options: {
		root: string;
		publish: boolean;
		/** Index recovery verifies sealed identities, not current remote component readiness. */
		requireAlreadyPublished?: boolean;
		run?: GhRunner;
		env?: NodeJS.ProcessEnv;
		signal?: AbortSignal;
		helperDistribution?: HelperDistributionDependencies;
		/** Keep nested default synchronous control runners out of component source transport. */
		componentRun?: GhRunner;
		componentChecks?: CiReleaseComponentChecks;
	},
): Promise<CiReleasePlan> {
	const plan = validateCiReleasePlan(value);
	const env = options.env ?? process.env;
	const run = options.run ?? ciGhRunner(env);
	const dispatch = await resolveCiDispatch(run, env);
	const { repository, defaultBranch } = dispatch;
	if (plan.repository !== repository || (plan.defaultBranch ?? "main") !== defaultBranch)
		throw new Error("Release plan repository/default branch mismatch");
	if ((await resolveCiTag(run, plan.tag, repository)) !== plan.commit)
		throw new Error("Release tag moved since preflight");
	await assertCiMainAncestor(run, plan.commit, repository, defaultBranch);
	await assertCiMainAncestor(run, plan.workflowCommit, repository, defaultBranch);
	await assertCiMainAncestor(run, dispatch.workflowCommit, repository, defaultBranch);
	const changelog = await targetIdentity(run, plan.commit, plan.version, repository);
	if (JSON.stringify(changelog) !== JSON.stringify(plan.changelog))
		throw new Error("Release changelog changed");
	if (!options.requireAlreadyPublished) {
		const declaration = await readTargetRemoteFrontendCapability(run, plan.commit, repository);
		if (!isDeepStrictEqual(declaration, plan.remoteFrontend))
			throw new Error("Remote frontend declaration differs from frozen target");
	}
	const hasArtifactDependencies = Object.hasOwn(options, "helperDistribution");
	if (!options.publish && !hasArtifactDependencies) return plan;
	if (options.publish) await assertReleaseEnvironment(run, repository, defaultBranch);
	const componentOptions = {
		repository,
		targetCommit: plan.commit,
		signal: options.signal,
		run: Object.hasOwn(options, "componentRun") ? options.componentRun : options.run,
	};
	const targetDependencies = await (
		options.componentChecks?.readDependencies ?? readTargetComponentDependencies
	)(componentOptions);
	const dependencies = hasArtifactDependencies ? options.helperDistribution : targetDependencies;
	if (targetDependencies !== undefined && !isDeepStrictEqual(dependencies, targetDependencies))
		throw new Error("Release helper dependencies do not match target component configuration");
	if (targetDependencies === undefined) {
		if (plan.componentEvidence !== undefined)
			throw new Error("Legacy target cannot declare component evidence");
		if (dependencies !== undefined) {
			const legacy = parseHelperDistributionDependencies(dependencies);
			if (legacy.executor.version !== plan.version || legacy.executor.protocolVersion !== 1)
				throw new Error("Legacy target helper dependency version/protocol mismatch");
		}
		return plan;
	}
	if (!options.publish || options.requireAlreadyPublished) {
		validateCiComponentDependencies(plan, dependencies);
		return plan;
	}
	const componentEvidence = await (
		options.componentChecks?.verifyEvidence ?? verifyComponentReleaseEvidence
	)({
		...componentOptions,
		dependencies,
		evidence: plan.componentEvidence,
	});
	if (componentEvidence === undefined)
		throw new Error("Missing component publication evidence for configured target");
	const controlPlan = validateCiReleasePlan({ ...plan, componentEvidence });
	validateCiComponentDependencies(controlPlan, dependencies);
	return controlPlan;
}
