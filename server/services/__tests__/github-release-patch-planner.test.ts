import { describe, expect, test } from "bun:test";
import {
	type GithubPatchStep,
	MAX_RELEASE_LEGACY_BYTES,
	MAX_RELEASE_PATCH_BYTES,
	MAX_RELEASE_PATCH_METADATA,
	MAX_RELEASE_PATCH_STEPS,
} from "../../../shared/release-patch";
import { planGithubReleasePatches } from "../github-release-patch-planner";

const hash = (letter: string) => `${letter.repeat(86)}==`;
const identity = hash("A");
function edge(
	from: string,
	to: string,
	options: {
		bytes?: number;
		mode?: GithubPatchStep["meta"]["mode"];
		oldHash?: string;
		newHash?: string;
		oldSize?: number;
		newSize?: number;
		url?: string;
	} = {},
): GithubPatchStep {
	return {
		fromVersion: from,
		toVersion: to,
		patchSize: options.bytes ?? 10,
		url: options.url ?? `https://github.com/Owner/Repo/${from}/${to}`,
		metaUrl: `https://github.com/Owner/Repo/${from}/${to}.meta.json`,
		meta: {
			fromVersion: from,
			toVersion: to,
			oldFileSize: options.oldSize ?? 1000,
			newFileSize: options.newSize ?? 1000,
			oldFileSha512: options.oldHash ?? identity,
			newFileSha512: options.newHash ?? identity,
			stableEnd: 0,
			newTailSize: options.newSize ?? 1000,
			patchSize: options.bytes ?? 10,
			mode: options.mode,
		},
	};
}
function plan(
	steps: GithubPatchStep[],
	overrides: Partial<Parameters<typeof planGithubReleasePatches>[0]> = {},
) {
	return planGithubReleasePatches({
		currentVersion: "1.0.0",
		targetVersion: "3.0.0",
		targetSize: 1000,
		targetSha512: identity,
		steps,
		...overrides,
	});
}

