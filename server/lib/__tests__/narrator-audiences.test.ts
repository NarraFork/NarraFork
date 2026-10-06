import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isWriteAudienceAllowed } from "@shared/narrator-access";
import { ValidationError } from "../errors";
import {
	normalizeDefaultNarratorVisibility,
	normalizeDefaultNarratorWriteAudience,
	resolveNarratorAudiences,
} from "../narrator-audiences";
import { DEFAULTS, SETTING_DOCS } from "../settings/defaults";
import {
	defaultNarratorVisibilitySchema,
	defaultNarratorWriteAudienceSchema,
} from "../validators/settings";

const defaults = ["auto", "private", "public"] as const;
const visibilities = ["private", "project", "public"] as const;
const writes = ["owner", "project", "public"] as const;
const writeDefaults = ["auto", ...writes] as const;

// Explicit expected matrix, independent of the shared clamping implementation.
const expectedWrites = {
	private: { auto: "owner", owner: "owner", project: "owner", public: "owner" },
	project: { auto: "project", owner: "owner", project: "project", public: "project" },
	public: { auto: "public", owner: "owner", project: "project", public: "public" },
} as const;

describe("narrator creation audiences without database access", () => {
	test("auto is the documented installation default", () => {
		expect(DEFAULTS.agent.defaultNarratorVisibility).toBe("auto");
		expect(SETTING_DOCS["agent.defaultNarratorVisibility"]).toBeDefined();
		expect(DEFAULTS.agent.defaultNarratorWriteAudience).toBe("auto");
		expect(SETTING_DOCS["agent.defaultNarratorWriteAudience"]).toBeDefined();
	});

	for (const chapterId of [undefined, null, "chapter"]) {
		for (const configured of defaults) {
			test(`${configured}, chapter=${chapterId}: derives a legal audience pair`, () => {
				const visibility = configured === "auto" ? (chapterId ? "project" : "private") : configured;
				const writeAudience = visibility === "private" ? "owner" : visibility;
				expect(resolveNarratorAudiences(undefined, undefined, chapterId, configured)).toEqual({
					visibility,
					writeAudience,
				});
			});
		}
	}

	test("omitted setting retains legacy behavior", () => {
		expect(resolveNarratorAudiences(undefined, undefined, null)).toEqual({
			visibility: "private",
			writeAudience: "owner",
		});
		expect(resolveNarratorAudiences(undefined, undefined, "chapter")).toEqual({
			visibility: "project",
			writeAudience: "project",
		});
	});

	test("explicit visibility overrides every global default", () => {
		for (const configured of defaults) {
			for (const visibility of visibilities) {
				for (const chapterId of [null, "chapter"]) {
					expect(resolveNarratorAudiences(visibility, undefined, chapterId, configured)).toEqual({
						visibility,
						writeAudience: visibility === "private" ? "owner" : visibility,
					});
				}
			}
		}
	});

	for (const configuredWrite of writeDefaults) {
		for (const configured of defaults) {
			for (const visibility of [...visibilities, undefined]) {
				for (const chapterId of [undefined, null, "chapter"]) {
					test(`write=${configuredWrite}, default=${configured}, visibility=${visibility}, chapter=${chapterId}`, () => {
						const effectiveVisibility =
							visibility ??
							(configured === "auto" ? (chapterId ? "project" : "private") : configured);
						expect(
							resolveNarratorAudiences(
								visibility,
								undefined,
								chapterId,
								configured,
								configuredWrite,
							),
						).toEqual({
							visibility: effectiveVisibility,
							writeAudience: expectedWrites[effectiveVisibility][configuredWrite],
						});
						for (const writeAudience of writes) {
							const resolve = () =>
								resolveNarratorAudiences(
									visibility,
									writeAudience,
									chapterId,
									configured,
									configuredWrite,
								);
							if (isWriteAudienceAllowed(effectiveVisibility, writeAudience)) {
								expect(resolve()).toEqual({ visibility: effectiveVisibility, writeAudience });
							} else {
								expect(resolve).toThrow(ValidationError);
							}
						}
					});
				}
			}
		}
	}

	test("explicit write audiences are preserved or rejected, never clamped", () => {
		for (const configured of defaults) {
			for (const visibility of [...visibilities, undefined]) {
				for (const chapterId of [null, "chapter"]) {
					const effective = resolveNarratorAudiences(visibility, undefined, chapterId, configured);
					for (const writeAudience of writes) {
						const resolve = () =>
							resolveNarratorAudiences(visibility, writeAudience, chapterId, configured);
						if (isWriteAudienceAllowed(effective.visibility, writeAudience)) {
							expect(resolve()).toEqual({ visibility: effective.visibility, writeAudience });
						} else {
							expect(resolve).toThrow(ValidationError);
						}
					}
				}
			}
		}
	});
});

describe("default visibility settings validation", () => {
	test("accepts only auto/private/public", () => {
		for (const value of defaults) {
			expect(defaultNarratorVisibilitySchema.parse(value)).toBe(value);
			expect(normalizeDefaultNarratorVisibility(value)).toBe(value);
		}
		for (const value of ["project", "", "PUBLIC", true, 1, null, undefined, {}]) {
			expect(defaultNarratorVisibilitySchema.safeParse(value).success).toBe(false);
			expect(normalizeDefaultNarratorVisibility(value)).toBe("auto");
		}
	});

	test("write defaults accept only auto/owner/project/public and normalize invalid stored values", () => {
		for (const value of writeDefaults) {
			expect(defaultNarratorWriteAudienceSchema.parse(value)).toBe(value);
			expect(normalizeDefaultNarratorWriteAudience(value)).toBe(value);
		}
		for (const value of ["private", "", "PUBLIC", true, 1, null, undefined, {}, []]) {
			expect(defaultNarratorWriteAudienceSchema.safeParse(value).success).toBe(false);
			expect(normalizeDefaultNarratorWriteAudience(value)).toBe("auto");
			for (const visibility of visibilities) {
				expect(
					resolveNarratorAudiences(
						visibility,
						undefined,
						null,
						"auto",
						value as Parameters<typeof resolveNarratorAudiences>[4],
					),
				).toEqual({ visibility, writeAudience: expectedWrites[visibility].auto });
			}
		}
	});

	test("the API schema and creation entry point wire the tested primitives", () => {
		// Avoid importing the routes/service and booting SQLite, providers and background jobs.
		const routes = readFileSync(new URL("../../routes/settings.ts", import.meta.url), "utf8");
		expect(routes).toContain("defaultNarratorVisibility: defaultNarratorVisibilitySchema");
		expect(routes).toContain("defaultNarratorWriteAudience: defaultNarratorWriteAudienceSchema");
		const service = readFileSync(
			new URL("../../services/narrator-service.ts", import.meta.url),
			"utf8",
		);
		expect(service).toMatch(
			/resolveNarratorAudiences\(\s*input.visibility,\s*input.writeAudience,\s*chapterId,\s*settings.agent.defaultNarratorVisibility,\s*settings.agent.defaultNarratorWriteAudience,/,
		);
		const loader = readFileSync(new URL("../settings/index.ts", import.meta.url), "utf8");
		expect(loader).toMatch(
			/normalizeDefaultNarratorVisibility\(\s*merged.agent.defaultNarratorVisibility/,
		);
		expect(loader).toMatch(
			/normalizeDefaultNarratorWriteAudience\(\s*merged.agent.defaultNarratorWriteAudience/,
		);
		expect(loader).toContain("merged.agent.defaultNarratorWriteAudience = defaultWriteAudience");
	});
});
