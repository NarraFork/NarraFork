import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { getDbPath } from "../server/db/connection";
import { narraforkDir } from "../server/lib/settings";
import { testEnvironment } from "./preload";

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

describe("global test data isolation", () => {
	test("redirects database and home-based storage away from the real ~/.narrafork", () => {
		expect(normalizedPath(process.env.HOME ?? "")).toBe(
			normalizedPath(testEnvironment.isolatedHome),
		);
		expect(normalizedPath(process.env.USERPROFILE ?? "")).toBe(
			normalizedPath(testEnvironment.isolatedHome),
		);
		expect(normalizedPath(process.env.NARRAFORK_HOME ?? "")).toBe(
			normalizedPath(testEnvironment.narraforkHome),
		);
		expect(normalizedPath(getDbPath())).toBe(
			normalizedPath(resolve(testEnvironment.narraforkHome, "narrafork.db")),
		);
		expect(normalizedPath(narraforkDir)).toBe(normalizedPath(testEnvironment.narraforkHome));
		expect(normalizedPath(getDbPath())).not.toBe(
			normalizedPath(resolve(testEnvironment.realNarraforkHome, "narrafork.db")),
		);
		expect(normalizedPath(narraforkDir)).not.toBe(
			normalizedPath(testEnvironment.realNarraforkHome),
		);
	});
});
