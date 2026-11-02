import { describe, expect, mock, test } from "bun:test";
import type { NarratorWarningInfo } from "../../hooks/useNarratorWS";
import en from "../../locales/en/narrator.json";
import zh from "../../locales/zh-CN/narrator.json";
import { createNarratorWarningHandler, nativeMediaFallbackNotice } from "./narrator-warning";

function createHarness(locale: Record<string, unknown> = en) {
	const localizeWarning = mock((info: NarratorWarningInfo) => `localized: ${info.message}`);
	const setRetryInfo = mock((_info: unknown) => {});
	const notify = mock((_notice: unknown) => {});
	const t = (key: string) => {
		const value = locale[key];
		return typeof value === "string" ? value : key;
	};
	return {
		handle: createNarratorWarningHandler({ t, localizeWarning, setRetryInfo, notify }),
		localizeWarning,
		setRetryInfo,
		notify,
		t,
	};
}

describe("narrator warning callback", () => {
	for (const [language, locale, title] of [
		["en", en, "Attachments downgraded to regular files"],
		["zh-CN", zh, "附件已降级为一般文件"],
	] as const) {
		test(`${language}: fallback preserves the server reason and filenames without retrying`, () => {
			const harness = createHarness(locale);
			const message = "clip.mp4、voice.mp3：当前模型不支持读取该模态数据，回退到一般文件";
			harness.handle({ warningCode: "native_media_fallback", message });
			expect(harness.notify).toHaveBeenCalledTimes(1);
			expect(harness.notify).toHaveBeenCalledWith({
				title,
				message: `${message}\n${locale.nativeMediaFallbackDetails}`,
				color: "yellow",
				autoClose: 10000,
			});
			expect(harness.localizeWarning).not.toHaveBeenCalled();
			expect(harness.setRetryInfo).not.toHaveBeenCalled();
		});
	}

	test("fallback remains non-retrying even if a frame carries retry metadata", () => {
		const harness = createHarness();
		harness.handle({
			warningCode: "native_media_fallback",
			message: "voice.mp3 is now a regular file",
			retryCount: 1,
			maxRetries: 3,
			delayMs: 2000,
			diagnostics: { kind: "provider_error" },
		});
		expect(harness.setRetryInfo).not.toHaveBeenCalled();
		expect(harness.localizeWarning).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			expect.objectContaining({ title: en.nativeMediaFallbackTitle, color: "yellow" }),
		);
	});

	test("ordinary retry warnings retain localization, countdown and yellow retry notice", () => {
		const harness = createHarness();
		const info = {
			message: "provider busy",
			retryCount: 2,
			maxRetries: 4,
			delayMs: 1500,
			diagnostics: { kind: "provider_error" },
		};
		const before = Date.now();
		harness.handle(info);
		const after = Date.now();
		expect(harness.localizeWarning).toHaveBeenCalledWith(info);
		expect(harness.setRetryInfo).toHaveBeenCalledTimes(1);
		expect(harness.setRetryInfo).toHaveBeenCalledWith({
			message: "localized: provider busy",
			retryCount: 2,
			maxRetries: 4,
			retryAt: expect.any(Number),
		});
		const retry = harness.setRetryInfo.mock.calls[0][0] as { retryAt: number };
		expect(retry.retryAt).toBeGreaterThanOrEqual(before + 1500);
		expect(retry.retryAt).toBeLessThanOrEqual(after + 1500);
		expect(harness.notify).toHaveBeenCalledWith({
			title: en.narratorRetrying,
			message: "localized: provider busy",
			color: "yellow",
			autoClose: 10000,
		});
	});

	test("ordinary warnings without complete retry fields preserve the old notice behavior", () => {
		const harness = createHarness();
		harness.handle({ message: "ordinary warning", retryCount: 1, maxRetries: 3 });
		expect(harness.setRetryInfo).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			expect.objectContaining({
				title: en.narratorRetrying,
				message: "localized: ordinary warning",
			}),
		);
		expect(nativeMediaFallbackNotice({ message: "ordinary warning" }, harness.t)).toBeNull();
	});
});
