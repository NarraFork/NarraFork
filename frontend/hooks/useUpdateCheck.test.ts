import { describe, expect, test } from "bun:test";
import { extractUpdateFailureDiagnostic } from "./useUpdateCheck";

describe("extractUpdateFailureDiagnostic", () => {
	test("prefers reason, then message, error, code, and fallback", () => {
		expect(
			extractUpdateFailureDiagnostic({
				code: "DOWNLOAD_FAILED",
				reason: "Download failed from upstream",
				message: "Download failed",
				error: "generic",
			}),
		).toEqual({
			error: "Download failed from upstream",
			code: "DOWNLOAD_FAILED",
			reason: "Download failed from upstream",
			message: "Download failed",
		});

		expect(extractUpdateFailureDiagnostic({ message: "Message first" })).toEqual({
			error: "Message first",
			code: undefined,
			reason: undefined,
			message: "Message first",
		});

		expect(extractUpdateFailureDiagnostic({ error: "Error first" })).toEqual({
			error: "Error first",
			code: undefined,
			reason: undefined,
			message: undefined,
		});

		expect(extractUpdateFailureDiagnostic({ code: "CODE_ONLY" })).toEqual({
			error: "CODE_ONLY",
			code: "CODE_ONLY",
			reason: undefined,
			message: undefined,
		});

		expect(extractUpdateFailureDiagnostic({}, "Fallback message")).toEqual({
			error: "Fallback message",
			code: undefined,
			reason: undefined,
			message: undefined,
		});
	});
});
