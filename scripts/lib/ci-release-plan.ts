import { execFileSync } from "node:child_process";
import { z } from "zod";
import { compareReleaseVersions, isValidReleaseVersion } from "../../shared/release-version";
import {
	CI_RELEASE_BUN,
	CI_RELEASE_REPOSITORY,
	CI_RELEASE_TARGETS,
	CI_RELEASE_WORKFLOW,
	type CiReleasePlan,
} from "./ci-release-types";
import { type GhRunner, releaseChannel } from "./github-release";

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
const planSchema = z
	.object({
		schemaVersion: z.literal(1),
		repository: z.literal(CI_RELEASE_REPOSITORY),
		tag: z.string(),
		version,
		commit: sha,
		workflowCommit: sha,
		bunVersion: z.literal(CI_RELEASE_BUN),
		channel: z.enum(["stable", "beta"]),
		changelog: changelogSchema,
		runId: id,
		runAttempt: id,
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
								buildDate: z.string().datetime(),
								size: id.max(1024 ** 3),
								sha256: z.string().regex(/^[a-f0-9]{64}$/),
								sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
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
				env: { ...env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
			});
		} catch (error) {
			const detail = error as { stderr?: string | Buffer; message?: string };
			throw new Error(`gh failed: ${String(detail.stderr ?? detail.message).slice(0, 8192)}`);
		}
	};
}

export async function ciApi(run: GhRunner, path: string): Promise<unknown> {
	const output = await run(["api", `repos/${CI_RELEASE_REPOSITORY}/${path}`]);
	if (Buffer.byteLength(output) > CI_API_MAX_BYTES) throw new Error("GitHub API output limit");
	return JSON.parse(output);
}

