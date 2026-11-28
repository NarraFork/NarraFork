import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { api } from "../lib/api";

const reactQuery = { ...(await import("@tanstack/react-query")) };
const invalidations: unknown[] = [];
mock.module("@tanstack/react-query", () => ({
	...reactQuery,
	useMutation: (options: unknown) => options,
	useQueryClient: () => ({
		invalidateQueries: (options: unknown) => invalidations.push(options),
	}),
}));
const {
	useImportGlobalSkill,
	useImportProjectSkill,
	useUpdateGlobalSkillFromUrl,
	useUpdateProjectSkillFromUrl,
} = await import("./useSkills");

type ImportInput = { url: string; signal?: AbortSignal };
type UpdateInput = ImportInput & { name: string };
type Skill = Awaited<ReturnType<typeof api.importGlobalSkill>>;
type MutationOptions<TInput> = {
	mutationFn: (input: TInput) => Promise<Skill>;
	onSuccess: (data: Skill, input: TInput) => void;
	meta: { suppressErrorToast?: boolean };
	retry: boolean;
};
function projectImport(projectId: string) {
	// biome-ignore lint/correctness/useHookAtTopLevel: React Query exposes the hook's actual callbacks in this test.
	return useImportProjectSkill(projectId) as unknown as MutationOptions<ImportInput>;
}
function globalImport() {
	// biome-ignore lint/correctness/useHookAtTopLevel: React Query exposes the hook's actual callbacks in this test.
	return useImportGlobalSkill() as unknown as MutationOptions<ImportInput>;
}
function projectUpdate(projectId: string) {
	// biome-ignore lint/correctness/useHookAtTopLevel: React Query exposes the hook's actual callbacks in this test.
	return useUpdateProjectSkillFromUrl(projectId) as unknown as MutationOptions<UpdateInput>;
}
function globalUpdate() {
	// biome-ignore lint/correctness/useHookAtTopLevel: React Query exposes the hook's actual callbacks in this test.
	return useUpdateGlobalSkillFromUrl() as unknown as MutationOptions<UpdateInput>;
}
const skill: Skill = {
	name: "example",
	description: "Example skill",
	content: "# Example",
	location: ".narrafork/skills/example",
	files: ["SKILL.md", "scripts/run.ts"],
	disabled: true,
};
const url = "https://gitee.com/owner/repo/raw/main/SKILL.md";
beforeEach(() => {
	invalidations.length = 0;
});
afterEach(() => mock.restore());
afterAll(() => {
	mock.module("@tanstack/react-query", () => reactQuery);
	mock.restore();
});

describe("skill creation from links", () => {
	test("project import forwards URL and signal and invalidates that project's exact list/detail", async () => {
		const call = spyOn(api, "importProjectSkill").mockResolvedValue(skill);
		const mutation = projectImport("project-a");
		const input = { url, signal: new AbortController().signal };
		const result = await mutation.mutationFn(input);
		expect(call).toHaveBeenCalledWith("project-a", { url }, input.signal);
		expect(invalidations).toEqual([]);
		mutation.onSuccess(result, input);
		expect(invalidations).toEqual([
			{ queryKey: ["skills", "project-a"], exact: true },
			{ queryKey: ["skill", "project-a", skill.name], exact: true },
		]);
		expect(mutation.meta).toEqual({ suppressErrorToast: true });
		expect(mutation.retry).toBe(false);
	});

	test("global import invalidates exactly the global list and returned skill detail", async () => {
		const call = spyOn(api, "importGlobalSkill").mockResolvedValue(skill);
		const mutation = globalImport();
		const input = { url, signal: new AbortController().signal };
		const result = await mutation.mutationFn(input);
		expect(call).toHaveBeenCalledWith({ url }, input.signal);
		mutation.onSuccess(result, input);
		expect(invalidations).toEqual([
			{ queryKey: ["global-skills"], exact: true },
			{ queryKey: ["global-skill", skill.name], exact: true },
		]);
		expect(mutation.meta).toEqual({ suppressErrorToast: true });
		expect(mutation.retry).toBe(false);
	});

	test("rejected imports propagate the original error without invalidating", async () => {
		const error = new Error("A skill with that name already exists");
		spyOn(api, "importGlobalSkill").mockRejectedValue(error);
		spyOn(api, "importProjectSkill").mockRejectedValue(error);
		for (const mutation of [projectImport("project-a"), globalImport()]) {
			await expect(mutation.mutationFn({ url })).rejects.toBe(error);
		}
		expect(invalidations).toEqual([]);
	});

	test("late success after cancellation cannot refresh another scope", () => {
		const controller = new AbortController();
		const input = { url, signal: controller.signal };
		controller.abort();
		projectImport("project-a").onSuccess(skill, input);
		globalImport().onSuccess(skill, input);
		expect(invalidations).toEqual([]);
		projectImport("project-b").onSuccess(skill, { url });
		expect(invalidations).toEqual([
			{ queryKey: ["skills", "project-b"], exact: true },
			{ queryKey: ["skill", "project-b", skill.name], exact: true },
		]);
	});
});

