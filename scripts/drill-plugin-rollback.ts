import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { manifestSchema } from "../server/lib/plugins/manifest";

const root = resolve(import.meta.dir, "..");
for (const path of [
	"server/services/plugin-upgrade-coordinator.ts",
	"server/lib/plugins/manifest.ts",
	"tests/fixtures/plugins/e2e/reference-ui-hostile/manifest.json",
]) {
	if (!existsSync(resolve(root, path))) throw new Error(`Missing rollback drill input: ${path}`);
}
const { PluginUpgradeCoordinator } = await import("../server/services/plugin-upgrade-coordinator");
const manifest = manifestSchema.parse(
	JSON.parse(
		readFileSync(
			resolve(root, "tests/fixtures/plugins/e2e/reference-ui-hostile/manifest.json"),
			"utf8",
		),
	),
);

let current = { version: "1.0.0", hash: "a".repeat(64) };
const starts: string[] = [];
const coordinator = new PluginUpgradeCoordinator({
	store: {
		async readCurrent() {
			return { version: 1, plugins: { "com.example.rollback": current } };
		},
		async install() {
			return {
				pluginId: "com.example.rollback",
				version: "2.0.0",
				hash: "b".repeat(64),
				path: "/tmp/plugin-v2",
				packagePath: "/tmp/plugin-v2",
				manifest,
				alreadyInstalled: false,
				currentUpdated: false,
			};
		},
		async setCurrent(_pluginId, pointer) {
			if (pointer) current = pointer;
			return { version: 1, plugins: { "com.example.rollback": current } };
		},
	},
	runtime: {
		async stop() {},
		async start(_pluginId, pointer) {
			starts.push(`${pointer.version}:${pointer.hash.slice(0, 4)}`);
		},
	},
	healthCheck: async (_pluginId, pointer) => pointer.version !== "2.0.0",
});

try {
	await coordinator.upgrade("com.example.rollback", "/tmp/plugin-v2");
	throw new Error("expected health-gated upgrade to fail");
} catch (error) {
	const record = (error as { upgrade?: { status?: string; lastKnownGood?: unknown } }).upgrade;
	if (record?.status !== "rolled-back" || current.version !== "1.0.0") {
		throw new Error("rollback drill did not restore last-known-good");
	}
	process.stdout.write(
		`${JSON.stringify({ status: record.status, current, lastKnownGood: record.lastKnownGood, starts })}\n`,
	);
}
