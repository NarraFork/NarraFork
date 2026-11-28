import { expect, test } from "bun:test";
import { saveSettings, settings } from "../settings";
import { createGroupAllocator } from "./allocate-group";

test("group allocation shares id/prefix reservations across every source namespace", () => {
	const original = structuredClone(settings);
	try {
		const next = structuredClone(settings);
		next.customApiProviders = [
			{
				id: "custom-id",
				name: "custom",
				prefix: "shared",
				baseUrl: "https://custom.example/v1",
				defaultModel: "",
				protocol: "completions-compatible",
				apiKey: "",
			},
		];
		next.nugProviders = [
			{
				id: "nug-id",
				name: "nug",
				prefix: "nug",
				baseUrl: "https://nug.example",
				defaultModel: "",
				apiKey: "",
			},
		];
		(next.agent as unknown as Record<string, unknown>).platformInstances = [
			{ id: "platform-id", platform: "CommandCode", prefix: "platform" },
		];
		saveSettings(next);
		const allocator = createGroupAllocator();
		const custom = allocator.allocate({ id: "custom-id", prefix: "auto" });
		expect(custom.id).not.toBe("custom-id");
		expect(custom.prefix).toBe("auto-2");
		const nug = allocator.allocate({ id: "nug-id", prefix: "shared" });
		expect(nug.id).not.toBe("nug-id");
		expect(nug.prefix).toBe("shared-2");
		expect(allocator.allocate({ id: "platform-id", prefix: "platform" }).prefix).toBe("platform-2");
		expect(allocator.allocate({ id: "fresh", prefix: "codex" }).prefix).toBe("codex-2");
		expect(allocator.allocate({ id: "fresh-2", prefix: "CommandCode" }).prefix).toBe(
			"CommandCode-2",
		);
		expect(allocator.allocate({ id: "fresh-3", prefix: "__agg__" }).prefix).toBe("__agg__-2");
		expect(allocator.allocate(custom).id).not.toBe(custom.id);
	} finally {
		saveSettings(original);
	}
});
