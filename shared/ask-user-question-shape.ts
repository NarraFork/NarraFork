/**
 * Pure AskUserQuestion shape coercion shared by server and frontend.
 *
 * ## Advertised shape (intentionally tiny)
 *
 * Models only ever see two field names on both the question and its options:
 *
 * - `header` — SHORT title (about 1–8 words). Same role on questions and options.
 *   Also the model-facing answers key. Coerce UNIQUIFIES colliding headers so
 *   two questions never share an answer key (silent overwrite).
 * - `description` — optional longer text. On a question this is the FULL prompt
 *   the user reads; on an option it is what that choice means. Both are displayed.
 *
 * There is no `id`, `content`, `question`, or `label` in the advertised schema.
 * Extra entity names confuse weaker models into burying the prompt in an
 * unrendered field.
 *
 * ## Normalization still accepts history
 *
 * Older payloads stored `question` (answer key), `content`, and option `label`.
 * Coercion always RETURNS header/description. `id` is kept only as an INTERNAL
 * draft/React key; model-facing answers are keyed by the (uniquified) `header`.
 *
 * This module must not import anything with side effects.
 */

export interface CoercedAskQuestionOption {
	/** Option title shown to the user (and used as the selected-value token). */
	header: string;
	description?: string;
	preview?: string;
}

export interface CoercedAskQuestion {
	/**
	 * Internal draft/React key. Not advertised to models; derived from a legacy
	 * key-like field or a short positional fallback so long headers do not become
	 * sessionStorage keys.
	 */
	id: string;
	/**
	 * Display title and model-facing answers key. Uniquified when the raw payload
	 * repeats the same header, so answers cannot overwrite each other.
	 */
	header: string;
	/** Optional full prompt / extra context under the header. */
	description?: string;
	options: CoercedAskQuestionOption[];
	multiSelect?: boolean;
}

const INVALID_KEYS = new Set(["undefined", "null"]);
const KEY_LIKE_MAX_CHARS = 40;
const SENTENCE_PUNCTUATION = /[？?！!：:\n]/;
/** Internal ids stay short so draft keys and React keys remain manageable. */
const INTERNAL_ID_MAX_CHARS = 32;

function normalizeText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function isUsableKey(value: string): boolean {
	return value.length > 0 && !INVALID_KEYS.has(value.toLowerCase());
}

/** True when a raw string looks like a machine answer key rather than display text. */
export function isKeyLike(value: string): boolean {
	const trimmed = value.trim();
	if (!isUsableKey(trimmed)) return false;
	if (trimmed.length > KEY_LIKE_MAX_CHARS) return false;
	if (SENTENCE_PUNCTUATION.test(trimmed)) return false;
	return /^[A-Za-z0-9][\w.-]*$/.test(trimmed) || trimmed.length <= 24;
}

function uniqueInternalId(preferred: string, index: number, used: Set<string>): string {
	const trimmed = preferred.trim();
	let base =
		isUsableKey(trimmed) && isKeyLike(trimmed) && trimmed.length <= INTERNAL_ID_MAX_CHARS
			? trimmed
			: `q${index + 1}`;
	if (base.length > INTERNAL_ID_MAX_CHARS) base = base.slice(0, INTERNAL_ID_MAX_CHARS);
	let candidate = base;
	if (used.has(candidate)) candidate = `${base}-${index + 1}`;
	let suffix = 2;
	while (used.has(candidate)) {
		candidate = `${base}-${index + 1}-${suffix}`;
		suffix += 1;
	}
	used.add(candidate);
	return candidate;
}

/**
 * Keep headers unique so answers keyed by header never collide.
 * First occurrence keeps the original; later ones get ` (2)`, ` (3)`, …
 */
function uniqueHeader(base: string, index: number, used: Set<string>): string {
	const fallback = base.trim() || `Question ${index + 1}`;
	let candidate = fallback;
	if (used.has(candidate)) {
		let n = 2;
		candidate = `${fallback} (${n})`;
		while (used.has(candidate)) {
			n += 1;
			candidate = `${fallback} (${n})`;
		}
	}
	used.add(candidate);
	return candidate;
}

