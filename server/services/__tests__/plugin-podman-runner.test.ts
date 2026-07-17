import { describe, expect, test } from "bun:test";
import { buildPodmanCommand, PodmanRunner } from "../plugin-podman-runner";

describe("PodmanRunner command", () => {
	test("uses rootless least-privilege defaults and read-only package", () => {
		const command = buildPodmanCommand(
			{
				runtimeId: "rt-1",
				image: "nf/plugin",
				imageDigest: "sha256:abc",
				packagePath: "/pkg",
				dataPath: "/data",
			},
			["/plugin/index.js"],
		);
		expect(command).toContain("--read-only");
		expect(command).toContain("--cap-drop");
		expect(command).toContain("ALL");
		expect(command).toContain("--network");
		expect(command).toContain("none");
		expect(command.join(" ")).toContain("/pkg:/plugin:ro");
		expect(command.join(" ")).toContain("--pids-limit 128");
		expect(command.filter((part) => part.includes(":/tmp")).length).toBe(0);
		expect(command.filter((part) => part.startsWith("/tmp:")).length).toBe(1);
	});
	test("uses one deterministic /tmp mount when a host temp path is provided", () => {
		const command = buildPodmanCommand(
			{
				runtimeId: "rt-temp",
				image: "nf/plugin",
				imageDigest: "sha256:abc",
				packagePath: "/pkg",
				dataPath: "/data",
				tempPath: "/temp",
			},
			["/plugin/index.js"],
		);
		expect(command.filter((part) => part.includes("/tmp")).length).toBe(1);
		expect(command.join(" ")).toContain("/temp:/tmp:rw");
		expect(command.join(" ")).not.toContain("--tmpfs");
	});
	test("fails closed when Podman is unavailable", async () => {
		const runner = new PodmanRunner(
			{
				runtimeId: "rt-unavailable",
				image: "nf/plugin",
				imageDigest: "sha256:abc",
				packagePath: "/pkg",
				dataPath: "/data",
			},
			{ available: false },
		);
		await expect(
			runner.start({ command: ["bun", "/plugin/index.js"], cwd: "/pkg" }),
		).rejects.toThrow(/Podman is unavailable/);
	});
	test("rejects mutable image tags without digest", () => {
		expect(() =>
			buildPodmanCommand(
				{
					runtimeId: "rt",
					image: "nf/plugin",
					imageDigest: "latest",
					packagePath: "/pkg",
					dataPath: "/data",
				},
				["index.js"],
			),
		).toThrow();
	});
});
