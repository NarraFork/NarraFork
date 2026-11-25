import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { initReactI18next } from "react-i18next";
import { useNarrator } from "../../hooks/useNarrator";
import { useNarratorExecutionDevices } from "../../hooks/useNarratorExecutionDevices";
import { useRuntimeSettings } from "../../hooks/useRuntimeSettings";
import { useUnattendedStatus } from "../../hooks/useUnattendedStatus";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { clearToken, getToken, setToken } from "../../lib/api/client";
import { appearanceStore } from "../../lib/appearance-preference-store";
import { useBackgroundTaskList } from "./background/useBackgroundTaskList";
import { PendingAgentMessagesPanel } from "./interaction/PendingAgentMessagesPanel";
import { connection, emit, foreground } from "./narrator-polling.browser-ws-fixture";
import { useNarratorPanelWS } from "./useNarratorPanelWS";

export { connection, emit, foreground };

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = createRoot(document.getElementById("root") as HTMLElement);
const originalToken = getToken();
const nativeSetInterval = window.setInterval;
const originalClearInterval = window.clearInterval;
let narratorId = "";

// Deliberately bounded interval-only clock. Old 60s React Query/device/global timers
// and the 5s background fallback run every due tick, with real browser HTTP between
// ticks. Native timeouts (coalescing, React scheduling, fetch) and Date.now stay real.
const intervals = new Map<number, { callback: () => void; period: number; next: number }>();
let clock = 0;
let intervalId = 1_000_000;
const nativeTimeout = window.setTimeout.bind(window);
const nativeClearInterval = window.clearInterval.bind(window);
const canaries = { fiveSeconds: 0, sixtySeconds: 0 };
function installIntervalDriver() {
	window.setInterval = ((handler: TimerHandler, delay = 0, ...args: unknown[]) => {
		if (typeof handler !== "function") throw new Error("Fixture requires function intervals");
		const period = Math.max(1, Number(delay));
		const id = ++intervalId;
		intervals.set(id, { callback: () => handler(...args), period, next: clock + period });
		return id;
	}) as typeof window.setInterval;
	window.clearInterval = ((id?: number) => {
		if (id !== undefined && intervals.delete(id)) return;
		nativeClearInterval(id);
	}) as typeof window.clearInterval;
	window.setInterval(() => canaries.fiveSeconds++, 5_000);
	window.setInterval(() => canaries.sixtySeconds++, 60_000);
}

export async function advanceIntervals(milliseconds: number) {
	if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 120_000)
		throw new Error("Interval advancement must be bounded to 120 seconds");
	const end = clock + milliseconds;
	let executions = 0;
	while (true) {
		let due = end + 1;
		for (const interval of intervals.values()) due = Math.min(due, interval.next);
		if (due > end) break;
		clock = due;
		for (const [id, interval] of [...intervals]) {
			if (interval.next > clock || !intervals.has(id)) continue;
			if (++executions > 10_000) throw new Error("Unbounded interval execution");
			interval.next += interval.period;
			interval.callback();
		}
		await settle();
	}
	clock = end;
	return { clock, ...canaries, executions };
}

export async function settle() {
	// Let native debounce timers and real fetch responses finish without advancing the
	// interval clock. An upper bound makes broken production requests fail, not skip.
	await new Promise<void>((resolve) => nativeTimeout(resolve, 150));
	for (let attempt = 0; attempt < 100; attempt++) {
		if (!queryClient.isFetching()) {
			await new Promise<void>((resolve) => nativeTimeout(resolve, 20));
			if (!queryClient.isFetching()) return;
		}
		await new Promise<void>((resolve) => nativeTimeout(resolve, 20));
	}
	throw new Error("Fixture queries did not settle");
}

function SharedDeviceAndGlobalObserver() {
	useNarratorExecutionDevices(narratorId);
	useUnattendedStatus();
	return null;
}
function Observer() {
	const detail = useNarrator(narratorId);
	const devices = useNarratorExecutionDevices(narratorId);
	const unattended = useUnattendedStatus();
	const background = useBackgroundTaskList(narratorId, true);
	const runtime = useRuntimeSettings();
	const preferences = useUserPreferences();
	const atBottom = useRef(true);
	const panel = useNarratorPanelWS({
		narratorId,
		narratorStatus: detail.data?.status ?? "working",
		isAtBottomRef: atBottom,
	});
	return (
		<div
			data-ready={
				!!detail.data &&
				!!devices.data &&
				!!unattended.data &&
				!background.isLoading &&
				!!runtime.data &&
				!!preferences.data
			}
		>
			<div data-status>{detail.data?.status}</div>
			<div data-device-count>{devices.data?.devices.length}</div>
			<div data-unattended>{unattended.data?.phase}</div>
			<div data-background-count>{background.activeCount}</div>
			<div data-connected>{String(panel.connected)}</div>
			<PendingAgentMessagesPanel narratorId={narratorId} />
			<SharedDeviceAndGlobalObserver />
		</div>
	);
}

export async function start(id: string) {
	narratorId = id;
	setToken("narrator-polling-fixture-token");
	appearanceStore.activate(null, true);
	installIntervalDriver();
	await i18n.use(initReactI18next).init({
		lng: "en",
		resources: { en: { narrator: {}, common: {} } },
		fallbackLng: "en",
		interpolation: { escapeValue: false },
	});
	root.render(
		<MantineProvider>
			<QueryClientProvider client={queryClient}>
				<Observer />
			</QueryClientProvider>
		</MantineProvider>,
	);
}

export function cleanup() {
	root.unmount();
	queryClient.clear();
	appearanceStore.activate(null, true);
	intervals.clear();
	window.setInterval = nativeSetInterval;
	window.clearInterval = originalClearInterval;
	if (originalToken === null) clearToken();
	else setToken(originalToken);
}

export function snapshot() {
	return {
		fetching: queryClient.isFetching(),
		clock,
		canaries,
		intervalPeriods: [...intervals.values()].map((interval) => interval.period),
	};
}
