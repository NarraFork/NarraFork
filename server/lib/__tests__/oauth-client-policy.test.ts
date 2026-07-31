import { describe, expect, test } from "bun:test";
import {
	DEFAULT_OAUTH_CLIENT_POLICY,
	intersectOAuthClientPolicies,
	oauthClientPolicySchema,
	oauthNarratorProvisionSnapshotSchema,
} from "../oauth-client-policy";

describe("OAuth client device access policy", () => {
	// Device ownership is the trust boundary for global/selfRegistered: a client only ever
	// governs devices it registered and owns, or global-scoped devices it did not register.
	// The NarraFork host itself is a distinct, higher-risk group that defaults to denied
	// but remains individually configurable.
	test("defaults host to denied and the other two device groups to open", () => {
		expect(oauthClientPolicySchema.parse({})).toEqual({
			...DEFAULT_OAUTH_CLIENT_POLICY,
			deviceAccess: {
				host: "denied",
				global: "readWrite",
				selfRegistered: "readWrite",
			},
		});
	});

	test("intersections can only retain or reduce each device group's level", () => {
		const broad = oauthClientPolicySchema.parse({
			deviceAccess: { host: "readWrite", global: "readWrite", selfRegistered: "readWrite" },
		});
		const globalReadOnly = oauthClientPolicySchema.parse({
			deviceAccess: { host: "readWrite", global: "readOnly", selfRegistered: "readWrite" },
		});
		const noSelfRegisteredWrites = oauthClientPolicySchema.parse({
			deviceAccess: { host: "readWrite", global: "readWrite", selfRegistered: "denied" },
		});

		expect(
			intersectOAuthClientPolicies(broad, globalReadOnly, noSelfRegisteredWrites),
		).toMatchObject({
			deviceAccess: {
				host: "readWrite",
				global: "readOnly",
				selfRegistered: "denied",
			},
		});
		expect(
			intersectOAuthClientPolicies(
				broad,
				oauthClientPolicySchema.parse({
					deviceAccess: { host: "denied", global: "denied", selfRegistered: "readWrite" },
				}),
			),
		).toMatchObject({
			deviceAccess: {
				host: "denied",
				global: "denied",
				selfRegistered: "readWrite",
			},
		});
	});

	test("host defaults to denied in an intersection unless every layer explicitly widens it", () => {
		const clientWidened = oauthClientPolicySchema.parse({
			deviceAccess: { host: "readWrite", global: "readWrite", selfRegistered: "readWrite" },
		});
		const authorityDefault = oauthClientPolicySchema.parse({});
		expect(intersectOAuthClientPolicies(clientWidened, authorityDefault)).toMatchObject({
			deviceAccess: { host: "denied" },
		});
		expect(
			intersectOAuthClientPolicies(
				clientWidened,
				oauthClientPolicySchema.parse({
					deviceAccess: { host: "readOnly", global: "readWrite", selfRegistered: "readWrite" },
				}),
			),
		).toMatchObject({ deviceAccess: { host: "readOnly" } });
	});

	test("rejects an invalid device access level", () => {
		expect(() =>
			oauthClientPolicySchema.parse({ deviceAccess: { host: "bypassEverything" } }),
		).toThrow();
	});

	test("rejects the removed narratorBound key", () => {
		expect(() =>
			oauthClientPolicySchema.parse({
				deviceAccess: {
					host: "denied",
					global: "readWrite",
					narratorBound: "readWrite",
					selfRegistered: "readWrite",
				},
			}),
		).toThrow();
	});

	describe("legacy field migration", () => {
		// Real stored data (oauth_clients.policyJson, integration_authorities.policyJson,
		// and the nested narrator.oauthPolicySnapshotJson.policy) predates the device-group
		// model and contains allowRemoteShell/remoteShellLevel/allowRemoteFileWrite. These
		// must parse transparently without throwing, since all three JSON columns route
		// through this same schema.
		test("migrates allowRemoteShell + remoteShellLevel + allowRemoteFileWrite into deviceAccess", () => {
			const migrated = oauthClientPolicySchema.parse({
				allowRemoteShell: true,
				remoteShellLevel: "readWrite",
				allowRemoteFileWrite: true,
			});
			expect(migrated.deviceAccess).toEqual({
				host: "denied", // never influenced by legacy fields
				global: "readWrite",
				selfRegistered: "readWrite",
			});
		});

		test("takes the stricter of shell and file-write levels when they disagree", () => {
			const shellOnlyReadOnly = oauthClientPolicySchema.parse({
				allowRemoteShell: true,
				remoteShellLevel: "readOnly",
				allowRemoteFileWrite: true,
			});
			expect(shellOnlyReadOnly.deviceAccess.global).toBe("readOnly");

			const fileWritesDenied = oauthClientPolicySchema.parse({
				allowRemoteShell: true,
				remoteShellLevel: "readWrite",
				allowRemoteFileWrite: false,
			});
			expect(fileWritesDenied.deviceAccess.global).toBe("denied");

			const shellDenied = oauthClientPolicySchema.parse({
				allowRemoteShell: false,
				remoteShellLevel: "readWrite",
				allowRemoteFileWrite: true,
			});
			expect(shellDenied.deviceAccess.global).toBe("denied");
		});

		test("migrates real stored client policy JSON without throwing", () => {
			// Verbatim shape observed in oauth_clients.policyJson before this change.
			const stored = {
				defaultPermissionMode: "dontAsk",
				allowedPermissionModes: ["dontAsk", "readOnly"],
				systemPromptMode: "append",
				maxSystemPromptChars: 10000,
				allowGlobalDevice: true,
				allowKnowledgeWrite: true,
				allowRemoteShell: true,
				remoteShellLevel: "readWrite",
				allowRemoteFileWrite: true,
			};
			const parsed = oauthClientPolicySchema.parse(stored);
			expect(parsed.deviceAccess).toEqual({
				host: "denied",
				global: "readWrite",
				selfRegistered: "readWrite",
			});
			expect(parsed.allowGlobalDevice).toBe(true);
		});

		test("migrates real stored authority policy JSON missing the legacy fields entirely", () => {
			// Verbatim shape observed in integration_authorities.policyJson before this
			// change — the three legacy fields were never present, so parsing must fall
			// through to ordinary schema defaults, not the migration path.
			const stored = {
				defaultPermissionMode: "dontAsk",
				allowedPermissionModes: ["dontAsk", "readOnly"],
				systemPromptMode: "append",
				maxSystemPromptChars: 10000,
				allowGlobalDevice: true,
				allowKnowledgeWrite: true,
			};
			const parsed = oauthClientPolicySchema.parse(stored);
			expect(parsed.deviceAccess).toEqual({
				host: "denied",
				global: "readWrite",
				selfRegistered: "readWrite",
			});
		});

		test("migrates a real stored narrator snapshot policy denying remote shell and file writes", () => {
			// Verbatim shape observed in narrator.oauthPolicySnapshotJson.policy before this
			// change (a narrator provisioned while remote shell/file-write were disabled).
			const stored = {
				defaultPermissionMode: "dontAsk",
				allowedPermissionModes: ["dontAsk", "readOnly"],
				systemPromptMode: "append",
				maxSystemPromptChars: 10000,
				allowGlobalDevice: true,
				allowKnowledgeWrite: true,
				allowRemoteShell: false,
				remoteShellLevel: "readOnly",
				allowRemoteFileWrite: false,
			};
			const parsed = oauthClientPolicySchema.parse(stored);
			expect(parsed.deviceAccess).toEqual({
				host: "denied",
				global: "denied",
				selfRegistered: "denied",
			});
		});

		test("still rejects genuinely unknown fields alongside legacy keys", () => {
			expect(() =>
				oauthClientPolicySchema.parse({
					allowRemoteShell: true,
					remoteShellLevel: "readWrite",
					allowRemoteFileWrite: true,
					dangerouslyAllowEverything: true,
				}),
			).toThrow();
		});

		test("does not affect input that is already in the new deviceAccess shape", () => {
			const parsed = oauthClientPolicySchema.parse({
				deviceAccess: { host: "readOnly", global: "denied", selfRegistered: "readOnly" },
			});
			expect(parsed.deviceAccess).toEqual({
				host: "readOnly",
				global: "denied",
				selfRegistered: "readOnly",
			});
		});
	});
});

