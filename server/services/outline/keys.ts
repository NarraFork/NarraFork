/**
 * Short names in block addresses (`key/sid`): space keys and block sids.
 *
 * Both come from `generateShortId`, keeping only draws made of letters and digits (about 3 in
 * 4 are). Its alphabet also has `-` and `_`: an address token may not start with either
 * (`shared/outline/address.ts`), and a `_` inside `[[…]]` is written escaped (`\_`) by the
 * dialect, which would make stored links harder to read and to type.
 */
import { generateShortId } from "@server/lib/id";

const ALPHANUMERIC = /^[A-Za-z0-9]+$/;

function alphanumericShortId(): string {
	for (;;) {
		const id = generateShortId();
		if (ALPHANUMERIC.test(id)) return id;
	}
}

/** A new space key. Uniqueness is the caller's to check (a unique index backs it). */
export function newOutlineKey(): string {
	return alphanumericShortId();
}

/** A new block sid. Uniqueness within the space is the caller's to check. */
export function newOutlineSid(): string {
	return alphanumericShortId();
}
