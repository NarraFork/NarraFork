import { hotSafe } from "../lib/hot-safe";
import { PUBLIC_SHARE_LIMITS as L } from "./public-narrator-share-limits";

export interface PublicShareConnectionLease {
	open(close: () => void): boolean;
	release(): void;
}

/** Reservations count too: there is no async gap between checking and admission. */
export class PublicShareConnectionBudget {
	private leases = new Set<PublicShareConnectionLease>();
	private shares = new Map<string, number>();
	private ips = new Map<string, number>();
	constructor(
		private readonly pendingMs = 10_000,
		private readonly connectionMs = L.connectionMs,
	) {}

	reserve(shareId: string, ip: string): PublicShareConnectionLease | null {
		if (
			this.leases.size >= L.connectionsTotal ||
			(this.shares.get(shareId) ?? 0) >= L.connectionsPerShare ||
			(this.ips.get(ip) ?? 0) >= L.connectionsPerIp
		)
			return null;
		let released = false;
		let opened = false;
		let timer: ReturnType<typeof setTimeout>;
		const decrement = (counts: Map<string, number>, key: string) => {
			const count = (counts.get(key) ?? 1) - 1;
			if (count) counts.set(key, count);
			else counts.delete(key);
		};
		const lease: PublicShareConnectionLease = {
			release: () => {
				if (released) return;
				released = true;
				clearTimeout(timer);
				this.leases.delete(lease);
				decrement(this.shares, shareId);
				decrement(this.ips, ip);
			},
			open: (close) => {
				if (released) return false;
				if (opened) return true;
				opened = true;
				clearTimeout(timer);
				timer = setTimeout(() => {
					try {
						close();
					} finally {
						lease.release();
					}
				}, this.connectionMs);
				timer.unref?.();
				return true;
			},
		};
		this.leases.add(lease);
		this.shares.set(shareId, (this.shares.get(shareId) ?? 0) + 1);
		this.ips.set(ip, (this.ips.get(ip) ?? 0) + 1);
		// Failed handshakes that never invoke open/close cannot strand capacity.
		timer = setTimeout(lease.release, this.pendingMs);
		timer.unref?.();
		return lease;
	}

	/** null means budget exhaustion; false/throw always releases the reservation. */
	upgrade(
		shareId: string,
		ip: string,
		upgrade: (lease: PublicShareConnectionLease) => boolean,
	): boolean | null {
		const lease = this.reserve(shareId, ip);
		if (!lease) return null;
		let upgraded = false;
		try {
			upgraded = upgrade(lease);
			return upgraded;
		} finally {
			if (!upgraded) lease.release();
		}
	}

	get stats() {
		return { connections: this.leases.size, shares: this.shares.size, ips: this.ips.size };
	}
}

// Hot reload shares the same accounting with old sockets and their cleanup closures.
// A process restart naturally starts empty because none of its old sockets survive.
export const publicShareConnectionBudget = hotSafe(
	"narrafork.publicShare.connectionBudget",
	() => new PublicShareConnectionBudget(),
);