export async function ciApiList(run: GhRunner, path: string, key?: string): Promise<unknown[]> {
	const entries: unknown[] = [];
	let total: number | undefined;
	for (let page = 1; page <= 10; page++) {
		const response = await ciApi(
			run,
			`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
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
	const seen = new Set<string>();
	const count = new Map<string, number>();
	for (const base of plan.baselines) {
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

export function validateCiDispatch(env: NodeJS.ProcessEnv): {
	workflowCommit: string;
	runId: number;
	runAttempt: number;
} {
	if (
		env.GITHUB_REPOSITORY !== CI_RELEASE_REPOSITORY ||
		env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
		env.GITHUB_REF !== "refs/heads/main" ||
		env.GITHUB_WORKFLOW_REF !== `${CI_RELEASE_REPOSITORY}/${CI_RELEASE_WORKFLOW}@refs/heads/main`
	) {
		throw new Error("Release requires this repository's main workflow_dispatch");
	}
	const workflowCommit = sha.parse(env.GITHUB_WORKFLOW_SHA);
	if (env.GITHUB_SHA !== workflowCommit) throw new Error("Workflow and dispatch commit mismatch");
	return {
		workflowCommit,
		runId: parseCiId(env.GITHUB_RUN_ID),
		runAttempt: parseCiId(env.GITHUB_RUN_ATTEMPT),
	};
}

export function parseCiId(value: unknown): number {
	if (typeof value === "number") return id.parse(value);
	if (typeof value !== "string" || !/^[1-9]\d*$/.test(value))
		throw new Error("Invalid GitHub run/artifact ID");
	return id.parse(Number(value));
}

export async function resolveCiTag(run: GhRunner, tag: string): Promise<string> {
	validateCiReleaseTag(tag);
	const objectSchema = z.object({ object: z.object({ type: z.string(), sha }) });
	let object = objectSchema.parse(await ciApi(run, `git/ref/tags/${tag}`)).object;
	for (let depth = 0; object.type === "tag" && depth < 4; depth++) {
		object = objectSchema.parse(await ciApi(run, `git/tags/${object.sha}`)).object;
	}
	if (object.type !== "commit") throw new Error("Tag does not resolve to a commit");
	return object.sha;
}

export async function assertCiMainAncestor(run: GhRunner, commit: string): Promise<void> {
	sha.parse(commit);
	const main = z
		.object({ object: z.object({ type: z.literal("commit"), sha }) })
		.parse(await ciApi(run, "git/ref/heads/main")).object.sha;
	const comparison = z
		.object({ status: z.string(), merge_base_commit: z.object({ sha }) })
		.parse(await ciApi(run, `compare/${commit}...${main}`));
	if (
		!["ahead", "identical"].includes(comparison.status) ||
		comparison.merge_base_commit.sha !== commit
	) {
		throw new Error("Release commit is not an ancestor of remote main");
	}
}

async function readCommittedJson(run: GhRunner, commit: string, path: string): Promise<unknown> {
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
		.parse(await ciApi(run, `contents/${path}?ref=${commit}`));
	const bytes = Buffer.from(data.content, "base64");
	if (bytes.length !== data.size) throw new Error("Committed file size mismatch");
	return JSON.parse(bytes.toString("utf8"));
}

async function targetIdentity(run: GhRunner, commit: string, releaseVersion: string) {
	const pkg = z
		.object({
			version: z.literal(releaseVersion),
			packageManager: z.literal(`bun@${CI_RELEASE_BUN}`),
		})
		.parse(await readCommittedJson(run, commit, "package.json"));
	const changelog = changelogSchema.parse(
		await readCommittedJson(run, commit, `changelogs/v${pkg.version}.json`),
	);
	if (changelog.version !== releaseVersion) throw new Error("Changelog version mismatch");
	// The strict interface must exist at the target, not just in the trusted control checkout.
	const marker = z.object({ type: z.literal("file"), size: z.number().positive() });
	marker.parse(await ciApi(run, `contents/scripts/lib/ci-release-types.ts?ref=${commit}`));
	return changelog;
}

export async function assertReleaseEnvironment(run: GhRunner): Promise<void> {
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
		.parse(await ciApi(run, "environments/release"));
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
	);
	if (
		branches.length !== 1 ||
		!z.object({ name: z.literal("main"), type: z.literal("branch") }).safeParse(branches[0]).success
	) {
		throw new Error("Release environment must allow only the main branch");
	}
}

export interface CreateCiReleasePlanOptions {
	root: string;
	tag: string;
	publish: boolean;
	sourceRunId?: string | number;
	env?: NodeJS.ProcessEnv;
	run?: GhRunner;
}

export async function createCiReleasePlan(
	options: CreateCiReleasePlanOptions,
): Promise<CiReleasePlan> {
	const releaseVersion = validateCiReleaseTag(options.tag);
	const env = options.env ?? process.env;
	const dispatch = validateCiDispatch(env);
	const run = options.run ?? ciGhRunner(env);
	if (options.sourceRunId !== undefined) parseCiId(options.sourceRunId);
	const commit = await resolveCiTag(run, options.tag);
	await assertCiMainAncestor(run, commit);
	await assertCiMainAncestor(run, dispatch.workflowCommit);
	const changelog = await targetIdentity(run, commit, releaseVersion);
	if (options.sourceRunId === undefined) {
		const releases = z
			.array(
				z.object({ id, tag_name: z.string(), draft: z.boolean(), assets: z.array(z.unknown()) }),
			)
			.parse(await ciApiList(run, "releases"));
		if (
			releases.some(
				(release) =>
					release.tag_name === options.tag && (!release.draft || release.assets.length > 0),
			)
		) {
			throw new Error(
				"Existing release assets require the original source_run_id bundle; rebuilding is forbidden",
			);
		}
	}
	if (options.publish) await assertReleaseEnvironment(run);
	return validateCiReleasePlan({
		schemaVersion: 1,
		repository: CI_RELEASE_REPOSITORY,
		tag: options.tag,
		version: releaseVersion,
		commit,
		...dispatch,
		bunVersion: CI_RELEASE_BUN,
		channel: releaseChannel(releaseVersion),
		changelog,
		baselines: [],
	});
}

export async function revalidateCiReleasePlan(
	value: CiReleasePlan,
	options: { root: string; publish: boolean; run?: GhRunner; env?: NodeJS.ProcessEnv },
): Promise<void> {
	const plan = validateCiReleasePlan(value);
	const env = options.env ?? process.env;
	const dispatch = validateCiDispatch(env);
	const run = options.run ?? ciGhRunner(env);
	if ((await resolveCiTag(run, plan.tag)) !== plan.commit)
		throw new Error("Release tag moved since preflight");
	await assertCiMainAncestor(run, plan.commit);
	await assertCiMainAncestor(run, plan.workflowCommit);
	await assertCiMainAncestor(run, dispatch.workflowCommit);
	const changelog = await targetIdentity(run, plan.commit, plan.version);
	if (JSON.stringify(changelog) !== JSON.stringify(plan.changelog))
		throw new Error("Release changelog changed");
	if (options.publish) await assertReleaseEnvironment(run);
}
