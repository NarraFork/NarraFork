import type { Browser } from "puppeteer-core";
import { MemoryProfileError } from "./memory-profile-constants";

export interface TraceLease {
	confirmStopped(): void;
	markUncertain(): void;
	isCurrent(): boolean;
}
interface LeaseEntry {
	token: symbol;
	uncertain: boolean;
	owner: string;
}
const leases = new Map<string, LeaseEntry>();

/** A browser-wide trace has one owner, not one owner per page or CDP connection. */
export function acquireTraceLease(browser: Browser, owner: string): TraceLease {
	const key = browser.wsEndpoint();
	if (!key || !browser.connected) throw new MemoryProfileError("browser_disconnected");
	const previous = leases.get(key);
	if (previous) throw new MemoryProfileError(previous.uncertain ? "trace_uncertain" : "trace_busy");
	const entry: LeaseEntry = { token: Symbol(), uncertain: false, owner };
	leases.set(key, entry);
	const isCurrent = () => leases.get(key)?.token === entry.token;
	const release = () => {
		if (isCurrent()) leases.delete(key);
		browser.off("disconnected", release);
	};
	browser.once("disconnected", release);
	return {
		isCurrent,
		confirmStopped: release,
		markUncertain: () => {
			if (isCurrent()) entry.uncertain = true;
		},
	};
}

/** These replies confirm our start was rejected; never send end against the foreign trace. */
export function definiteTraceStartRejection(error: unknown): boolean {
	return (
		error instanceof Error &&
		/already (?:been )?(?:started|recording)|tracing is already|starting trace recording is already in progress|invalid parameters|method not found/i.test(
			error.message,
		)
	);
}