describe("bypassPermissions as an external permission mode", () => {
	test("stays closed by default so existing clients are unaffected", () => {
		const parsed = oauthClientPolicySchema.parse({});
		expect(parsed.defaultPermissionMode).toBe("readOnly");
		expect(parsed.allowedPermissionModes).toEqual(["readOnly"]);
	});

	test("can be opted into explicitly", () => {
		const parsed = oauthClientPolicySchema.parse({
			defaultPermissionMode: "bypassPermissions",
			allowedPermissionModes: ["bypassPermissions", "readOnly"],
		});
		expect(parsed.defaultPermissionMode).toBe("bypassPermissions");
		expect(parsed.allowedPermissionModes).toContain("bypassPermissions");
	});

	test("still requires allowedPermissionModes to include the default", () => {
		expect(() =>
			oauthClientPolicySchema.parse({
				defaultPermissionMode: "bypassPermissions",
				allowedPermissionModes: ["readOnly"],
			}),
		).toThrow();
	});

	// An intersection is a ceiling: a layer that never allowed bypass removes it, and the
	// surviving default drops to the strictest remaining mode.
	test("is dropped by an intersection unless every layer allows it", () => {
		const wide = oauthClientPolicySchema.parse({
			defaultPermissionMode: "bypassPermissions",
			allowedPermissionModes: ["bypassPermissions", "readOnly", "dontAsk"],
		});
		const narrow = oauthClientPolicySchema.parse({
			defaultPermissionMode: "readOnly",
			allowedPermissionModes: ["readOnly", "dontAsk"],
		});
		const intersected = intersectOAuthClientPolicies(wide, narrow);
		expect(intersected?.allowedPermissionModes).not.toContain("bypassPermissions");
		expect(intersected?.defaultPermissionMode).toBe("dontAsk");

		const bothAllow = intersectOAuthClientPolicies(wide, wide);
		expect(bothAllow?.allowedPermissionModes).toContain("bypassPermissions");
	});

	test("rejects internal-only permission modes", () => {
		expect(() => oauthClientPolicySchema.parse({ defaultPermissionMode: "acceptEdits" })).toThrow();
	});
});

