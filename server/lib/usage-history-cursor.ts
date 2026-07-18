/** Opaque keyset cursor for the usage-history list. */
export interface UsageHistoryCursor {
	createdAt: string;
	id: string;
}

interface EncodedUsageHistoryCursor extends UsageHistoryCursor {
	v: 1;
}

const MAX_CURSOR_LENGTH = 512;
const MAX_VALUE_LENGTH = 128;
const UTC_ISO_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isValidDateString(value: string): boolean {
	if (value.length > MAX_VALUE_LENGTH || !UTC_ISO_MILLISECONDS_PATTERN.test(value)) return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function isValidId(value: string): boolean {
	return value.length > 0 && value.length <= MAX_VALUE_LENGTH;
}

export function encodeUsageHistoryCursor(cursor: UsageHistoryCursor): string {
	if (!isValidDateString(cursor.createdAt) || !isValidId(cursor.id)) {
		throw new Error("Invalid usage history cursor");
	}

	const payload: EncodedUsageHistoryCursor = { v: 1, ...cursor };
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeUsageHistoryCursor(value: string | undefined): UsageHistoryCursor | null {
	if (!value || value.length > MAX_CURSOR_LENGTH) return null;

	try {
		const json = Buffer.from(value, "base64url").toString("utf8");
		const parsed = JSON.parse(json) as Partial<EncodedUsageHistoryCursor>;
		if (
			parsed.v !== 1 ||
			typeof parsed.createdAt !== "string" ||
			typeof parsed.id !== "string" ||
			!isValidDateString(parsed.createdAt) ||
			!isValidId(parsed.id)
		) {
			return null;
		}
		return { createdAt: parsed.createdAt, id: parsed.id };
	} catch {
		return null;
	}
}