function coerceOptions(rawOptions: unknown): CoercedAskQuestionOption[] {
	if (!Array.isArray(rawOptions)) return [];
	return rawOptions
		.map((option) => {
			if (!option || typeof option !== "object") return null;
			const optionRecord = option as Record<string, unknown>;
			// Prefer `header`; accept legacy `label` so stored rows keep rendering.
			const header =
				normalizeText(optionRecord.header) ||
				normalizeText(optionRecord.label) ||
				normalizeText(optionRecord.title);
			if (!header) return null;
			const description =
				typeof optionRecord.description === "string" ? optionRecord.description : undefined;
			const preview = typeof optionRecord.preview === "string" ? optionRecord.preview : undefined;
			return {
				header,
				...(description ? { description } : {}),
				...(preview ? { preview } : {}),
			};
		})
		.filter((option): option is CoercedAskQuestionOption => option !== null);
}

/**
 * Map one raw record onto header/description.
 *
 * Advertised semantics: `header` is a SHORT title; `description` is the full
 * prompt. Legacy payloads often buried the body in `question`/`content` or put
 * everything into `header`. Prefer a short readable title as `header` and the
 * long body as `description` so both stay visible in the UI.
 */
function normalizeQuestionFields(record: Record<string, unknown>): {
	idPreferred: string;
	header: string | undefined;
	description?: string;
} {
	const rawId = normalizeText(record.id);
	const rawQuestion = normalizeText(record.question);
	const rawHeader = normalizeText(record.header);
	const rawContent = normalizeText(record.content);
	const rawLabel = normalizeText(record.label);
	const rawDescription = normalizeText(record.description);

	const questionIsKey = isKeyLike(rawQuestion);
	const questionBody = !questionIsKey && isUsableKey(rawQuestion) ? rawQuestion : "";

	// Long body: explicit description wins, else legacy content/question body.
	const body = rawDescription || rawContent || questionBody;
	// Title candidates: header/label; if only a long body exists, use its first line.
	const titleFromHeader = rawHeader || rawLabel;
	const header = titleFromHeader || (body ? (body.split("\n")[0] ?? body) : "");

	// Keep the long body in description whenever it is not already the whole header.
	let description: string | undefined = body || undefined;
	if (description && description === header) description = undefined;
	if (description && titleFromHeader && description === titleFromHeader) {
		description = undefined;
	}

	const idPreferred = isUsableKey(rawId)
		? rawId
		: questionIsKey && isUsableKey(rawQuestion)
			? rawQuestion
			: "";

	return {
		idPreferred,
		header,
		...(description ? { description } : {}),
	};
}

/**
 * Coerce a possibly-stringified questions value into sanitized CoercedAskQuestion[].
 *
 * Providers occasionally omit keys, stringify the whole array, send placeholders,
 * or bury the prompt in `question`/`content`. Colliding headers are uniquified
 * so model-facing answers cannot overwrite each other.
 */
export function coerceAskQuestionShape(raw: unknown): CoercedAskQuestion[] {
	let value = raw;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return [];
		try {
			value = JSON.parse(trimmed);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(value)) return [];
	const usedIds = new Set<string>();
	const usedHeaders = new Set<string>();
	const questions: CoercedAskQuestion[] = [];
	value.forEach((item, index) => {
		if (!item || typeof item !== "object") return;
		const record = item as Record<string, unknown>;
		const { idPreferred, header, description } = normalizeQuestionFields(record);
		const displayHeader = uniqueHeader(header || "", index, usedHeaders);
		const id = uniqueInternalId(idPreferred, index, usedIds);
		const options = coerceOptions(record.options);
		questions.push({
			id,
			header: displayHeader,
			...(description ? { description } : {}),
			options,
			// Omit rather than write `false`: a stored question and a coerced one should
			// compare equal when both are single-select.
			...(record.multiSelect === true ? { multiSelect: true } : {}),
		});
	});
	return questions;
}
