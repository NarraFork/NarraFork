import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext, Page } from "puppeteer-core";
import {
	parseQuotaSmokeArgs,
	QuotaBrowserSmoke,
	QuotaSmokeContext,
} from "../../scripts/smoke-provider-quota";
import {
	detectUpgradeBaseline,
	sameSmokeFile,
	upgradeBuildReady,
	upgradeOptions,
	verifyReplacementGrants,
	verifyRetainedGrants,
	verifyUpgradeKeyState,
} from "../../scripts/smoke-provider-quota-upgrade";

const args = ["--binary=original.exe", "--archive=quota.nfplugin", "--out=evidence"];
const legacy = {
	installationId: "original-install",
	grants: [{ grantId: "original-grant", capability: "provider.use" }],
};
const current = () => ({
	installationId: "new-install",
	grants: ["quota.provide", "provider.connection.request"].map((capability, i) => ({
		grantId: `new-${i}`,
		capability,
		grantedBy: "system",
	})),
});

describe("original-host upgrade acceptance", () => {
	test("requires distinct explicit inputs, the full smoke contract and an exclusive output directory", () => {
		const candidate = "--candidate=next.exe";
		expect(upgradeOptions([...args, candidate])).toMatchObject({
			binary: resolve("original.exe"),
			candidate: resolve("next.exe"),
			out: resolve("evidence"),
			baseline: false,
		});
		for (const extra of [
			[],
			["--candidate="],
			["--candidate=./original.exe"],
			[candidate, candidate],
			[candidate, "--baseline"],
			[candidate, "--skip-browser"],
		])
			expect(() => upgradeOptions([...args, ...extra])).toThrow();
	});
	test("discovers the actual baseline package without guessing from the commit", () => {
		const legacyPlugin = {
			pluginId: "com.narrafork.apikey-quota",
			current: { version: "1.0.0" },
			builtin: true,
			desiredState: "enabled",
		};
		const replacement = {
			pluginId: "io.narrafork.provider-quota",
			current: { version: "1.0.3" },
			runtimeState: "active",
			desiredState: "enabled",
		};
		expect(detectUpgradeBaseline(legacyPlugin, null)).toMatchObject({
			pluginId: legacyPlugin.pluginId,
			legacyBaseline: true,
		});
		expect(detectUpgradeBaseline(null, replacement)).toMatchObject({
			pluginId: replacement.pluginId,
			legacyBaseline: false,
		});
		expect(detectUpgradeBaseline(null, null)).toBeUndefined();
		expect(
			detectUpgradeBaseline({ ...legacyPlugin, desiredState: "disabled" }, null),
		).toBeUndefined();
		expect(() => detectUpgradeBaseline(legacyPlugin, replacement)).toThrow(
			"both quota plugin identities",
		);
		expect(() =>
			detectUpgradeBaseline(null, { ...replacement, current: { version: "9.0.0" } }),
		).toThrow("Unsupported baseline");
	});
	test("credential migration permits only the expected billing ID mapping and keeps the spare", () => {
		const original = [
			{ id: "old-primary", label: "primary", priority: 0, disabled: false },
			{ id: "spare", label: "spare", priority: 1, disabled: true },
		];
		const migrated = [{ ...original[0], id: "provider-id" }, { ...original[1] }];
		expect(() => verifyUpgradeKeyState(original, migrated, "provider-id")).not.toThrow();
		expect(() =>
			verifyUpgradeKeyState(original, structuredClone(original), "old-primary"),
		).not.toThrow();
		for (const change of [
			"primary",
			"spare",
			"order",
			"disabled",
			"label",
			"network",
			"secret",
			"removed",
		] as const) {
			const broken: Array<Record<string, unknown>> = structuredClone(migrated);
			if (change === "primary") broken[0].id = "unexpected-primary";
			if (change === "spare") broken[1].id = "unexpected-spare";
			if (change === "order") broken.reverse();
			if (change === "disabled") broken[1].disabled = false;
			if (change === "label") broken[0].label = "other";
			if (change === "network") broken[0].network = { proxy: { mode: "direct" } };
			if (change === "secret") broken[0].apiKey = "exposed";
			if (change === "removed") broken.pop();
			expect(() => verifyUpgradeKeyState(original, broken, "provider-id")).toThrow();
		}
	});
	test("startup liveness and recovery cannot be mistaken for the candidate build", () => {
		const build = { version: "0.9.15", commit: "123456789" };
		const ready = {
			status: "ok",
			readiness: "ready",
			version: "0.9.15+123456789",
			commit: build.commit,
		};
		expect(upgradeBuildReady(ready, build)).toBe(true);
		expect(upgradeBuildReady({ status: "starting" }, build)).toBe(false);
		expect(
			upgradeBuildReady({ ...ready, status: "recovering", readiness: "recovering" }, build),
		).toBe(false);
		for (const bad of [
			{ ...ready, commit: "abcdef123" },
			{ ...ready, version: "0.9.14+123456789" },
			{ ...ready, readiness: "failed" },
			{ ...ready, status: "failed" },
		])
			expect(() => upgradeBuildReady(bad, build)).toThrow();
	});
	test("handoff checks the owned file identity, not its basename or parent spelling", async () => {
		const root = await mkdtemp(join(tmpdir(), "nf-upgrade-ownership-"));
		try {
			await mkdir(join(root, "owned"));
			await mkdir(join(root, "other"));
			const good = join(root, "owned", "same.bin"),
				different = join(root, "other", "same.bin");
			await writeFile(good, "same contents");
			await writeFile(different, "same contents");
			await symlink(
				join(root, "owned"),
				join(root, "alias"),
				process.platform === "win32" ? "junction" : "dir",
			);
			expect(await sameSmokeFile(join(root, "alias", "same.bin"), good)).toBe(true);
			expect(await sameSmokeFile(different, good)).toBe(false);
			expect(await sameSmokeFile("same.bin", good)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	test("an upgrade evidence page never re-seeds its session while ordinary smoke pages still do", async () => {
		const context = new QuotaSmokeContext(
			parseQuotaSmokeArgs(args),
			resolve("unused-upgrade-home"),
		);
		context.token = "fixture-token";
		const localeContexts = new Map<"en" | "zh-CN", BrowserContext>();
		const browser = new QuotaBrowserSmoke(context, "unused-narrator", localeContexts);
		const seeded: unknown[][] = [];
		const page = {
			setDefaultTimeout() {},
			setDefaultNavigationTimeout() {},
			async setViewport() {},
			on() {},
			async setRequestInterception() {},
			async createCDPSession() {
				return { async send() {}, on() {} };
			},
			async evaluateOnNewDocument(...values: unknown[]) {
				seeded.push(values);
			},
		} as unknown as Page;
		localeContexts.set("zh-CN", {
			async newPage() {
				return page;
			},
		} as unknown as BrowserContext);
		await browser.newPage("zh-CN", { seedSession: false });
		expect(seeded).toHaveLength(0);
		await browser.newPage("zh-CN");
		expect(seeded).toHaveLength(1);
		expect(seeded[0].slice(1)).toEqual(["fixture-token", "zh-CN"]);
	});
	test("accepts fresh grants, not a renamed installation or a copy of old authority", () => {
		expect(() => verifyReplacementGrants(legacy, current())).not.toThrow();
		for (const change of ["installation", "grant", "wide", "missing", "actor"]) {
			const next = current();
			if (change === "installation") next.installationId = legacy.installationId;
			if (change === "grant") next.grants[0].grantId = legacy.grants[0].grantId;
			if (change === "wide")
				next.grants.push({ grantId: "another", capability: "provider.use", grantedBy: "system" });
			if (change === "missing") next.grants.pop();
			if (change === "actor") next.grants[0].grantedBy = "previous-operator";
			expect(() => verifyReplacementGrants(legacy, next)).toThrow();
		}
	});
});

test("same-plugin upgrade preserves installation, grant IDs, constraints and revision", () => {
	const original = { ...current(), revision: 9 };
	expect(() => verifyRetainedGrants(original, structuredClone(original))).not.toThrow();
	for (const change of ["installation", "grant", "capability", "revision"]) {
		const next = structuredClone(original);
		if (change === "installation") next.installationId = "other-installation";
		if (change === "grant") next.grants[0].grantId = "new-grant";
		if (change === "capability") next.grants[0].capability = "provider.settings.read_self";
		if (change === "revision") next.revision++;
		expect(() => verifyRetainedGrants(original, next)).toThrow();
	}
});

test("upgrade may keep HOME and DB under an owned parent without moving the isolated executable", () => {
	const options = upgradeOptions([...args, "--candidate=next.exe", "--data-parent=t"]);
	const runtimeRoot = resolve("isolated-runtime"),
		dataRoot = resolve("t/owned-data");
	const context = new QuotaSmokeContext(options, runtimeRoot, undefined, dataRoot);
	expect(options.dataParent).toBe(resolve("t"));
	expect(context.cwd).toBe(join(runtimeRoot, "run"));
	expect(context.env.NARRAFORK_HOME).toBe(join(dataRoot, "data"));
	expect(context.env.HOME).toBe(join(dataRoot, "home"));
});
