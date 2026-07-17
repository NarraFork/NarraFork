import { describe, expect, test } from "bun:test";
import { PluginProcessRunner } from "../plugin-process-runner";

describe("plugin process runner", () => {
	test("rejects shell-like empty commands before spawning", async () => {
		await expect(new PluginProcessRunner().run([])).rejects.toThrow();
	});
});
