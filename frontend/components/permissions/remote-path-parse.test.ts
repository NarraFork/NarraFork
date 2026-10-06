import { describe, expect, test } from "bun:test";
import { parseRemotePath } from "./RemotePathInput";

describe("parseRemotePath", () => {
	test("returns nothing to browse for empty input", () => {
		expect(parseRemotePath("")).toEqual({ dir: "", filter: "" });
		expect(parseRemotePath("   ")).toEqual({ dir: "", filter: "" });
	});

	test("treats a trailing separator as a complete directory", () => {
		expect(parseRemotePath("/work/src/")).toEqual({ dir: "/work/src", filter: "" });
	});

	test("keeps the POSIX root listable", () => {
		expect(parseRemotePath("/")).toEqual({ dir: "/", filter: "" });
	});

	test("splits a partial segment into parent plus filter", () => {
		expect(parseRemotePath("/work/sr")).toEqual({ dir: "/work", filter: "sr" });
	});

	test("lists the root when filtering a top-level name", () => {
		expect(parseRemotePath("/wo")).toEqual({ dir: "/", filter: "wo" });
	});

	test("expands a bare Windows drive letter to its root", () => {
		expect(parseRemotePath("C:")).toEqual({ dir: "C:\\", filter: "" });
	});

	test("splits Windows paths on backslashes", () => {
		expect(parseRemotePath("C:\\Users\\adm")).toEqual({ dir: "C:\\Users", filter: "adm" });
		expect(parseRemotePath("C:\\Users\\")).toEqual({ dir: "C:\\Users", filter: "" });
	});

	test("has no directory to browse for a bare relative name", () => {
		// Permission rules require absolute paths, so a bare word can only be a
		// filter with no parent to list yet.
		expect(parseRemotePath("work")).toEqual({ dir: "", filter: "work" });
	});
});
