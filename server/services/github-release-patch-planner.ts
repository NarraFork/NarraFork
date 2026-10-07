import {
	type GithubPatchStep,
	MAX_RELEASE_BINARY_BYTES,
	MAX_RELEASE_LEGACY_BYTES,
	MAX_RELEASE_PATCH_BYTES,
	MAX_RELEASE_PATCH_METADATA,
	MAX_RELEASE_PATCH_STEPS,
	RELEASE_SHA512_RE,
	validateReleasePatchMetadata,
} from "../../shared/release-patch";
import { compareReleaseVersions, isValidReleaseVersion } from "../../shared/release-version";

interface PathState {
	version: string;
	size: number;
	sha512: string;
	bytes: number;
	steps: GithubPatchStep[];
}

function comparePaths(a: PathState, b: PathState): number {
	if (a.bytes !== b.bytes) return a.bytes - b.bytes;
	if (a.steps.length !== b.steps.length) return a.steps.length - b.steps.length;
	const left = JSON.stringify(a.steps.map((step) => [step.url, step.metaUrl]));
	const right = JSON.stringify(b.steps.map((step) => [step.url, step.metaUrl]));
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Bounded identity DAG; hop count is part of the state, not merely a final tie breaker. */
export function planGithubReleasePatches(input: {
	currentVersion: string;
	targetVersion: string;
	targetSize: number;
	targetSha512: string;
	steps: readonly GithubPatchStep[];
	currentSize?: number;
	currentSha512?: string;
}): GithubPatchStep[] | undefined {
	if (
		!isValidReleaseVersion(input.currentVersion) ||
		!isValidReleaseVersion(input.targetVersion) ||
		compareReleaseVersions(input.currentVersion, input.targetVersion) >= 0 ||
		!Number.isSafeInteger(input.targetSize) ||
		input.targetSize <= 0 ||
		input.targetSize > MAX_RELEASE_BINARY_BYTES ||
		!RELEASE_SHA512_RE.test(input.targetSha512) ||
		input.steps.length > MAX_RELEASE_PATCH_METADATA
	)
		return undefined;
	const edges = input.steps
		.filter((step) => {
			try {
				const meta = validateReleasePatchMetadata(step.meta, {
					fromVersion: step.fromVersion,
					toVersion: step.toVersion,
					patchSize: step.patchSize,
				});
				if (
					meta.mode !== "patch-from" &&
					Math.max(meta.oldFileSize, meta.newFileSize, meta.patchSize) > MAX_RELEASE_LEGACY_BYTES
				)
					return false;
				return (
					compareReleaseVersions(step.fromVersion, input.currentVersion) >= 0 &&
					compareReleaseVersions(step.toVersion, input.targetVersion) <= 0
				);
			} catch {
				return false;
			}
		})
		.sort(
			(a, b) =>
				compareReleaseVersions(a.fromVersion, b.fromVersion) ||
				compareReleaseVersions(a.toVersion, b.toVersion) ||
				(a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
		);
	const states = new Map<string, PathState>();
	for (const edge of edges) {
		const { meta } = edge;
		const previous = [...states.values()].filter(
			(state) =>
				state.version === edge.fromVersion &&
				state.size === meta.oldFileSize &&
				state.sha512 === meta.oldFileSha512,
		);
		if (
			edge.fromVersion === input.currentVersion &&
			(input.currentSize === undefined || input.currentSize === meta.oldFileSize) &&
			(input.currentSha512 === undefined || input.currentSha512 === meta.oldFileSha512)
		)
			previous.push({
				version: input.currentVersion,
				size: meta.oldFileSize,
				sha512: meta.oldFileSha512,
				bytes: 0,
				steps: [],
			});
		for (const state of previous) {
			const bytes = state.bytes + edge.patchSize;
			if (
				state.steps.length >= MAX_RELEASE_PATCH_STEPS ||
				bytes > MAX_RELEASE_PATCH_BYTES ||
				bytes >= input.targetSize
			)
				continue;
			const next: PathState = {
				version: edge.toVersion,
				size: meta.newFileSize,
				sha512: meta.newFileSha512,
				bytes,
				steps: [...state.steps, edge],
			};
			const key = JSON.stringify([next.version, next.size, next.sha512, next.steps.length]);
			const existing = states.get(key);
			if (!existing || comparePaths(next, existing) < 0) states.set(key, next);
		}
	}
	return [...states.values()]
		.filter(
			(state) =>
				state.version === input.targetVersion &&
				state.size === input.targetSize &&
				state.sha512 === input.targetSha512,
		)
		.sort(comparePaths)[0]?.steps;
}
