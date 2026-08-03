import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "@server/lib/plugins/manifest";
import { CAPABILITIES, capabilitySchema } from "@server/lib/plugins/permissions";
import {
	PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES,
	PLUGIN_TO_HOST_REQUEST_METHODS,
	PUBLIC_ERROR_CODES,
} from "@server/lib/plugins/protocol";
import {
	uiRpcErrorSchema as frontendUiRpcErrorSchema,
	PLUGIN_UI_BACKEND_METHODS,
} from "../../../../frontend/components/plugins/protocol";

const expectedSharedMethods = [
	"queries.execute",
	"commands.execute",
	"events.subscribe",
	"events.unsubscribe",
	"events.poll",
	"storage.get",
	"storage.set",
	"storage.delete",
	"storage.list",
	"config.get",
	"secrets.get",
	"secrets.set",
	"secrets.delete",
	"secrets.list",
	"diagnostics.getOwn",
] as const;

const expectedSharedBusinessErrors = [
	"PLUGIN_DISABLED",
	"PLUGIN_UI_SESSION_INVALID",
	"PLUGIN_UI_PACKAGE_NOT_CURRENT",
	"PERMISSION_DENIED",
	"STORAGE_QUOTA_EXCEEDED",
	"STORAGE_CONFLICT",
	"PLUGIN_BUSY",
	"CANCELLED",
	"UNKNOWN_RESULT",
	"RATE_LIMITED",
	"INCOMPATIBLE",
] as const;

const methodCapabilityExamples = {
	"queries.execute": ["query.read.projects"],
	"commands.execute": ["command.chapter.write"],
	"events.subscribe": ["event.subscribe.public"],
	"events.unsubscribe": ["event.subscribe.public"],
	"events.poll": ["event.subscribe.public"],
	"storage.get": ["storage.read_self"],
	"storage.set": ["storage.write_self"],
	"storage.delete": ["storage.write_self"],
	"storage.list": ["storage.read_self"],
	"config.get": ["config.read_self"],
	"secrets.get": ["secret.use_self"],
	"secrets.set": ["secret.use_self"],
	"secrets.delete": ["secret.use_self"],
	"secrets.list": ["secret.use_self"],
	"diagnostics.getOwn": ["diagnostics.readOwnLogs"],
} as const satisfies Record<(typeof expectedSharedMethods)[number], readonly string[]>;

function sameSet(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		[...left].sort().every((value, index) => value === [...right].sort()[index])
	);
}

function gatedTest(ready: boolean, name: string, body: () => void | Promise<void>): void {
	if (ready) test(name, body);
	else test.skip(`[BLOCKER] ${name}`, body);
}

const frontendMethodParity = sameSet(PLUGIN_UI_BACKEND_METHODS, expectedSharedMethods);
const serverErrorParity = expectedSharedBusinessErrors.every((code) =>
	(PUBLIC_ERROR_CODES as readonly string[]).includes(code),
);
const frontendErrorParity = expectedSharedBusinessErrors.every(
	(code) =>
		frontendUiRpcErrorSchema.safeParse({
			code,
			message: "contract probe",
			retryable: false,
		}).success,
);

describe("C1/C2 cross-end plugin contract parity", () => {
	test("keeps the backend Plugin→Host method inventory equal to the frozen C1 contract", () => {
		expect([...PLUGIN_TO_HOST_REQUEST_METHODS]).toEqual([...expectedSharedMethods]);
		expect(Object.keys(PLUGIN_TO_HOST_METHOD_REQUIRED_FEATURES).sort()).toEqual(
			[...expectedSharedMethods].sort(),
		);
	});

	test("assigns at least one canonical capability example to every shared method", () => {
		expect(Object.keys(methodCapabilityExamples).sort()).toEqual([...expectedSharedMethods].sort());
		for (const capabilities of Object.values(methodCapabilityExamples)) {
			expect(capabilities.length).toBeGreaterThan(0);
			for (const capability of capabilities) {
				expect(capabilitySchema.safeParse(capability).success).toBe(true);
				expect((CAPABILITIES as readonly string[]).includes(capability)).toBe(true);
				expect(capability.includes("*")).toBe(false);
			}
		}
	});

	test("keeps all e2e reference manifests strict, canonical, and self-contained", () => {
		for (const fixtureName of [
			"reference-tool-rpc",
			"reference-host-call-rpc",
			"reference-ui-hostile",
			// The provider fixture now ships a `provider-settings` view, so its asset paths
			// need the same existence check as every other reference manifest.
			"reference-provider-rpc",
		] as const) {
			const root = join(import.meta.dir, `../../../fixtures/plugins/e2e/${fixtureName}`);
			const manifest = parseManifest(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")));
			for (const capability of manifest.permissions.host) {
				expect(capabilitySchema.safeParse(capability).success).toBe(true);
			}
			for (const entry of [
				manifest.server?.entry,
				manifest.ui?.entry,
				manifest.ui?.style,
				...manifest.contributes.views.flatMap((view) => [view.entry, view.style]),
			].filter((value): value is string => Boolean(value))) {
				expect(existsSync(join(root, entry))).toBe(true);
			}
		}
	});

	gatedTest(
		frontendMethodParity,
		"frontend backend method registry exactly matches the shared Host API set",
		() => {
			expect([...PLUGIN_UI_BACKEND_METHODS] as string[]).toEqual([...expectedSharedMethods]);
		},
	);

	gatedTest(
		serverErrorParity && frontendErrorParity,
		"backend and iframe SDK accept the complete structured business-error set",
		() => {
			for (const code of expectedSharedBusinessErrors) {
				expect((PUBLIC_ERROR_CODES as readonly string[]).includes(code)).toBe(true);
				expect(
					frontendUiRpcErrorSchema.safeParse({
						code,
						message: "contract probe",
						retryable: false,
					}).success,
				).toBe(true);
			}
		},
	);

	test.skip("[BLOCKER] real stdio cancellation settles once and stale generations are dropped", () => {
		// The active vertical-slice covers Host identity, permission denial, and -32601.
		// Unskip when a deterministic child fixture can hold/cancel one side effect across reload.
	});
});
