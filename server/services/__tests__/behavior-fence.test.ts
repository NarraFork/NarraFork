import { describe, expect, test } from "bun:test";
import { createNarratorSchema } from "../../lib/validators/narrators";

describe("behaviorFenceInterval validation", () => {
	test("allows null or undefined or -1 or >= 5", () => {
		expect(createNarratorSchema.safeParse({ behaviorFenceIntervalOverride: null }).success).toBe(
			true,
		);
		expect(
			createNarratorSchema.safeParse({ behaviorFenceIntervalOverride: undefined }).success,
		).toBe(true);
		expect(createNarratorSchema.safeParse({ behaviorFenceIntervalOverride: -1 }).success).toBe(
			true,
		);
		expect(createNarratorSchema.safeParse({ behaviorFenceIntervalOverride: 5 }).success).toBe(true);
		expect(createNarratorSchema.safeParse({ behaviorFenceIntervalOverride: 10 }).success).toBe(
			true,
		);
	});

	test("rejects range 0 to 4", () => {
		expect(createNarratorSchema.safeParse({ behaviorFenceIntervalOverride: 0 }).success).toBe(
			false,
		);
		expect(createNarratorSchema.safeParse({ behaviorFenceIntervalOverride: 1 }).success).toBe(
			false,
		);
		expect(createNarratorSchema.safeParse({ behaviorFenceIntervalOverride: 2 }).success).toBe(
			false,
		);
		expect(createNarratorSchema.safeParse({ behaviorFenceIntervalOverride: 3 }).success).toBe(
			false,
		);
		expect(createNarratorSchema.safeParse({ behaviorFenceIntervalOverride: 4 }).success).toBe(
			false,
		);
	});
});

describe("tasksReminderInterval validation", () => {
	test("allows null or undefined or -1 or >= 5", () => {
		expect(createNarratorSchema.safeParse({ tasksReminderIntervalOverride: null }).success).toBe(
			true,
		);
		expect(
			createNarratorSchema.safeParse({ tasksReminderIntervalOverride: undefined }).success,
		).toBe(true);
		expect(createNarratorSchema.safeParse({ tasksReminderIntervalOverride: -1 }).success).toBe(
			true,
		);
		expect(createNarratorSchema.safeParse({ tasksReminderIntervalOverride: 5 }).success).toBe(true);
		expect(createNarratorSchema.safeParse({ tasksReminderIntervalOverride: 10 }).success).toBe(
			true,
		);
	});

	test("rejects range 0 to 4", () => {
		expect(createNarratorSchema.safeParse({ tasksReminderIntervalOverride: 0 }).success).toBe(
			false,
		);
		expect(createNarratorSchema.safeParse({ tasksReminderIntervalOverride: 1 }).success).toBe(
			false,
		);
		expect(createNarratorSchema.safeParse({ tasksReminderIntervalOverride: 2 }).success).toBe(
			false,
		);
		expect(createNarratorSchema.safeParse({ tasksReminderIntervalOverride: 3 }).success).toBe(
			false,
		);
		expect(createNarratorSchema.safeParse({ tasksReminderIntervalOverride: 4 }).success).toBe(
			false,
		);
	});
});
