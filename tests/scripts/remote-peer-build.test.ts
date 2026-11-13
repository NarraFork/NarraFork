import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	assertRemotePeerVersion,
	REMOTE_PEER_BUILD_TIME,
	REMOTE_PEER_GO_VERSION,
	remotePeerBuildRecipe,
} from "../../scripts/lib/remote-peer-build";
import { REMOTE_PEER_PLATFORMS, remotePeerPublishedFilename } from "../../shared/remote-peer";

const identity = { version: "0.1.0-alpha.1", commit: "a".repeat(40), protocolVersion: 1 };
describe("independent remote-peer build recipe", () => {
	for (const platform of REMOTE_PEER_PLATFORMS)
		test(`${platform} has exact independent Go toolchain, baseline CPU and deterministic source attribution`, () => {
			const recipe = remotePeerBuildRecipe(process.cwd(), platform, "/peer-dist", identity);
			expect(REMOTE_PEER_GO_VERSION).toBe("1.26.1");
			expect(recipe.environment).toMatchObject({
				CGO_ENABLED: "0",
				GOOS: platform.split("-")[0],
				GOARCH: platform.split("-")[1],
				GOAMD64: "v1",
				GOARM64: "v8.0",
				GOFLAGS: "",
				GOEXPERIMENT: "",
				GOWORK: "off",
				GOTOOLCHAIN: "local",
			});
			expect(recipe.args).toContain("-trimpath");
			expect(recipe.args).toContain("-buildvcs=false");
			expect(recipe.args).toContain("-mod=readonly");
			expect(recipe.args).toContain("./cmd/remote-peer");
			expect(recipe.args[1]).toEndWith("/remote-peer");
			expect(recipe.args.join(" ")).toContain(
				`narrafork/remote-peer/internal/buildinfo.Commit=${identity.commit}`,
			);
			expect(recipe.args.join(" ")).toContain(
				`narrafork/remote-peer/internal/buildinfo.BuildTime=${REMOTE_PEER_BUILD_TIME}`,
			);
			expect(recipe.args.join(" ")).toContain(
				remotePeerPublishedFilename(identity.version, platform),
			);
			expect(recipe.args.join(" ")).not.toContain("remote-executor");
			expect(recipe.args.join(" ")).not.toContain("native");
		});
	test("untrusted versions and source identities cannot inject build arguments", () => {
		for (const change of [
			{ version: "1.0.0 -X injected" },
			{ commit: "HEAD" },
			{ protocolVersion: 0 },
		])
			expect(() =>
				remotePeerBuildRecipe(".", "linux-amd64", "/output", { ...identity, ...change }),
			).toThrow();
	});
	test("native version proof binds pin, source, protocol, toolchain and deterministic timestamp", () => {
		const reported = { ...identity, buildTime: REMOTE_PEER_BUILD_TIME, goVersion: "go1.26.1" };
		expect(() => assertRemotePeerVersion(JSON.stringify(reported), identity)).not.toThrow();
		for (const change of [
			{ version: "0.1.0" },
			{ commit: "b".repeat(40) },
			{ protocolVersion: 2 },
			{ goVersion: "go1.27.0" },
			{ buildTime: "now" },
		])
			expect(() =>
				assertRemotePeerVersion(JSON.stringify({ ...reported, ...change }), identity),
			).toThrow();
	});
});

interface Workflow {
	name: string;
	on: { workflow_dispatch: { inputs: { publish: { default: boolean } } } };
	permissions: { contents: string };
	jobs: Record<
		string,
		{
			name: string;
			environment?: string;
			permissions?: { contents: string };
			strategy?: {
				matrix: { platform?: string[]; include?: { platform: string; runner: string }[] };
			};
			steps: { uses?: string; run?: string; with?: Record<string, string | boolean> }[];
		}
	>;
}
describe("peer protected workflow remains separate from executor", () => {
	const raw = readFileSync(".github/workflows/remote-peer-release.yml", "utf8");
	const workflow = Bun.YAML.parse(raw) as Workflow;
	test("is manual, build-only by default, approval protects the only write job", () => {
		expect(workflow.name).toBe("Remote peer release");
		expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
		expect(workflow.on.workflow_dispatch.inputs.publish.default).toBe(false);
		expect(workflow.permissions.contents).toBe("read");
		expect(
			Object.keys(workflow.jobs).filter(
				(key) => workflow.jobs[key]?.permissions?.contents === "write",
			),
		).toEqual(["publisher"]);
		expect(workflow.jobs.publisher?.environment).toBe("release");
		expect(workflow.jobs.publisher?.name).toBe("Publish approved remote peer draft");
		expect(workflow.jobs.gate?.name).toBe("Remote Peer Release Gate");
		expect(workflow.jobs.publisher?.steps.some((step) => step.run?.includes("restore"))).toBe(true);
		expect(workflow.jobs.publisher?.steps.some((step) => step.run?.includes("bun install"))).toBe(
			false,
		);
		expect(raw).not.toContain("--clobber");
		expect(raw).not.toContain("NF_UPDATE_TOKEN");
	});
	test("all six original binaries get explicit native platform smoke, not cross execution", () => {
		expect(workflow.jobs.build?.strategy?.matrix.platform).toEqual([...REMOTE_PEER_PLATFORMS]);
		const matrix = workflow.jobs.smoke?.strategy?.matrix.include ?? [];
		expect(matrix.map((item) => item.platform)).toEqual([...REMOTE_PEER_PLATFORMS]);
		expect(matrix.find((item) => item.platform === "windows-arm64")?.runner).toBe("windows-11-arm");
		expect(matrix.find((item) => item.platform === "darwin-amd64")?.runner).toBe("macos-26-intel");
		expect(
			workflow.jobs.build?.steps.find((step) => step.uses?.startsWith("actions/setup-go@"))?.with,
		).toMatchObject({ "go-version": "1.26.1", "check-latest": false, cache: false });
	});
	test("pins all actions and restores immutable original bundle before publishing", () => {
		for (const job of Object.values(workflow.jobs))
			for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
		expect(raw).toContain(`ref: \${{ needs.preflight.outputs.commit }}`);
		expect(raw).toContain('--source-run-id="$ORIGIN_RUN_ID"');
		expect(raw).toContain('--bundle-artifact-id="$BUNDLE_ARTIFACT_ID"');
		expect(raw).toContain(
			`auxiliary-publication-receipt-\${{ github.run_id }}-\${{ github.run_attempt }}`,
		);
		expect(raw).not.toContain("scripts/release.ts");
	});
	test("executor workflow and recipe retain their original toolchain and distribution identity", () => {
		const oldWorkflow = readFileSync(".github/workflows/helpers-release.yml", "utf8");
		const oldRecipe = readFileSync("scripts/lib/helper-build.ts", "utf8");
		expect(oldWorkflow).toContain("go-version: 1.24.13");
		expect(oldWorkflow).not.toContain("remote-peer");
		expect(oldRecipe).not.toContain("remote-peer");
	});
});
