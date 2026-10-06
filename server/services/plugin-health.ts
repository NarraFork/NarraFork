export type CircuitState = "closed" | "open" | "half-open";
export type PluginHealthSurface = "runtime" | "provider" | "tool" | "event";

export interface PluginHealthSample {
	at: string;
	durationMs: number;
	ok: boolean;
	code?: string;
	bytesIn?: number;
	bytesOut?: number;
}

export interface PluginHealthMetrics {
	pluginId: string;
	surface: PluginHealthSurface;
	state: CircuitState;
	requests: number;
	successes: number;
	failures: number;
	consecutiveFailures: number;
	lastFailureAt?: string;
	lastSuccessAt?: string;
	averageDurationMs: number;
	bytesIn: number;
	bytesOut: number;
}

export interface PluginCircuitBreakerOptions {
	failureThreshold?: number;
	openMs?: number;
	halfOpenMaxCalls?: number;
	now?: () => number;
}

/** Bounded health/circuit primitive for a single plugin or provider contribution. */
export class PluginCircuitBreaker {
	private stateValue: CircuitState = "closed";
	private failuresValue = 0;
	private successesValue = 0;
	private consecutiveFailuresValue = 0;
	private lastFailureAt?: string;
	private lastSuccessAt?: string;
	private durations: number[] = [];
	private bytesInValue = 0;
	private bytesOutValue = 0;
	private halfOpenCalls = 0;
	private readonly threshold: number;
	private readonly openMs: number;
	private readonly halfOpenMaxCalls: number;
	private readonly clock: () => number;
	constructor(
		private readonly pluginId: string,
		options: PluginCircuitBreakerOptions = {},
		private readonly surface: PluginHealthSurface = "runtime",
	) {
		this.threshold = Math.max(1, options.failureThreshold ?? 3);
		this.openMs = Math.max(1, options.openMs ?? 30_000);
		this.halfOpenMaxCalls = Math.max(1, options.halfOpenMaxCalls ?? 1);
		this.clock = options.now ?? Date.now;
	}

	get state(): CircuitState {
		this.transitionIfReady();
		return this.stateValue;
	}
	allowRequest(): boolean {
		this.transitionIfReady();
		if (this.stateValue === "closed") return true;
		if (this.stateValue === "open") return false;
		if (this.halfOpenCalls >= this.halfOpenMaxCalls) return false;
		this.halfOpenCalls += 1;
		return true;
	}
	record(sample: Omit<PluginHealthSample, "at"> & { at?: string }): void {
		const at = sample.at ?? new Date(this.clock()).toISOString();
		this.durations.push(Math.max(0, sample.durationMs));
		if (this.durations.length > 100) this.durations.shift();
		this.bytesInValue += Math.max(0, sample.bytesIn ?? 0);
		this.bytesOutValue += Math.max(0, sample.bytesOut ?? 0);
		if (sample.ok) {
			this.successesValue += 1;
			this.consecutiveFailuresValue = 0;
			this.lastSuccessAt = at;
			this.halfOpenCalls = 0;
			this.stateValue = "closed";
		} else {
			this.failuresValue += 1;
			this.consecutiveFailuresValue += 1;
			this.lastFailureAt = at;
			this.halfOpenCalls = 0;
			if (this.consecutiveFailuresValue >= this.threshold || this.stateValue === "half-open")
				this.stateValue = "open";
		}
	}
	reset(): void {
		this.stateValue = "closed";
		this.consecutiveFailuresValue = 0;
		this.halfOpenCalls = 0;
	}
	metrics(): PluginHealthMetrics {
		this.transitionIfReady();
		return {
			pluginId: this.pluginId,
			surface: this.surface,
			state: this.stateValue,
			requests: this.successesValue + this.failuresValue,
			successes: this.successesValue,
			failures: this.failuresValue,
			consecutiveFailures: this.consecutiveFailuresValue,
			lastFailureAt: this.lastFailureAt,
			lastSuccessAt: this.lastSuccessAt,
			averageDurationMs:
				this.durations.length === 0
					? 0
					: this.durations.reduce((sum, value) => sum + value, 0) / this.durations.length,
			bytesIn: this.bytesInValue,
			bytesOut: this.bytesOutValue,
		};
	}
	private transitionIfReady(): void {
		if (
			this.stateValue === "open" &&
			this.lastFailureAt &&
			this.clock() - Date.parse(this.lastFailureAt) >= this.openMs
		) {
			this.stateValue = "half-open";
			this.halfOpenCalls = 0;
		}
	}
}

export class PluginHealthRegistry {
	private readonly breakers = new Map<string, PluginCircuitBreaker>();

	get(
		pluginId: string,
		options?: PluginCircuitBreakerOptions,
		surface: PluginHealthSurface = "runtime",
	): PluginCircuitBreaker {
		const key = `${surface}:${pluginId}`;
		let breaker = this.breakers.get(key);
		if (!breaker) {
			breaker = new PluginCircuitBreaker(pluginId, options, surface);
			this.breakers.set(key, breaker);
		}
		return breaker;
	}

	/** Stable production call contract for runtime/provider/tool/event adapters. */
	recordCall(
		pluginId: string,
		surface: PluginHealthSurface,
		sample: Omit<PluginHealthSample, "at"> & { at?: string },
	): void {
		this.get(pluginId, undefined, surface).record(sample);
	}

	metrics(): PluginHealthMetrics[] {
		return [...this.breakers.values()].map((breaker) => breaker.metrics());
	}
}

export const pluginHealthRegistry = new PluginHealthRegistry();
