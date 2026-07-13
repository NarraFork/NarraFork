import { describe, expect, it } from "bun:test";
import {
	batchMergeSchema,
	createProjectSchema,
	createReviewSchema,
	createScheduledTaskSchema,
	forkChapterSchema,
	mergeChapterSchema,
	registerSchema,
	updateUserPreferencesSchema,
} from "../../../server/lib/validators";
import { SUPPORTED_LOCALES } from "../../../shared/i18n-locales";

describe("createProjectSchema", () => {
	it("accepts valid input", () => {
		const result = createProjectSchema.safeParse({
			name: "My Project",
			repoMode: "existing",
			gitPath: "/tmp/my-project",
		});
		expect(result.success).toBe(true);
	});

	it("rejects empty name", () => {
		const result = createProjectSchema.safeParse({
			name: "",
			repoMode: "existing",
			gitPath: "/tmp/my-project",
		});
		expect(result.success).toBe(false);
	});

	it("rejects name over 200 chars", () => {
		const result = createProjectSchema.safeParse({
			name: "x".repeat(201),
			repoMode: "existing",
			gitPath: "/tmp/my-project",
		});
		expect(result.success).toBe(false);
	});
});

describe("registerSchema", () => {
	it("accepts valid credentials", () => {
		const result = registerSchema.safeParse({ username: "alice", password: "12345678" });
		expect(result.success).toBe(true);
	});

	it("rejects short username", () => {
		const result = registerSchema.safeParse({ username: "ab", password: "12345678" });
		expect(result.success).toBe(false);
	});

	it("rejects short password", () => {
		const result = registerSchema.safeParse({ username: "alice", password: "1234567" });
		expect(result.success).toBe(false);
	});

	it("rejects special chars in username", () => {
		const result = registerSchema.safeParse({ username: "al ice!", password: "12345678" });
		expect(result.success).toBe(false);
	});
});

describe("forkChapterSchema", () => {
	it("accepts valid fork input", () => {
		const result = forkChapterSchema.safeParse({
			title: "Experiment",
			inheritMode: "compressed",
		});
		expect(result.success).toBe(true);
	});

	it("rejects invalid inherit mode", () => {
		const result = forkChapterSchema.safeParse({
			title: "Test",
			inheritMode: "invalid",
		});
		expect(result.success).toBe(false);
	});
});

describe("mergeChapterSchema", () => {
	it("accepts valid merge input", () => {
		const result = mergeChapterSchema.safeParse({
			targetChapterId: "abc",
			strategy: "squash",
		});
		expect(result.success).toBe(true);
	});

	it("rejects invalid strategy", () => {
		const result = mergeChapterSchema.safeParse({
			targetChapterId: "abc",
			strategy: "rebase",
		});
		expect(result.success).toBe(false);
	});
});

describe("batchMergeSchema", () => {
	it("requires at least one source chapter", () => {
		const result = batchMergeSchema.safeParse({
			baseChapterId: "a",
			sourceChapterIds: [],
			title: "Merge",
		});
		expect(result.success).toBe(false);
	});
});

describe("shared locale validation", () => {
	it("accepts every locale from the shared registry", () => {
		for (const locale of SUPPORTED_LOCALES) {
			expect(updateUserPreferencesSchema.safeParse({ language: locale }).success).toBe(true);
			expect(createReviewSchema.safeParse({ locale }).success).toBe(true);
			expect(
				createScheduledTaskSchema.safeParse({
					name: "Hourly task",
					cronExpr: "0 * * * *",
					prompt: "Run checks",
					locale,
				}).success,
			).toBe(true);
		}
	});

	it("rejects locales outside the shared registry", () => {
		expect(updateUserPreferencesSchema.safeParse({ language: "unsupported" }).success).toBe(false);
		expect(createReviewSchema.safeParse({ locale: "unsupported" }).success).toBe(false);
	});
});