describe("skill updates from links", () => {
	test("project update forwards only URL and signal and invalidates its exact list/detail", async () => {
		const call = spyOn(api, "updateProjectSkillFromUrl").mockResolvedValue(skill);
		const mutation = projectUpdate("project-a");
		const input: UpdateInput = { name: "example", url, signal: new AbortController().signal };
		const result = await mutation.mutationFn(input);
		expect(result).toBe(skill);
		expect(call).toHaveBeenCalledWith("project-a", "example", { url }, input.signal);
		expect(invalidations).toEqual([]);
		mutation.onSuccess(result, input);
		expect(invalidations).toEqual([
			{ queryKey: ["skills", "project-a"], exact: true },
			{ queryKey: ["skill", "project-a", "example"], exact: true },
		]);
		expect(mutation.meta).toEqual({ suppressErrorToast: true });
		expect(mutation.retry).toBe(false);
	});

	test("global update returns the skill directly and precisely refreshes list and selected detail", async () => {
		const call = spyOn(api, "updateGlobalSkillFromUrl").mockResolvedValue(skill);
		const mutation = globalUpdate();
		const input: UpdateInput = { name: "example", url };
		const result = await mutation.mutationFn(input);
		expect(result).toBe(skill);
		expect(call).toHaveBeenCalledWith("example", { url }, undefined);
		mutation.onSuccess(result, input);
		expect(invalidations).toEqual([
			{ queryKey: ["global-skills"], exact: true },
			{ queryKey: ["global-skill", "example"], exact: true },
		]);
		expect(mutation.meta).toEqual({ suppressErrorToast: true });
		expect(mutation.retry).toBe(false);
	});

	test("rejected updates propagate the error and never invalidate", async () => {
		const error = new Error("Skill URL is unavailable");
		spyOn(api, "updateGlobalSkillFromUrl").mockRejectedValue(error);
		spyOn(api, "updateProjectSkillFromUrl").mockRejectedValue(error);
		for (const mutation of [projectUpdate("project-a"), globalUpdate()]) {
			await expect(mutation.mutationFn({ name: "example", url })).rejects.toBe(error);
		}
		expect(invalidations).toEqual([]);
	});

	test("a cancelled project cannot invalidate a replacement project or another skill", () => {
		const controller = new AbortController();
		controller.abort();
		projectUpdate("old-project").onSuccess(skill, {
			name: "old-skill",
			url,
			signal: controller.signal,
		});
		projectUpdate("new-project").onSuccess(skill, { name: "new-skill", url });
		expect(invalidations).toEqual([
			{ queryKey: ["skills", "new-project"], exact: true },
			{ queryKey: ["skill", "new-project", "new-skill"], exact: true },
		]);
	});
});

describe("link request cancellation", () => {
	test("already cancelled requests never start transport or invalidate", async () => {
		const calls = [
			spyOn(api, "importGlobalSkill").mockResolvedValue(skill),
			spyOn(api, "importProjectSkill").mockResolvedValue(skill),
			spyOn(api, "updateGlobalSkillFromUrl").mockResolvedValue(skill),
			spyOn(api, "updateProjectSkillFromUrl").mockResolvedValue(skill),
		];
		const controller = new AbortController();
		controller.abort();
		const input = { name: "example", url, signal: controller.signal };
		for (const mutation of [
			projectImport("p"),
			globalImport(),
			projectUpdate("p"),
			globalUpdate(),
		]) {
			await expect(mutation.mutationFn(input)).rejects.toMatchObject({ name: "AbortError" });
			mutation.onSuccess(skill, input);
		}
		for (const call of calls) expect(call).not.toHaveBeenCalled();
		expect(invalidations).toEqual([]);
	});

	test.each([
		"importProjectSkill",
		"importGlobalSkill",
		"updateProjectSkillFromUrl",
		"updateGlobalSkillFromUrl",
	] as const)("late %s response after cancellation remains an error", async (method) => {
		let resolveRequest: (result: Skill) => void = () => {};
		const pending = new Promise<Skill>((resolve) => {
			resolveRequest = resolve;
		});
		spyOn(api, method).mockReturnValue(pending);
		const mutations = {
			importProjectSkill: projectImport("p"),
			importGlobalSkill: globalImport(),
			updateProjectSkillFromUrl: projectUpdate("p"),
			updateGlobalSkillFromUrl: globalUpdate(),
		};
		const mutation = mutations[method];
		const controller = new AbortController();
		const input = { name: "example", url, signal: controller.signal };
		const request = mutation.mutationFn(input);
		controller.abort();
		resolveRequest(skill);
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		mutation.onSuccess(skill, input);
		expect(invalidations).toEqual([]);
	});
});
