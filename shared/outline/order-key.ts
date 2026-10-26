/**
 * Fractional order keys for siblings: `keyBetween(a, b)` returns a key strictly between `a` and
 * `b` (`null` = open end), so inserting or moving a block rewrites only that block's key.
 *
 * Keys use only `0-9A-Za-z`, which are in ASCII order, so JavaScript string comparison
 * (`<`, `Array.prototype.sort`), SQLite's BINARY collation and PostgreSQL `COLLATE "C"` all sort
 * them identically. Never compare them with `localeCompare` or a locale collation: those fold
 * case and would interleave `a…` with `A…`.
 *
 * Layout (the length-prefixed scheme from David Greenspan's "Implementing Fractional Indexing"):
 * an integer part whose first character encodes its length (`a`–`z`: 1–26 digits, growing;
 * `Z`–`A`: 1–26 digits, shrinking toward the front), then an optional fraction that never ends
 * in `0`. Appending or prepending steps the integer, so repeated appends grow keys
 * logarithmically (10,000 appends stay within 4 characters); inserting between two neighbours
 * bisects the fraction.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = "0";
const LAST = "z";
/** The smallest integer part; reserved so that something can always be inserted before. */
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;
const KEY_RE = /^[0-9A-Za-z]+$/;

export class OrderKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrderKeyError";
	}
}

function integerLength(head: string): number {
	if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
	if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
	throw new OrderKeyError(`invalid order key head: ${JSON.stringify(head)}`);
}

function integerPart(key: string): string {
	const n = integerLength(key[0] ?? "");
	if (n > key.length) throw new OrderKeyError(`invalid order key: ${JSON.stringify(key)}`);
	return key.slice(0, n);
}

/** Whether `key` is a well-formed order key. */
export function isOrderKey(key: string): boolean {
	if (!KEY_RE.test(key) || key === SMALLEST_INTEGER) return false;
	const head = key[0] as string;
	if (!/[A-Za-z]/.test(head)) return false;
	const n = integerLength(head);
	return n <= key.length && !(key.length > n && key.endsWith(ZERO));
}

function assertKey(key: string): void {
	if (!isOrderKey(key)) throw new OrderKeyError(`invalid order key: ${JSON.stringify(key)}`);
}

/** A digit string strictly between fractions `a` and `b` (`b === null`: no upper bound). */
function midpoint(a: string, b: string | null): string {
	if (b !== null) {
		// Drop the common prefix (`a` is padded with zeros).
		let n = 0;
		while ((a[n] ?? ZERO) === b[n]) n++;
		if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
	}
	const da = a ? DIGITS.indexOf(a[0] as string) : 0;
	const db = b !== null ? DIGITS.indexOf(b[0] as string) : DIGITS.length;
	if (db - da > 1) return DIGITS[Math.round((da + db) / 2)] as string;
	// Consecutive first digits.
	if (b !== null && b.length > 1) return b.slice(0, 1);
	return (DIGITS[da] as string) + midpoint(a.slice(1), null);
}

function incrementInteger(x: string): string | null {
	const head = x[0] as string;
	const digits = x.slice(1).split("");
	let carry = true;
	for (let i = digits.length - 1; carry && i >= 0; i--) {
		const d = DIGITS.indexOf(digits[i] as string) + 1;
		if (d === DIGITS.length) digits[i] = ZERO;
		else {
			digits[i] = DIGITS[d] as string;
			carry = false;
		}
	}
	if (!carry) return head + digits.join("");
	if (head === "Z") return `a${ZERO}`;
	if (head === "z") return null;
	const next = String.fromCharCode(head.charCodeAt(0) + 1);
	if (next > "a") digits.push(ZERO);
	else digits.pop();
	return next + digits.join("");
}

function decrementInteger(x: string): string | null {
	const head = x[0] as string;
	const digits = x.slice(1).split("");
	let borrow = true;
	for (let i = digits.length - 1; borrow && i >= 0; i--) {
		const d = DIGITS.indexOf(digits[i] as string) - 1;
		if (d === -1) digits[i] = LAST;
		else {
			digits[i] = DIGITS[d] as string;
			borrow = false;
		}
	}
	if (!borrow) return head + digits.join("");
	if (head === "a") return `Z${LAST}`;
	if (head === "A") return null;
	const next = String.fromCharCode(head.charCodeAt(0) - 1);
	if (next < "Z") digits.push(LAST);
	else digits.pop();
	return next + digits.join("");
}

/**
 * A key strictly between `a` and `b`. `a === null` means before everything, `b === null` after
 * everything; both null gives the first key of an empty list. Throws `OrderKeyError` on a
 * malformed key or when `a >= b`.
 */
export function keyBetween(a: string | null, b: string | null): string {
	if (a !== null) assertKey(a);
	if (b !== null) assertKey(b);
	if (a !== null && b !== null && a >= b)
		throw new OrderKeyError(`keyBetween: ${JSON.stringify(a)} >= ${JSON.stringify(b)}`);
	if (a === null) {
		if (b === null) return `a${ZERO}`;
		const ib = integerPart(b);
		const fb = b.slice(ib.length);
		if (ib === SMALLEST_INTEGER) return ib + midpoint("", fb);
		if (ib < b) return ib;
		const dec = decrementInteger(ib);
		if (dec === null) throw new OrderKeyError("cannot insert before the smallest order key");
		return dec;
	}
	const ia = integerPart(a);
	const fa = a.slice(ia.length);
	if (b === null) return incrementInteger(ia) ?? ia + midpoint(fa, null);
	const ib = integerPart(b);
	const fb = b.slice(ib.length);
	if (ia === ib) return ia + midpoint(fa, fb);
	const inc = incrementInteger(ia);
	if (inc === null) throw new OrderKeyError("cannot insert after the largest order key");
	return inc < b ? inc : ia + midpoint(fa, null);
}

/**
 * `n` increasing keys strictly between `a` and `b`. Keys between two bounds are spread by
 * bisection, so inserting a batch keeps them short.
 */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
	if (!Number.isInteger(n) || n < 0) throw new OrderKeyError(`invalid key count: ${n}`);
	if (n === 0) return [];
	if (n === 1) return [keyBetween(a, b)];
	if (b === null) {
		const out: string[] = [];
		let k = a;
		for (let i = 0; i < n; i++) {
			k = keyBetween(k, null);
			out.push(k);
		}
		return out;
	}
	if (a === null) {
		const out: string[] = [];
		let k: string = b;
		for (let i = 0; i < n; i++) {
			k = keyBetween(null, k);
			out.push(k);
		}
		return out.reverse();
	}
	const mid = Math.floor(n / 2);
	const c = keyBetween(a, b);
	return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}

/** Comparator for order keys: plain code-unit order, the same as bytewise / `COLLATE "C"`. */
export function compareOrderKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
