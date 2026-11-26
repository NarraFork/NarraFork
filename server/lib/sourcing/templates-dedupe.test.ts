import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getCodexCredentialDedupeKeys } from "../codex-credential-dedupe";
import type { Credential, CredentialAuth } from "../credential-store";
import { getServiceTemplate, listServiceTemplates } from "./templates";

function credential(
	auth: CredentialAuth,
	target: Credential["target"] = { groupId: "test-group" },
): Omit<Credential, "id"> {
	return { auth, target, ownerUserId: null, priority: 0, createdAt: 1 };
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("template credential dedupe keys", () => {
	test("every registered template has a dedupe method and rejects unsupported auth", () => {
		const auths: CredentialAuth[] = [
			{ kind: "api_key", apiKey: "api-secret" },
			{ kind: "oauth", refreshToken: "refresh-secret" },
			{ kind: "pat", accessToken: "access-secret" },
			{ kind: "agent_identity", agentRuntimeId: "runtime", agentPrivateKey: "private-key" },
			{ kind: "opaque", fields: { secret: "plugin-secret" } },
		];
		for (const template of listServiceTemplates()) {
			expect(typeof template.dedupeKeys).toBe("function");
			for (const auth of auths) {
				if (!template.authKinds.includes(auth.kind)) {
					expect(template.dedupeKeys(credential(auth))).toEqual([]);
				}
			}
		}
	});

	test("Codex delegates OAuth, PAT and agent identities to the pure helper", () => {
		const codex = getServiceTemplate("codex");
		const account = { accountId: "account", email: "email@example.com", sub: "subject" };
		const auths: CredentialAuth[] = [
			{ kind: "oauth", refreshToken: " refresh ", accessToken: " access " },
			{ kind: "pat", accessToken: " at-secret " },
			{ kind: "agent_identity", agentRuntimeId: " runtime ", agentPrivateKey: "private-key" },
		];
		for (const auth of auths) {
			const input = { ...credential(auth, { groupId: "codex" }), account };
			expect(codex.dedupeKeys(input)).toEqual(
				getCodexCredentialDedupeKeys({ ...account, ...auth }),
			);
			expect(JSON.stringify(codex.dedupeKeys(input))).not.toContain("private-key");
		}
		expect(codex.dedupeKeys(credential({ kind: "oauth" }))).toEqual([]);
	});

	test("API key fingerprints include the target group and trimmed key", () => {
		for (const template of listServiceTemplates().filter((t) => t.authKinds.includes("api_key"))) {
			const first = credential({ kind: "api_key", apiKey: "  sk-private-secret\n" });
			const keys = template.dedupeKeys(first);
			expect(keys).toEqual([`api_key:${hash(["test-group", "sk-private-secret"])}`]);
			expect(
				template.dedupeKeys({
					...first,
					label: "another label",
					priority: 5,
					auth: { kind: "api_key", apiKey: "sk-private-secret" },
				}),
			).toEqual(keys);
			expect(template.dedupeKeys({ ...first, target: { groupId: "other-group" } })).not.toEqual(
				keys,
			);
			expect(
				template.dedupeKeys({ ...first, auth: { kind: "api_key", apiKey: "other-secret" } }),
			).not.toEqual(keys);
			expect(keys[0]).not.toContain("sk-private-secret");
			expect(template.dedupeKeys(credential({ kind: "api_key", apiKey: " \t" }))).toEqual([]);
			expect(
				template.dedupeKeys({ ...first, target: { pluginContributionId: "plugin/provider" } }),
			).toEqual([]);
		}
	});

	test("opaque fingerprints sort field names and include the stable plugin target", () => {
		const template = getServiceTemplate("plugin");
		const target = { pluginContributionId: "plugin/provider" };
		const first = credential(
			{ kind: "opaque", fields: { token: "private-token", account: "private-account" } },
			target,
		);
		const keys = template.dedupeKeys(first);
		expect(keys).toEqual([
			`opaque:${hash([
				"plugin/provider",
				[
					["account", "private-account"],
					["token", "private-token"],
				],
			])}`,
		]);
		expect(
			template.dedupeKeys(
				credential(
					{ kind: "opaque", fields: { account: "private-account", token: "private-token" } },
					target,
				),
			),
		).toEqual(keys);
		expect(
			template.dedupeKeys({ ...first, target: { pluginContributionId: "plugin/other-provider" } }),
		).not.toEqual(keys);
		expect(
			template.dedupeKeys(
				credential(
					{ kind: "opaque", fields: { token: "changed-token", account: "private-account" } },
					target,
				),
			),
		).not.toEqual(keys);
		for (const secret of ["private-token", "private-account", "plugin/provider"]) {
			expect(keys[0]).not.toContain(secret);
		}
		expect(
			template.dedupeKeys({ ...first, target: { groupId: "ephemeral-plugin-instance" } }),
		).toEqual([]);
	});

	test("opaque serialization cannot confuse field delimiters or value whitespace", () => {
		const template = getServiceTemplate("plugin");
		const target = { pluginContributionId: "plugin/provider" };
		const keys = (fields: Record<string, string>) =>
			template.dedupeKeys(credential({ kind: "opaque", fields }, target));
		expect(keys({ a: "b:c" })).not.toEqual(keys({ "a:b": "c" }));
		expect(keys({ a: " secret " })).not.toEqual(keys({ a: "secret" }));
		expect(keys({})).not.toEqual(keys({ a: "" }));
	});
});
