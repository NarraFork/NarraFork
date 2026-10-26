/** Shared helpers: deterministic PRNG, ids, stats, timing. */

export class Rng {
	private a: number;
	private b: number;
	private c: number;
	private d: number;
	constructor(seed: number) {
		// splitmix32 to expand the seed, then sfc32.
		let s = seed >>> 0;
		const next = () => {
			s = (s + 0x9e3779b9) >>> 0;
			let z = s;
			z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
			z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
			return (z ^ (z >>> 16)) >>> 0;
		};
		this.a = next();
		this.b = next();
		this.c = next();
		this.d = next();
		for (let i = 0; i < 12; i++) this.u32();
	}
	u32(): number {
		this.a >>>= 0;
		this.b >>>= 0;
		this.c >>>= 0;
		this.d >>>= 0;
		const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
		this.d = (this.d + 1) >>> 0;
		this.a = this.b ^ (this.b >>> 9);
		this.b = (this.c + (this.c << 3)) >>> 0;
		this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
		this.c = (this.c + t) >>> 0;
		return t;
	}
	/** Uniform in [0, 1). */
	rnd(): number {
		return this.u32() / 4294967296;
	}
	/** Uniform integer in [0, n). */
	int(n: number): number {
		return Math.floor(this.rnd() * n);
	}
	range(lo: number, hi: number): number {
		return lo + this.int(hi - lo + 1);
	}
	normal(): number {
		const u = 1 - this.rnd();
		const v = this.rnd();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	}
	pick<T>(arr: readonly T[]): T {
		return arr[this.int(arr.length)] as T;
	}
}

const ID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/** 21-char nanoid-shaped id (the repo uses nanoid text ids everywhere). */
export function nanoId(rng: Rng): string {
	let s = "";
	for (let i = 0; i < 21; i++) s += ID_ALPHABET[rng.u32() & 63];
	return s;
}

export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx] as number;
}

export interface Summary {
	n: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
	mean: number;
}

export function summarize(samples: number[]): Summary {
	const s = [...samples].sort((a, b) => a - b);
	const mean = s.reduce((x, y) => x + y, 0) / Math.max(1, s.length);
	return {
		n: s.length,
		p50: percentile(s, 50),
		p95: percentile(s, 95),
		p99: percentile(s, 99),
		max: s[s.length - 1] ?? Number.NaN,
		mean,
	};
}

export function fmt(x: number, digits = 2): string {
	if (!Number.isFinite(x)) return "-";
	return x.toFixed(digits);
}

export function arg(name: string, def?: string): string | undefined {
	const prefix = `--${name}=`;
	for (const a of process.argv.slice(2)) {
		if (a.startsWith(prefix)) return a.slice(prefix.length);
		if (a === `--${name}`) return "true";
	}
	return def;
}

export function argNum(name: string, def: number): number {
	const v = arg(name);
	return v === undefined ? def : Number(v);
}

export const DATA_ROOT =
	process.env.OUTLINE_BENCH_DATA ??
	"/tmp/claude-0/-home-user-NarraFork/13582635-c8be-5e3d-9f41-f14f8cb5ad58/scratchpad/outline-bench-data";

export const PG_SOCKET = process.env.OUTLINE_BENCH_PG_SOCKET ?? "/tmp/obpg/.s.PGSQL.54329";
