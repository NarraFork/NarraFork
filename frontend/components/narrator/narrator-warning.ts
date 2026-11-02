import type { NarratorWarningInfo } from "../../hooks/useNarratorWS";

interface WarningNotification {
	title: string;
	message: string;
	color: "yellow";
	autoClose: number;
}

interface WarningRetryInfo {
	message: string;
	retryCount: number;
	maxRetries: number;
	retryAt: number;
}

/** The server localizes the fallback reason and filenames; it is not a provider error. */
export function nativeMediaFallbackNotice(
	info: NarratorWarningInfo,
	t: (key: string) => string,
): WarningNotification | null {
	if (info.warningCode !== "native_media_fallback") return null;
	return {
		title: t("nativeMediaFallbackTitle"),
		message: `${info.message}\n${t("nativeMediaFallbackDetails")}`,
		color: "yellow",
		autoClose: 10000,
	};
}

export function createNarratorWarningHandler({
	t,
	localizeWarning,
	setRetryInfo,
	notify,
}: {
	t: (key: string) => string;
	localizeWarning: (info: NarratorWarningInfo) => string;
	setRetryInfo: (info: WarningRetryInfo) => void;
	notify: (notice: WarningNotification) => unknown;
}): (info: NarratorWarningInfo) => void {
	return (info) => {
		const fallbackNotice = nativeMediaFallbackNotice(info, t);
		if (fallbackNotice) {
			notify(fallbackNotice);
			return;
		}
		const localizedWarning = localizeWarning(info);
		if (info.retryCount != null && info.maxRetries != null && info.delayMs != null) {
			setRetryInfo({
				message: localizedWarning,
				retryCount: info.retryCount,
				maxRetries: info.maxRetries,
				retryAt: Date.now() + info.delayMs,
			});
		}
		notify({
			title: t("narratorRetrying"),
			message: localizedWarning,
			color: "yellow",
			autoClose: 10000,
		});
	};
}
