import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import en from "../locales/en/narrator.json";
import zh from "../locales/zh-CN/narrator.json";
import type { RevertWarning } from "./api/narrators";
import { formatRevertWarning, formatRevertWarnings } from "./revert-warnings";

async function translator(language: "en" | "zh-CN") {
	const i18n = createInstance();
	await i18n.init({
		lng: language,
		fallbackLng: "en",
		resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
		defaultNS: "narrator",
		interpolation: { escapeValue: false },
	});
	return (key: string, options?: Record<string, unknown>) => String(i18n.t(key, options));
}

const uncertain: RevertWarning = {
	code: "WORKSPACE_SCOPE_EVIDENCE_UNCERTAIN",
	unknownCount: 0,
	legacyCount: 0,
	warningScanComplete: false,
	countsLowerBound: true,
	sampleFilePaths: [],
};

for (const language of ["en", "zh-CN"] as const) {
	describe(`rollback evidence warnings (${language})`, () => {
		test("a failed or incomplete assessment is not an empty warning", async () => {
			const t = await translator(language);
			const text = formatRevertWarning(t, uncertain);
			expect(text).toContain(t("revertWarnEvidenceUncertain"));
			expect(text).toContain(t("revertWarnScanIncomplete"));
			expect(text).toContain(t("revertWarnCountsLowerBound"));
			expect(text).not.toContain("revertWarnEvidenceUncertain");
		});

		test("legacy and unknown records are disclosed independently of known third-party counts", async () => {
			const t = await translator(language);
			const text = formatRevertWarning(t, {
				...uncertain,
				legacyCount: 3,
				unknownCount: 2,
				warningScanComplete: true,
			});
			expect(text).toContain(t("revertWarnLegacyEvidence", { count: 3 }));
			expect(text).toContain(t("revertWarnUnknownEvidence", { count: 2 }));
			expect(text).not.toContain(t("revertWarnScanIncomplete"));
		});

		test("known human changes and uncertainty both survive paragraph formatting", async () => {
			const t = await translator(language);
			const text = formatRevertWarnings(t, [
				{
					code: "WORKSPACE_SCOPE_DISCARDED_OTHERS",
					otherActorCount: 0,
					externalCount: 0,
					unserializedCount: 0,
					humanCount: 1,
					sampleFilePaths: [],
				},
				uncertain,
			]);
			expect(text).toContain(t("revertWarnPartHuman", { count: 1 }));
			expect(text).toContain(t("revertWarnEvidenceUncertain"));
		});

		test("samples stay bounded and no-advice remains null", async () => {
			const t = await translator(language);
			const text = formatRevertWarning(t, {
				...uncertain,
				sampleFilePaths: ["a", "b", "c", "d", "e", "do-not-render-sixth"],
			});
			expect(text).not.toContain("do-not-render-sixth");
			expect(text).toContain(t("revertWarnFilesMore", { files: "a, b, c, d, e", count: 1 }));
			expect(formatRevertWarnings(t, undefined)).toBeNull();
			expect(formatRevertWarnings(t, [])).toBeNull();
		});
	});
}
