import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { SkillContext, SkillInfo } from "../skill-service";

const realSkills = { ...(await import("../skill-service")) };
const calls: Array<{
	narratorId: string;
	options?: { userId?: string | null; signal?: AbortSignal };
}> = [];
const remote: SkillInfo = {
	name: "remote-skill",
	description: "Remote instructions",
	content: "remote body",
	location: "D:\\chosen\\repo\\.agents\\skills\\remote-skill\\SKILL.md",
	files: ["references\\guide.md"],
	source: "workspace",
	deviceId: "remote-machine",
	pathFlavor: "windows",
	workspaceContextKey: "remote-context",
};
let selected = remote;
mock.module("../skill-service", () => ({
	...realSkills,
	resolveSkillContextForNarrator: async (
		narratorId: string,
		options?: { userId?: string | null; signal?: AbortSignal },
	): Promise<SkillContext> => {
		calls.push({ narratorId, options });
		return { cwd: "D:\\chosen\\repo", deviceId: "remote-machine" };
	},
	loadSkillSummariesForContext: async () => ({
		skills: [
			{
				...selected,
				source: selected.source ?? "workspace",
				rootKind: selected.source ?? "workspace",
				normalizedRootPath: "D:\\chosen\\repo",
			},
		],
		roots: [],
		scopeKey: "test",
	}),
	loadSkillByNameForContext: async () => selected,
}));
const { narratorService, handleLoadSkillCommand } = await import("../narrator-service");
spyOn(narratorService, "getById").mockResolvedValue({
	id: "n",
	ownerUserId: "privileged-owner",
	traits: [],
	chapterId: null,
	contextProjectId: null,
} as never);
spyOn(narratorService, "persistDisplayMessage").mockResolvedValue({} as never);
afterAll(() => {
	mock.module("../skill-service", () => realSkills);
	mock.restore();
});

describe("manual skill command workspace resources", () => {
	test("threads the real actor/signal and uses remote Windows resource paths", async () => {
		calls.length = 0;
		selected = remote;
		const signal = new AbortController().signal;
		const result = await handleLoadSkillCommand(
			"n",
			{
				resolved: true,
				loadSkill: "remote-skill",
				skillInput: "",
				rawCommand: "/skill remote-skill",
			},
			{ userId: "real-trigger", signal },
		);
		expect(calls[0]).toEqual({ narratorId: "n", options: { userId: "real-trigger", signal } });
		if (!result.found) throw new Error("Expected remote skill");
		expect(result.content).toContain(
			"Base directory for this skill: D:\\chosen\\repo\\.agents\\skills\\remote-skill",
		);
		expect(result.content).toContain("Resource device: remote-machine");
		expect(result.content).toContain(
			'<file device="remote-machine">D:\\chosen\\repo\\.agents\\skills\\remote-skill\\references\\guide.md</file>',
		);
		expect(result.content).not.toContain("privileged-owner");
	});

	test("a legacy missing actor never borrows the narrator owner's identity", async () => {
		calls.length = 0;
		await handleLoadSkillCommand("n", {
			resolved: true,
			loadSkill: "remote-skill",
			skillInput: "",
			rawCommand: "/skill remote-skill",
		});
		expect(calls[0]?.options?.userId).toBeNull();
	});

	test("server global resources remain explicitly local even when the narrator resides remotely", async () => {
		selected = {
			...remote,
			source: "global",
			location: "/configured/global-skill/SKILL.md",
			files: ["scripts/run.sh"],
			deviceId: undefined,
			pathFlavor: "posix",
		};
		const result = await handleLoadSkillCommand(
			"n",
			{
				resolved: true,
				loadSkill: "remote-skill",
				skillInput: "",
				rawCommand: "/skill remote-skill",
			},
			{ userId: "real-trigger" },
		);
		if (!result.found) throw new Error("Expected global skill");
		expect(result.content).toContain(
			"Resource device: local (NarraFork server global configuration)",
		);
		expect(result.content).toContain(
			'<file device="local">/configured/global-skill/scripts/run.sh</file>',
		);
		expect(result.content).toContain("No files were copied or executed");
	});
});
