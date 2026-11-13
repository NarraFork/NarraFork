import {
	REMOTE_PRODUCTION_LIMITS as limits,
	type RemoteRequestPhase,
	type RemoteRequestRule,
} from "./application";

const id = "[A-Za-z0-9_-]{1,128}";
// Real narrator IDs are nanoid(21). A broad segment would also match reserved
// routers such as workspace-directory-browse before Hono's /:id handler.
const narratorId = "[A-Za-z0-9_-]{21}";
const narrator = `/api/narrators/${narratorId}`;
function rule(
	name: string,
	methods: string[],
	path: string,
	options: Partial<RemoteRequestRule> = {},
): RemoteRequestRule {
	return {
		id: name,
		methods,
		path: `^${path}$`,
		phase: "ready",
		profile: "request",
		requestBytes: limits.jsonBytes,
		responseBytes: limits.fileBytes,
		...options,
	};
}
/** Deliberately enumerated, never an entire /api or /settings namespace. RE2 compatible. */
export const REMOTE_REQUEST_POLICY: RemoteRequestRule[] = [
	rule("password-login", ["POST"], "/api/auth/login", { phase: "paired" }),
	rule("mfa-login", ["POST"], "/api/auth/mfa/verify", { phase: "paired" }),
	rule("session", ["GET"], "/api/auth/me"),
	rule("logout", ["POST"], "/api/auth/logout"),
	rule("health", ["GET"], "/api/health"),
	rule("settings-read", ["GET"], "/api/settings"),
	rule("models-read", ["GET"], "/api/settings/auto-models"),
	rule("model-catalog-read", ["GET"], "/api/model-catalog/(auto|card)"),
	rule("model-catalog-batch", ["POST"], "/api/model-catalog/models"),
	rule("context-thresholds", ["GET"], "/api/settings/context-thresholds"),
	rule("preferences-read", ["GET"], "/api/user-preferences"),
	rule("projects", ["GET"], "/api/projects"),
	rule("project", ["GET"], `/api/projects/${narratorId}`),
	rule("project-access", ["GET"], `/api/projects/${narratorId}/access`),
	rule("narrators", ["GET"], "/api/narrators"),
	rule("narrator", ["GET"], narrator),
	rule(
		"narrator-state",
		["GET"],
		`${narrator}/(panel-state|access|workspace-context|tasks/current|permissions|permission-rule-requests|questions|buffer|draft|pretext-document|history-recovery|search|commands|skills|custom-traits)`,
	),
	rule(
		"narrator-history",
		["GET"],
		`${narrator}/(messages|timeline|timeline/turns|chunks|chunk-tail|document)`,
	),
	rule("narrator-location", ["GET"], `${narrator}/message-location/${id}`),
	rule("narrator-message", ["GET"], `${narrator}/(messages|buffer)/${id}/composer-document`),
	rule("narrator-tool", ["GET"], `${narrator}/tool-calls/${id}(/input-document)?`),
	rule("narrator-text", ["GET"], `${narrator}/text-documents/${id}`),
	rule("narrator-question", ["GET"], `${narrator}/questions/${id}`),
	rule(
		"question-answer",
		["POST"],
		`${narrator}/questions/${id}/(answer|dismiss|ignore|supplement)`,
	),
	rule(
		"approval",
		["POST"],
		`/api/narrators/permissions/${id}/(approve|deny|plan|defer|reflect-question|disarm-question-reflection|stop-question-reflection|stop-reflection|stop-plan-reflection|stop-task-reflection)`,
	),
	rule("message-send", ["POST"], `${narrator}/messages`, { requestBytes: limits.fileBytes }),
	rule("message-edit", ["POST"], `${narrator}/(edit-and-regenerate|edit-message)/${id}`, {
		requestBytes: limits.fileBytes,
	}),
	rule(
		"conversation-control",
		["POST"],
		`${narrator}/(continue|retry|interrupt|compact|compact/cancel|plan-mode/enter|plan-mode/exit)`,
	),
	rule(
		"conversation-display",
		["PATCH"],
		`${narrator}/(model|reasoning-effort|fast-mode|relaxed-plan|title|mark-read)`,
	),
	rule("draft", ["PUT"], `${narrator}/draft`),
	rule("compact", ["GET"], `${narrator}/compact/${id}`),
	rule("compact-live", ["GET"], `${narrator}/compact/${id}/live`, {
		profile: "sse",
		responseBytes: limits.streamBytes,
	}),
	rule("attachment-upload", ["POST"], `/api/narrator-attachments/${id}`, {
		requestBytes: limits.fileBytes,
	}),
	rule("attachment-cancel", ["DELETE"], `/api/narrator-attachments/${id}/${id}`),
	rule("uploaded-image", ["GET"], `/api/uploads/${id}/${id}`),
	rule("uploaded-media", ["GET"], `/api/uploads/${id}/media/${id}`),
	rule("avatar", ["GET"], `/api/uploads/avatars/${id}/${id}`),
	rule("narrator-websocket", ["GET"], "/ws/narrator"),
];
const compiled = REMOTE_REQUEST_POLICY.map((entry) => ({ entry, pattern: new RegExp(entry.path) }));

/** No percent-encoded separators, normalization, control characters or alternate path spelling. */
export function canonicalRemotePath(input: string): string | null {
	if (
		[...input].some(
			(char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === "#",
		)
	)
		return null;
	const path = input.split("?", 1)[0];
	if (!path.startsWith("/") || path.startsWith("//") || /[\\%]/.test(path)) return null;
	if (path.includes("//") || path.split("/").some((part) => part === "." || part === ".."))
		return null;
	return path;
}
export function resolveRemoteRequestRule(
	method: string,
	input: string,
	phase: RemoteRequestPhase,
): RemoteRequestRule | null {
	const path = canonicalRemotePath(input);
	if (!path || method !== method.toUpperCase()) return null;
	return (
		compiled.find(
			({ entry, pattern }) =>
				entry.methods.includes(method) &&
				(entry.phase === "paired" || phase === "ready") &&
				pattern.test(path),
		)?.entry ?? null
	);
}
