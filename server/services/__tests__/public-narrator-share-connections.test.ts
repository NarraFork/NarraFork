import { describe, expect, it } from "bun:test";
import { hotSafe } from "../../lib/hot-safe";
import {
	PublicShareConnectionBudget,
	publicShareConnectionBudget,
} from "../public-narrator-share-connections";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("public share connection budget", () => {
	it("counts pending reservations against share, IP and global limits", () => {
		for (const dimension of ["share", "ip", "global"]) {
			const budget = new PublicShareConnectionBudget();
			const max = dimension === "global" ? 200 : 20;
			const leases = Array.from({ length: max }, (_, i) =>
				budget.reserve(
					dimension === "share" ? "share" : `share-${i}`,
					dimension === "ip" ? "ip" : `ip-${i}`,
				),
			);
			expect(leases.every(Boolean)).toBe(true);
			expect(
				budget.reserve(
					dimension === "share" ? "share" : "extra",
					dimension === "ip" ? "ip" : "extra",
				),
			).toBeNull();
			expect(
				budget.upgrade(
					dimension === "share" ? "share" : "extra",
					dimension === "ip" ? "ip" : "extra",
					() => {
						throw new Error("must not upgrade over budget");
					},
				),
			).toBeNull();
			for (const lease of leases) {
				lease?.release();
				lease?.release();
			}
			expect(budget.stats).toEqual({ connections: 0, shares: 0, ips: 0 });
			const retry = budget.reserve("share", "ip");
			expect(retry).not.toBeNull();
			retry?.release();
		}
	});

	it("reserves before upgrade and releases false and throwing upgrades", () => {
		const budget = new PublicShareConnectionBudget();
		expect(
			budget.upgrade("s", "ip", () => {
				expect(budget.stats.connections).toBe(1);
				return false;
			}),
		).toBe(false);
		expect(budget.stats.connections).toBe(0);
		expect(() =>
			budget.upgrade("s", "ip", () => {
				throw new Error("upgrade failed");
			}),
		).toThrow("upgrade failed");
		expect(budget.stats).toEqual({ connections: 0, shares: 0, ips: 0 });
		const captured: { lease: ReturnType<typeof budget.reserve> } = { lease: null };
		expect(
			budget.upgrade("s", "ip", (reservation) => {
				captured.lease = reservation;
				return true;
			}),
		).toBe(true);
		expect(budget.stats.connections).toBe(1);
		captured.lease?.release();
	});

	it("expires handshakes that never open and refuses a late open", async () => {
		const budget = new PublicShareConnectionBudget(5);
		const lease = budget.reserve("s", "ip");
		await delay(20);
		expect(budget.stats.connections).toBe(0);
		expect(lease?.open(() => {})).toBe(false);
	});

	it("holds open capacity until close or expiry, with idempotent cleanup", async () => {
		const budget = new PublicShareConnectionBudget(5, 30);
		const lease = budget.reserve("s", "ip");
		let closes = 0;
		expect(lease?.open(() => closes++)).toBe(true);
		await delay(15);
		expect(budget.stats.connections).toBe(1);
		await delay(30);
		expect(closes).toBe(1);
		lease?.release();
		expect(budget.stats).toEqual({ connections: 0, shares: 0, ips: 0 });
	});

	it("keeps the singleton accounting across module re-evaluation", () => {
		expect(
			hotSafe("narrafork.publicShare.connectionBudget", () => new PublicShareConnectionBudget()),
		).toBe(publicShareConnectionBudget);
	});
});
