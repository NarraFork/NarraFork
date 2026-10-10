import { describe, expect, test } from "bun:test";
import { updateServerChildEnvironment } from "./update-server-child-env";

describe("update-server child environment", () => {
	test("removes only upload-only settings, including case variants", () => {
		const environment: NodeJS.ProcessEnv = {
			NF_UPDATE_TOKEN: "fake-upload-secret",
			nf_update_token: "fake-upload-secret",
			Nf_Update_Token: "fake-upload-secret",
			NF_UPDATE_SERVER: "https://fixture-upload.invalid",
			nf_update_server: "https://fixture-upload.invalid",
			GH_TOKEN: "fake-gh-token",
			GITHUB_TOKEN: "fake-fallback-token",
			PATH: "/fixture/bin",
			HOME: "/fixture/home",
			HTTPS_PROXY: "http://fixture-proxy.invalid:8080",
			NO_PROXY: "localhost",
			NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
			GITHUB_RUN_ID: "101",
			ZSTD_NBTHREADS: "2",
			NF_UPDATE_TOKEN_SUFFIX: "unrelated-setting",
			EMPTY: "",
			UNSET: undefined,
		};
		const before = { ...environment };
		const filtered = updateServerChildEnvironment(environment);
		expect(
			Object.keys(filtered).filter((name) =>
				["NF_UPDATE_TOKEN", "NF_UPDATE_SERVER"].includes(name.toUpperCase()),
			),
		).toEqual([]);
		const expected = { ...environment };
		for (const name of [
			"NF_UPDATE_TOKEN",
			"nf_update_token",
			"Nf_Update_Token",
			"NF_UPDATE_SERVER",
			"nf_update_server",
		])
			delete expected[name];
		expect(filtered).toEqual(expected);
		expect(environment).toEqual(before);
	});

	test("returns independent mutable copies without altering the parent or another child", () => {
		const environment = Object.freeze({
			NF_UPDATE_TOKEN: "fake-upload-secret",
			GH_TOKEN: "fake-gh-token",
		});
		const first = updateServerChildEnvironment(environment);
		const second = updateServerChildEnvironment(environment);
		expect(first).not.toBe(environment);
		expect(first).not.toBe(second);
		first.GH_TOKEN = "changed-child-token";
		expect(second.GH_TOKEN).toBe("fake-gh-token");
		expect(environment.NF_UPDATE_TOKEN).toBe("fake-upload-secret");
	});

	test("default input clones the current environment without mutating it", () => {
		const filtered = updateServerChildEnvironment();
		expect(filtered).not.toBe(process.env);
		expect(filtered.PATH).toBe(process.env.PATH);
		expect(Object.keys(filtered).some((name) => name.toUpperCase() === "NF_UPDATE_TOKEN")).toBe(
			false,
		);
	});
});