describe("GitHub release identity graph planner", () => {
	test("direct/default and multibase alternatives select minimum total bytes", () => {
		const direct = edge("1.0.0", "3.0.0", { bytes: 50 });
		const first = edge("1.0.0", "2.0.0");
		const second = edge("2.0.0", "3.0.0");
		expect(plan([direct, second, first])).toEqual([first, second]);
		expect(plan([edge("0.9.0", "3.0.0"), direct])).toEqual([direct]);
	});
	test("ties prefer fewer hops, then deterministic URL order regardless of input order", () => {
		const direct = edge("1.0.0", "3.0.0", { bytes: 20, url: "a" });
		const same = edge("1.0.0", "3.0.0", { bytes: 20, url: "z" });
		const chain = [edge("1.0.0", "2.0.0"), edge("2.0.0", "3.0.0")];
		expect(plan([same, ...chain, direct])).toEqual([direct]);
		expect(plan([direct, ...chain.reverse(), same])).toEqual([direct]);
	});
	test("retains a more costly matching identity at the same version", () => {
		const wrong = edge("1.0.0", "2.0.0", { bytes: 1, newHash: hash("B") });
		const correct = edge("1.0.0", "2.0.0", { bytes: 11 });
		const final = edge("2.0.0", "3.0.0");
		expect(plan([wrong, correct, final])).toEqual([correct, final]);
		expect(plan([wrong, final])).toBeUndefined();
		expect(plan([edge("1.0.0", "2.0.0", { newSize: 999 }), final])).toBeUndefined();
	});
	test("target and optional current baseline identities are binding", () => {
		const step = edge("1.0.0", "3.0.0");
		expect(plan([step], { currentSize: 999 })).toBeUndefined();
		expect(plan([step], { currentSha512: hash("B") })).toBeUndefined();
		expect(plan([step], { targetSha512: hash("B") })).toBeUndefined();
		expect(plan([step], { targetSize: 999 })).toBeUndefined();
	});
	test("stable target allows increasing beta intermediate but rejects cycles/decreasing edges", () => {
		const first = edge("1.0.0", "3.0.0-beta.1");
		const final = edge("3.0.0-beta.1", "3.0.0");
		expect(plan([first, final, edge("3.0.0", "1.0.0")])).toEqual([first, final]);
		expect(plan([edge("1.0.0", "1.0.0"), edge("1.0.0", "0.9.0")])).toBeUndefined();
	});
	test("metadata, aggregate bytes and strict full-size savings limits", () => {
		expect(plan([edge("1.0.0", "3.0.0", { bytes: 1000 })])).toBeUndefined();
		expect(
			plan([edge("1.0.0", "3.0.0", { bytes: MAX_RELEASE_PATCH_BYTES + 1 })], {
				targetSize: 1024 ** 3,
			}),
		).toBeUndefined();
		expect(
			plan(
				[
					edge("1.0.0", "2.0.0", { bytes: MAX_RELEASE_PATCH_BYTES, mode: "patch-from" }),
					edge("2.0.0", "3.0.0", { newSize: 1024 ** 3, mode: "patch-from" }),
				],
				{ targetSize: 1024 ** 3 },
			),
		).toBeUndefined();
		const maximum = edge("1.0.0", "3.0.0", {
			bytes: MAX_RELEASE_PATCH_BYTES,
			newSize: 1024 ** 3,
			mode: "patch-from",
		});
		expect(plan([maximum], { targetSize: 1024 ** 3 })).toEqual([maximum]);
		expect(
			plan(Array.from({ length: MAX_RELEASE_PATCH_METADATA + 1 }, () => edge("1.0.0", "3.0.0"))),
		).toBeUndefined();
	});
	test("hop limit preserves a costlier short path to the same identity", () => {
		const long = Array.from({ length: MAX_RELEASE_PATCH_STEPS }, (_, i) =>
			edge(`1.0.${i}`, `1.0.${i + 1}`, { bytes: 1 }),
		);
		const final = edge(`1.0.${MAX_RELEASE_PATCH_STEPS}`, "3.0.0");
		expect(plan([...long, final])).toBeUndefined();
		const shortcut = edge("1.0.0", `1.0.${MAX_RELEASE_PATCH_STEPS}`, { bytes: 30 });
		expect(plan([...long, final, shortcut])).toEqual([shortcut, final]);
		expect(plan(long, { targetVersion: `1.0.${MAX_RELEASE_PATCH_STEPS}` })).toEqual(long);
	});
	test("large legacy cannot displace an executable patch-from path", () => {
		const size = MAX_RELEASE_LEGACY_BYTES + 1;
		for (const mode of [undefined, "dictionary"] as const) {
			const legacy = edge("1.0.0", "3.0.0", { bytes: 1, oldSize: size, newSize: size, mode });
			const streaming = edge("1.0.0", "3.0.0", {
				bytes: 20,
				oldSize: size,
				newSize: size,
				mode: "patch-from",
			});
			expect(plan([legacy], { targetSize: size })).toBeUndefined();
			expect(plan([legacy, streaming], { targetSize: size })).toEqual([streaming]);
		}
	});
	test("legacy limit applies to old, new and patch bytes individually; exact boundary remains usable", () => {
		const size = MAX_RELEASE_LEGACY_BYTES + 1;
		const largeOld = edge("1.0.0", "3.0.0", { oldSize: size });
		expect(plan([largeOld])).toBeUndefined();
		largeOld.meta.mode = "patch-from";
		expect(plan([largeOld])).toEqual([largeOld]);
		const largeNew = edge("1.0.0", "3.0.0", { newSize: size });
		expect(plan([largeNew], { targetSize: size })).toBeUndefined();
		largeNew.meta.mode = "patch-from";
		expect(plan([largeNew], { targetSize: size })).toEqual([largeNew]);
		const largePatch = edge("1.0.0", "2.0.0", { bytes: size });
		const final = edge("2.0.0", "3.0.0", { newSize: size * 2, mode: "patch-from" });
		expect(plan([largePatch, final], { targetSize: size * 2 })).toBeUndefined();
		largePatch.meta.mode = "patch-from";
		expect(plan([largePatch, final], { targetSize: size * 2 })).toEqual([largePatch, final]);
		for (const mode of [undefined, "dictionary"] as const) {
			const boundary = edge("1.0.0", "3.0.0", {
				oldSize: MAX_RELEASE_LEGACY_BYTES,
				newSize: MAX_RELEASE_LEGACY_BYTES,
				mode,
			});
			expect(plan([boundary], { targetSize: MAX_RELEASE_LEGACY_BYTES })).toEqual([boundary]);
		}
	});
	test("invalid metadata is ignored without hiding another valid path", () => {
		const invalid = edge("1.0.0", "3.0.0", { bytes: 1 });
		invalid.meta.newTailSize = 999;
		const valid = edge("1.0.0", "3.0.0");
		expect(plan([invalid, valid])).toEqual([valid]);
	});
});
