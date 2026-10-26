/**
 * 内存里的「网络」：每个客户端一条双向链路，按顺序投递，可设延迟，可暂停（模拟并发：
 * 两人都在看到对方修改之前各自改）。消息用结构化克隆，模拟真实的序列化边界。
 */
export type Msg = Record<string, unknown> & { t: string };

interface Link {
	toServer: Msg[];
	toClient: Msg[];
	held: boolean;
	client: (m: Msg) => void;
}

export class Net {
	latency = 0;
	private links = new Map<string, Link>();
	private server: ((from: string, m: Msg) => void) | null = null;
	private inflight = 0;
	private idleWaiters: Array<() => void> = [];
	stats = { toServer: 0, toClient: 0, bytes: 0 };

	attachServer(fn: (from: string, m: Msg) => void) {
		this.server = fn;
	}

	attachClient(id: string, fn: (m: Msg) => void) {
		this.links.set(id, { toServer: [], toClient: [], held: false, client: fn });
	}

	private clone(m: Msg): Msg {
		return structuredClone(m);
	}

	sendToServer(from: string, m: Msg) {
		const l = this.links.get(from);
		if (!l) throw new Error(`unknown client ${from}`);
		this.stats.toServer++;
		l.toServer.push(this.clone(m));
		this.pump(from);
	}

	sendToClient(to: string, m: Msg) {
		const l = this.links.get(to);
		if (!l) return;
		this.stats.toClient++;
		l.toClient.push(this.clone(m));
		this.pump(to);
	}

	hold(id: string, on: boolean) {
		const l = this.links.get(id);
		if (!l) return;
		l.held = on;
		if (!on) this.pump(id);
	}

	isHeld(id: string): boolean {
		return this.links.get(id)?.held ?? false;
	}

	private pump(id: string) {
		const l = this.links.get(id);
		if (!l || l.held) return;
		while (l.toServer.length || l.toClient.length) {
			const up = l.toServer.shift();
			if (up) this.later(() => this.server?.(id, up));
			const down = l.toClient.shift();
			if (down) this.later(() => l.client(down));
		}
	}

	private later(fn: () => void) {
		this.inflight++;
		setTimeout(() => {
			try {
				fn();
			} finally {
				this.inflight--;
				if (this.inflight === 0) this.checkIdle();
			}
		}, this.latency);
	}

	private checkIdle() {
		for (const l of this.links.values())
			if (!l.held && (l.toServer.length || l.toClient.length)) return;
		const w = this.idleWaiters;
		this.idleWaiters = [];
		for (const f of w) f();
	}

	/** 所有未暂停链路上的消息都投递完。 */
	idle(): Promise<void> {
		if (this.inflight === 0) return Promise.resolve();
		return new Promise((r) => this.idleWaiters.push(r));
	}
}
