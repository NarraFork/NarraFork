import { Cron } from "croner";

/**
 * Compute the next fire time (ISO string) strictly after `from` for a cron
 * expression. Returns null if the pattern never fires again or is invalid.
 */
export function nextCronRun(
	cronExpr: string,
	timezone?: string | null,
	from: Date = new Date(),
): string | null {
	try {
		const cron = new Cron(cronExpr, timezone ? { timezone } : undefined);
		const next = cron.nextRun(from);
		return next ? next.toISOString() : null;
	} catch {
		return null;
	}
}

/**
 * Validate a cron expression (and optional timezone). croner validates the
 * timezone lazily (on the first nextRun() call, not at construction), so we
 * force an evaluation here to catch invalid IANA timezone names.
 */
export function isValidCron(cronExpr: string, timezone?: string | null): boolean {
	try {
		const cron = new Cron(cronExpr, timezone ? { timezone } : undefined);
		// croner treats syntactically-valid-but-never-firing patterns (e.g. "0 0 30 2 *"
		// — Feb 30th) as parseable, returning null from nextRun() instead of throwing.
		// Reject those here so the Zod refine catches them up front, keeping validation
		// in one layer instead of leaking to the service-level nextRunAt guard.
		return cron.nextRun() !== null;
	} catch {
		return false;
	}
}