describe("danger reflection prompt policy", () => {
	test("is closed by default", () => {
		const parsed = oauthClientPolicySchema.parse({});
		expect(parsed.allowDangerReflectionPrompt).toBe(false);
		expect(parsed.maxDangerReflectionPromptChars).toBe(0);
	});

	test("intersections require every layer to allow it and take the smallest ceiling", () => {
		const wide = oauthClientPolicySchema.parse({
			allowDangerReflectionPrompt: true,
			maxDangerReflectionPromptChars: 4_000,
		});
		const narrower = oauthClientPolicySchema.parse({
			allowDangerReflectionPrompt: true,
			maxDangerReflectionPromptChars: 500,
		});
		const denied = oauthClientPolicySchema.parse({});

		expect(intersectOAuthClientPolicies(wide, narrower)).toMatchObject({
			allowDangerReflectionPrompt: true,
			maxDangerReflectionPromptChars: 500,
		});
		expect(intersectOAuthClientPolicies(wide, denied)).toMatchObject({
			allowDangerReflectionPrompt: false,
			maxDangerReflectionPromptChars: 0,
		});
	});

	test("rejects a ceiling above the protocol limit", () => {
		expect(() =>
			oauthClientPolicySchema.parse({ maxDangerReflectionPromptChars: 4_001 }),
		).toThrow();
	});
});

describe("robot diagnostic preset policy", () => {
	test("is closed by default", () => {
		expect(oauthClientPolicySchema.parse({}).allowRobotDiagnosticPreset).toBe(false);
	});

	test("intersections require every layer to allow it", () => {
		const enabled = oauthClientPolicySchema.parse({ allowRobotDiagnosticPreset: true });
		const disabled = oauthClientPolicySchema.parse({});
		expect(intersectOAuthClientPolicies(enabled, enabled)).toMatchObject({
			allowRobotDiagnosticPreset: true,
		});
		expect(intersectOAuthClientPolicies(enabled, disabled)).toMatchObject({
			allowRobotDiagnosticPreset: false,
		});
	});
});

describe("narrator provision snapshots", () => {
	const baseSnapshot = {
		version: 3 as const,
		policy: oauthClientPolicySchema.parse({}),
		permissionMode: "readOnly" as const,
		systemPrompt: null,
		projectId: null,
		defaultDeviceId: "device-1",
		deviceIds: ["device-1"],
	};

	// Snapshots frozen before this field existed must keep parsing, so the field is
	// optional rather than gated behind a new snapshot version.
	test("parse without a dangerReflectionPrompt field", () => {
		const parsed = oauthNarratorProvisionSnapshotSchema.parse(baseSnapshot);
		expect(parsed.dangerReflectionPrompt).toBeUndefined();
	});

	test("carry a bypassPermissions mode and a reflection prompt", () => {
		const parsed = oauthNarratorProvisionSnapshotSchema.parse({
			...baseSnapshot,
			permissionMode: "bypassPermissions",
			dangerReflectionPrompt: "field diagnostics context",
		});
		expect(parsed.permissionMode).toBe("bypassPermissions");
		expect(parsed.dangerReflectionPrompt).toBe("field diagnostics context");
	});

	test("reject a reflection prompt above the protocol limit", () => {
		expect(() =>
			oauthNarratorProvisionSnapshotSchema.parse({
				...baseSnapshot,
				dangerReflectionPrompt: "x".repeat(4_001),
			}),
		).toThrow();
	});
});
