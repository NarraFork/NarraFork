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
	sameSmokeFile,
	upgradeBuildReady,
	upgradeOptions,
	verifyReplacementGrants,
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
		const browser = new QuotaBrowserSmoke(context, "unused-narrator");
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
		browser.localeContexts.set("zh-CN", {
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
