import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { getTestDb } from "../../../tests/setup";
import { localBackend } from "../../lib/agent/execution/registry";
import type { ToolContext } from "../../lib/agent/types";
import { readWorkspaceText } from "../../lib/plan-file-path";

const realDb = { ...(await import("../../db")) };
const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const realOAuth = { ...(await import("../oauth-narrator-runtime-policy")) };
type Runtime = NonNullable<Awaited<ReturnType<typeof realOAuth.resolveOAuthNarratorRuntimePolicy>>>;
let runtime: Runtime | null = null;
const actors: Array<string | null | undefined> = [];
mock.module("../oauth-narrator-runtime-policy", () => ({
	...realOAuth,
	resolveOAuthNarratorRuntimePolicy: async (_id: string, actor?: string | null) => {
		actors.push(actor);
		return runtime;
	},
}));
const { executionPolicyEngine } = await import("../execution-policy/engine");
const { createConfiguredGlobalSkillAccess, createGlobalSkill, deleteGlobalSkill } = await import(
	"../skill-service"
);
const source = await createGlobalSkill(
	"source-authority-fixture",
	"Published source scope",
	"Published instructions only.",
);
const skill = { ...source, source: "global" as const };
let revoked = false;
let denyRead = false;
let readSpy: ReturnType<typeof spyOn<typeof localBackend, "readFileBytes">>;

function context(): ToolContext {
	return {
		narratorId: "source-narrator",
		cwd: "/not-the-source",
		userId: "real-trigger",
		locale: "en",
		signal: new AbortController().signal,
		recheckAuthorization: async () => {
			if (revoked) throw new Error("source actor revoked");
		},
		requestPermission: async () => ({ behavior: "allow" }),
	};
}
function oauth(host: "none" | "readOnly" | "readWrite", local = true): Runtime {
	return {
		allowedTools: new Set(["Read", "Write", "Skill"]),
		allowLocalExecution: local,
		policy: { deviceAccess: { host } },
	} as unknown as Runtime;
}

beforeEach(() => {
	runtime = null;
	revoked = false;
	denyRead = false;
	actors.length = 0;
	readSpy = spyOn(localBackend, "readFileBytes");
	spyOn(executionPolicyEngine, "compile").mockImplementation(
		async () => ({ evaluatePath: () => ({ decision: denyRead ? "deny" : "allow" }) }) as never,
	);
});
afterEach(() => mock.restore());
afterAll(async () => {
	await deleteGlobalSkill(skill.name);
	mock.module("../../db", () => realDb);
	mock.module("../oauth-narrator-runtime-policy", () => realOAuth);
	mock.restore();
});

describe("configured global skill source authority", () => {
	test("host-denied OAuth cannot materialize through a published-global source exception", async () => {
		runtime = oauth("none", false);
		await expect(createConfiguredGlobalSkillAccess(skill, context())).rejects.toThrow(
			"OAuth host read authority",
		);
		expect(readSpy).not.toHaveBeenCalled();
		expect(actors).toEqual(["real-trigger"]);
	});

	test("host permission tightening is checked again on every source file read", async () => {
		runtime = oauth("readOnly");
		const access = await createConfiguredGlobalSkillAccess(skill, context());
		runtime = oauth("none", false);
		await expect(readWorkspaceText(access, skill.location, 256_000)).rejects.toThrow(
			"OAuth host read authority",
		);
		expect(readSpy).not.toHaveBeenCalled();
		expect(actors.every((actor) => actor === "real-trigger")).toBe(true);
	});

	test("actor revocation prevents bytes even after the source scope was prepared", async () => {
		const access = await createConfiguredGlobalSkillAccess(skill, context());
		revoked = true;
		await expect(readWorkspaceText(access, skill.location, 256_000)).rejects.toThrow(
			"source actor revoked",
		);
		expect(readSpy).not.toHaveBeenCalled();
	});

	test("source read deny and scope escape are not widened by the global configuration label", async () => {
		const access = await createConfiguredGlobalSkillAccess(skill, context());
		denyRead = true;
		await expect(readWorkspaceText(access, skill.location, 256_000)).rejects.toThrow("read denied");
		denyRead = false;
		await expect(
			readWorkspaceText(
				access,
				localBackend.paths.resolve(
					localBackend.paths.dirname(skill.location),
					"../other/private.txt",
				),
				256_000,
			),
		).rejects.toThrow("read denied");
		expect(readSpy).not.toHaveBeenCalled();
	});
});
