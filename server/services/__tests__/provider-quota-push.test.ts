import { expect, test } from "bun:test";
import { captureCustomApiQuotaPushTarget, customApiQuotaPushPrefix } from "../provider-quota-push";
import { CustomApiQuotaTargetDirectory } from "../provider-quota-targets";
import { quotaProvider } from "./provider-quota-fixtures";

test("stream quota identity is frozen per pass and rejects late events after account changes", () => {
	const provider = quotaProvider();
	const directory = new CustomApiQuotaTargetDirectory({
		providers: () => [provider],
		globalProxy: () => ({}),
		userAgent: () => "fixture",
	});
	const captured = captureCustomApiQuotaPushTarget(provider.prefix, directory);
	if (!captured) throw new Error("expected Custom API target");
	expect(customApiQuotaPushPrefix(captured, directory)).toBe("custom");
	provider.prefix = "renamed";
	expect(customApiQuotaPushPrefix(captured, directory)).toBe("renamed");
	provider.apiKey = "replacement";
	expect(customApiQuotaPushPrefix(captured, directory)).toBeNull();
	expect(captureCustomApiQuotaPushTarget(provider.prefix, directory)?.generation).not.toBe(
		captured.generation,
	);
});

test("platform and NUG prefixes never acquire a Custom API push identity", () => {
	const directory = new CustomApiQuotaTargetDirectory({
		providers: () => [quotaProvider()],
		globalProxy: () => ({}),
		userAgent: () => "fixture",
	});
	for (const prefix of ["codex", "CommandCode", "tokendance", "nug"])
		expect(captureCustomApiQuotaPushTarget(prefix, directory)).toBeNull();
});
