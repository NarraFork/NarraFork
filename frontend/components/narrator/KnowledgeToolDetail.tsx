import { Anchor, Badge, Box, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import {
	IconChevronRight,
	IconExternalLink,
	IconFolder,
	IconGavel,
	IconKey,
	IconLock,
	IconShieldLock,
	IconTag,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ContentViewer } from "./ContentViewer";
import type { ToolCallData } from "./ToolCallCard";
import { extractField, isTruncated, resolveDisplayText } from "./tool-display";

const codeStyle = { fontSize: 11, maxHeight: 320, overflow: "auto" } as const;

/** Severity → Mantine color for review findings. */
const FINDING_SEVERITY_COLOR: Record<string, string> = {
	critical: "red",
	major: "orange",
	minor: "yellow",
	suggestion: "blue",
};

/** Submission status → Mantine color. */
const SUBMISSION_STATUS_COLOR: Record<string, string> = {
	pending: "yellow",
	approved: "green",
	rejected: "red",
	changes_requested: "orange",
	conflict: "red",
};

/** Pull tool metadata from the persisted output overlay or the live runtime field. */
function readMetadata(toolCall: ToolCallData): Record<string, unknown> {
	const fromOutput =
		toolCall.outputJson &&
		typeof toolCall.outputJson === "object" &&
		!Array.isArray(toolCall.outputJson)
			? (toolCall.outputJson as { _metadata?: unknown })._metadata
			: undefined;
	if (fromOutput && typeof fromOutput === "object") {
		return fromOutput as Record<string, unknown>;
	}
	if (toolCall._metadata && typeof toolCall._metadata === "object") {
		return toolCall._metadata as Record<string, unknown>;
	}
	return {};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

type Json = unknown;

/**
 * Resolve the structured payload of a list/get action. Admin list actions ship
 * the data in `metadata.data`; review list/get only stringify it into output.
 * Returns `{ data }` when structured data is available, or `{ truncated: true }`
 * when the output was truncated (so the caller can fall back to a code block).
 */
function resolveActionData(
	toolCall: ToolCallData,
	meta: Record<string, unknown>,
): {
	data?: Json;
	truncated: boolean;
} {
	if (meta.data !== undefined) return { data: meta.data, truncated: false };
	if (isTruncated(toolCall.outputJson)) return { truncated: true };
	const raw = resolveDisplayText(toolCall.outputJson);
	if (!raw) return { truncated: false };
	try {
		return { data: JSON.parse(raw), truncated: false };
	} catch {
		return { truncated: false };
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** A labeled key/value row used across the structured list renderers. */
function MetaRow({
	icon,
	title,
	badges,
	subtitle,
}: {
	icon: ReactNode;
	title: ReactNode;
	badges?: ReactNode;
	subtitle?: ReactNode;
}) {
	return (
		<Group gap={8} wrap="nowrap" align="flex-start">
			<ThemeIcon size={18} radius="sm" variant="light" color="grape" mt={1}>
				{icon}
			</ThemeIcon>
			<Box style={{ flex: 1, minWidth: 0 }}>
				<Group gap={6} wrap="wrap">
					<Text size="xs" fw={600}>
						{title}
					</Text>
					{badges}
				</Group>
				{subtitle != null && subtitle !== "" && (
					<Text size="xs" c="dimmed" lineClamp={2}>
						{subtitle}
					</Text>
				)}
			</Box>
		</Group>
	);
}

/** Fallback code block used when structured rendering is not possible. */
function ActionJsonFallback({ toolCall, title }: { toolCall: ToolCallData; title: string }) {
	const output = resolveDisplayText(toolCall.outputJson);
	if (!output) return null;
	return <ContentViewer content={output} style={codeStyle} title={title} language="json" />;
}

/** Link to a global knowledge entry detail page. */
function EntryLink({ entryId, title }: { entryId: string; title?: string }) {
	return (
		<Anchor
			component={Link}
			to="/knowledge/$entryId"
			// biome-ignore lint/suspicious/noExplicitAny: TanStack params reducer typing
			params={{ entryId } as any}
			size="xs"
			c="grape"
			style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
		>
			{title || entryId}
			<IconExternalLink size={11} />
		</Anchor>
	);
}

function ErrorLine({ toolCall }: { toolCall: ToolCallData }) {
	if (!toolCall.errorMessage || toolCall.outputJson) return null;
	return (
		<Text size="xs" c="red" mt={4}>
			{toolCall.errorMessage}
		</Text>
	);
}

interface KnowledgeSearchResultMeta {
	id: string;
	title: string;
	snippet: string;
	tags: string[];
	fromDraft: boolean;
	drifted: boolean;
}

function parseSearchResults(meta: Record<string, unknown>): KnowledgeSearchResultMeta[] {
	const raw = meta.results;
	if (!Array.isArray(raw)) return [];
	return raw.map((r) => {
		const row = (r ?? {}) as Record<string, unknown>;
		return {
			id: asString(row.id) ?? "",
			title: asString(row.title) ?? asString(row.id) ?? "",
			snippet: asString(row.snippet) ?? "",
			tags: asStringArray(row.tags),
			fromDraft: row.fromDraft === true,
			drifted: row.drifted === true,
		};
	});
}

function KnowledgeSearchDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("narrator");
	const meta = readMetadata(toolCall);
	const query = extractField(toolCall.inputJson, "query") || asString(meta.query) || "";
	const results = parseSearchResults(meta);
	const raw = resolveDisplayText(toolCall.outputJson);

	return (
		<Box mt="xs">
			{query && (
				<Group gap={6} mb={6}>
					<Badge size="xs" variant="light" color="grape">
						{t("knowledge.search")}
					</Badge>
					<Text size="xs" fw={600}>
						{query}
					</Text>
					<Text size="xs" c="dimmed">
						{t("knowledge.resultCount", { count: results.length })}
					</Text>
				</Group>
			)}
			{results.length > 0 ? (
				<Stack gap={8}>
					{results.map((r, i) => (
						<Box key={r.id || r.title || `result-${i}`}>
							<Group gap={6} wrap="nowrap">
								{r.id ? (
									<EntryLink entryId={r.id} title={r.title} />
								) : (
									<Text size="xs" fw={600}>
										{r.title}
									</Text>
								)}
								{r.fromDraft && (
									<Badge size="xs" variant="light" color={r.drifted ? "orange" : "grape"}>
										{r.drifted ? t("knowledge.behindMain") : t("knowledge.personal")}
									</Badge>
								)}
							</Group>
							{r.tags.length > 0 && (
								<Group gap={4} mt={2}>
									{r.tags.map((tag) => (
										<Badge key={tag} size="xs" variant="dot" color="gray">
											{tag}
										</Badge>
									))}
								</Group>
							)}
							{r.snippet && (
								<Text size="xs" c="dimmed" lineClamp={2} mt={2}>
									{r.snippet}
								</Text>
							)}
						</Box>
					))}
				</Stack>
			) : (
				raw && (
					<ContentViewer
						content={raw}
						style={codeStyle}
						title={query || "KnowledgeSearch"}
						markdown
						contentType="markdown"
					/>
				)
			)}
			<ErrorLine toolCall={toolCall} />
		</Box>
	);
}

function KnowledgeReadDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("narrator");
	const meta = readMetadata(toolCall);
	const entryId = asString(meta.entryId) || extractField(toolCall.inputJson, "entryId");
	const title = asString(meta.title);
	const tags = asStringArray(meta.tags);
	const isDraft = meta.isDraft === true;
	const drift = (meta.drift ?? {}) as { drifted?: boolean; versionsBehind?: number };
	const body = resolveDisplayText(toolCall.outputJson);

	return (
		<Box mt="xs">
			<Group gap={6} mb={6}>
				{entryId ? (
					<EntryLink entryId={entryId} title={title} />
				) : (
					title && (
						<Text size="xs" fw={600}>
							{title}
						</Text>
					)
				)}
				{isDraft && (
					<Badge size="xs" variant="light" color="grape">
						{t("knowledge.personal")}
					</Badge>
				)}
				{drift.drifted && (
					<Badge size="xs" variant="light" color="orange">
						{t("knowledge.behindMain")}
					</Badge>
				)}
			</Group>
			{tags.length > 0 && (
				<Group gap={4} mb={6}>
					{tags.map((tag) => (
						<Badge key={tag} size="xs" variant="dot" color="gray">
							{tag}
						</Badge>
					))}
				</Group>
			)}
			{body && (
				<ContentViewer
					content={body}
					style={{ ...codeStyle, maxHeight: 400 }}
					title={title || "KnowledgeRead"}
					markdown
					contentType="markdown"
				/>
			)}
			<ErrorLine toolCall={toolCall} />
		</Box>
	);
}

function KnowledgeCreateDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("narrator");
	const meta = readMetadata(toolCall);
	const direct = meta.direct === true;
	const entryId = asString(meta.entryId);
	const personalEntryId = asString(meta.personalEntryId);
	const title = extractField(toolCall.inputJson, "title") || asString(meta.title);
	const output = resolveDisplayText(toolCall.outputJson);

	return (
		<Box mt="xs">
			<Group gap={6} mb={6}>
				<Badge size="xs" variant="light" color={direct ? "grape" : "gray"}>
					{direct ? t("knowledge.scopeGlobal") : t("knowledge.scopePersonal")}
				</Badge>
				{entryId ? (
					<EntryLink entryId={entryId} title={title} />
				) : (
					title && (
						<Text size="xs" fw={600}>
							{title}
						</Text>
					)
				)}
				{!entryId && personalEntryId && (
					<Text size="xs" c="dimmed" ff="monospace">
						{personalEntryId}
					</Text>
				)}
			</Group>
			{output && (
				<Text size="xs" c="dimmed">
					{output}
				</Text>
			)}
			<ErrorLine toolCall={toolCall} />
		</Box>
	);
}

function KnowledgeEditDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("narrator");
	const meta = readMetadata(toolCall);
	const action = extractField(toolCall.inputJson, "action") || asString(meta.action) || "edit";
	const entryId = asString(meta.entryId) || extractField(toolCall.inputJson, "entryId");
	const personalEntryId =
		asString(meta.personalEntryId) || extractField(toolCall.inputJson, "personalEntryId");
	const submissionId = asString(meta.submissionId);
	const conflict = meta.conflict === true;
	const rebased = meta.rebased === true;
	const output = resolveDisplayText(toolCall.outputJson);

	return (
		<Box mt="xs">
			<Group gap={6} mb={6}>
				<Badge size="xs" variant="light" color="grape">
					{action}
				</Badge>
				{conflict && (
					<Badge size="xs" variant="light" color="orange">
						{t("knowledge.conflict")}
					</Badge>
				)}
				{action === "rebase" && !conflict && rebased && (
					<Badge size="xs" variant="light" color="teal">
						{t("knowledge.rebased")}
					</Badge>
				)}
				{submissionId && (
					<Text size="xs" c="dimmed" ff="monospace">
						{submissionId}
					</Text>
				)}
				{!submissionId && entryId && <EntryLink entryId={entryId} />}
				{!submissionId && !entryId && personalEntryId && (
					<Text size="xs" c="dimmed" ff="monospace">
						{personalEntryId}
					</Text>
				)}
			</Group>
			{output &&
				(conflict ? (
					<ContentViewer
						content={output}
						style={codeStyle}
						title={`KnowledgeEdit: ${action}`}
						markdown
						contentType="markdown"
					/>
				) : (
					<Text size="xs" c="dimmed">
						{output}
					</Text>
				))}
			<ErrorLine toolCall={toolCall} />
		</Box>
	);
}

/** KnowledgeAdmin: structured rendering for list/get actions + status for writes. */
function KnowledgeAdminDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("narrator");
	const meta = readMetadata(toolCall);
	const action = extractField(toolCall.inputJson, "action") || asString(meta.action) || "";
	const { data, truncated } = resolveActionData(toolCall, meta);
	const rows = Array.isArray(data) ? data : [];

	const header = (
		<Group gap={6} mb={8}>
			<Badge size="xs" variant="light" color="grape" leftSection={<IconChevronRight size={10} />}>
				{action}
			</Badge>
			{Array.isArray(data) && (
				<Text size="xs" c="dimmed">
					{t("knowledge.resultCount", { count: rows.length })}
				</Text>
			)}
		</Group>
	);

	let body: ReactNode = null;
	switch (action) {
		case "list_collections":
			body = (
				<Stack gap={8}>
					{rows.map((r, i) => {
						const c = asRecord(r);
						return (
							<MetaRow
								key={asString(c.id) ?? asString(c.name) ?? `collection-${i}`}
								icon={<IconFolder size={11} />}
								title={asString(c.name) ?? asString(c.slug) ?? "—"}
								badges={
									<Badge size="xs" variant="dot" color="gray">
										{asString(c.defaultLevel) ?? "public"}
									</Badge>
								}
								subtitle={asString(c.description)}
							/>
						);
					})}
				</Stack>
			);
			break;
		case "list_levels":
			body = (
				<Stack gap={8}>
					{rows.map((r, i) => {
						const lv = asRecord(r);
						return (
							<MetaRow
								key={asString(lv.id) ?? asString(lv.name) ?? `level-${i}`}
								icon={<IconLock size={11} />}
								title={asString(lv.label) || asString(lv.name) || "—"}
								badges={
									<>
										<Badge size="xs" variant="light" color="grape">
											rank {typeof lv.rank === "number" ? lv.rank : "?"}
										</Badge>
										<Text size="xs" c="dimmed" ff="monospace">
											{asString(lv.name)}
										</Text>
									</>
								}
							/>
						);
					})}
				</Stack>
			);
			break;
		case "list_tags":
			body = (
				<Stack gap={8}>
					{rows.map((r, i) => {
						const tag = asRecord(r);
						return (
							<MetaRow
								key={asString(tag.id) ?? asString(tag.name) ?? `tag-${i}`}
								icon={<IconTag size={11} />}
								title={asString(tag.name) ?? "—"}
								badges={
									tag.controlled === true ? (
										<Badge size="xs" variant="light" color="orange">
											{t("knowledge.controlled")}
										</Badge>
									) : (
										<Badge size="xs" variant="dot" color="gray">
											{t("knowledge.normalTag")}
										</Badge>
									)
								}
							/>
						);
					})}
				</Stack>
			);
			break;
		case "list_tag_types":
			body = (
				<Stack gap={8}>
					{rows.map((r, i) => {
						const tt = asRecord(r);
						return (
							<MetaRow
								key={asString(tt.id) ?? asString(tt.name) ?? `tagtype-${i}`}
								icon={<IconTag size={11} />}
								title={asString(tt.name) ?? "—"}
								badges={
									tt.builtin === true && (
										<Badge size="xs" variant="dot" color="gray">
											{t("knowledge.builtin")}
										</Badge>
									)
								}
							/>
						);
					})}
				</Stack>
			);
			break;
		case "list_grants":
			body = (
				<Stack gap={8}>
					{rows.map((r, i) => {
						const g = asRecord(r);
						const target =
							asString(g.clearanceLevel) || asString(g.tagId) || asString(g.grantType) || "";
						return (
							<MetaRow
								key={asString(g.id) ?? `grant-${i}`}
								icon={<IconKey size={11} />}
								title={`${asString(g.principalType) ?? "?"}:${asString(g.principalId) ?? "?"}`}
								badges={
									<>
										<Badge size="xs" variant="light" color="grape">
											{asString(g.grantType)}
										</Badge>
										{g.canWrite === true && (
											<Badge size="xs" variant="light" color="teal">
												{t("knowledge.canWrite")}
											</Badge>
										)}
									</>
								}
								subtitle={target}
							/>
						);
					})}
				</Stack>
			);
			break;
		case "get_user_acl": {
			const acl = asRecord(data);
			const tagIds = asStringArray(acl.tagIds);
			const reviewTagIds = asStringArray(acl.reviewTagIds);
			body = (
				<Stack gap={6}>
					<Group gap={6}>
						<IconShieldLock size={13} />
						<Text size="xs" c="dimmed">
							{t("knowledge.clearance")}:
						</Text>
						<Badge size="xs" variant="light" color="grape">
							{asString(acl.clearanceLevel) ?? t("knowledge.none")}
						</Badge>
						{acl.canWrite === true && (
							<Badge size="xs" variant="light" color="teal">
								{t("knowledge.canWrite")}
							</Badge>
						)}
					</Group>
					<Group gap={6}>
						<Text size="xs" c="dimmed">
							{t("knowledge.tags")}:
						</Text>
						{tagIds.length > 0 ? (
							tagIds.map((id) => (
								<Badge key={id} size="xs" variant="dot" color="gray">
									{id}
								</Badge>
							))
						) : (
							<Text size="xs" c="dimmed">
								{t("knowledge.none")}
							</Text>
						)}
					</Group>
					<Group gap={6}>
						<Text size="xs" c="dimmed">
							{t("knowledge.reviewTags")}:
						</Text>
						{reviewTagIds.length > 0 ? (
							reviewTagIds.map((id) => (
								<Badge key={id} size="xs" variant="dot" color="grape">
									{id}
								</Badge>
							))
						) : (
							<Text size="xs" c="dimmed">
								{t("knowledge.none")}
							</Text>
						)}
					</Group>
				</Stack>
			);
			break;
		}
		default: {
			// Write actions (create_*/update_*/delete_*/set_*) return a status line or a single object.
			const output = resolveDisplayText(toolCall.outputJson);
			const looksLikeJson =
				output.trimStart().startsWith("{") || output.trimStart().startsWith("[");
			body =
				output &&
				(looksLikeJson ? (
					<ActionJsonFallback toolCall={toolCall} title={`KnowledgeAdmin: ${action}`} />
				) : (
					<Text size="xs" c="dimmed">
						{output}
					</Text>
				));
		}
	}

	return (
		<Box mt="xs">
			{header}
			{truncated ? (
				<ActionJsonFallback toolCall={toolCall} title={`KnowledgeAdmin: ${action}`} />
			) : (
				body
			)}
			<ErrorLine toolCall={toolCall} />
		</Box>
	);
}

/** Render a single review finding (severity badge + message + optional location). */
function FindingRow({ finding }: { finding: Record<string, unknown> }) {
	const severity = asString(finding.severity) ?? "suggestion";
	const color = FINDING_SEVERITY_COLOR[severity] ?? "gray";
	return (
		<Box>
			<Group gap={6} wrap="nowrap">
				<Badge size="xs" variant="light" color={color}>
					{severity}
				</Badge>
				{asString(finding.location) && (
					<Text size="xs" c="dimmed" ff="monospace">
						{asString(finding.location)}
					</Text>
				)}
			</Group>
			<Text size="xs" mt={2}>
				{asString(finding.message)}
			</Text>
		</Box>
	);
}

/** KnowledgeReview: structured submission lists, submission detail + diff, review verdicts. */
function KnowledgeReviewDetail({ toolCall }: { toolCall: ToolCallData }) {
	const { t } = useTranslation("narrator");
	const meta = readMetadata(toolCall);
	const action = extractField(toolCall.inputJson, "action") || asString(meta.action) || "";
	const submissionId =
		asString(meta.submissionId) || extractField(toolCall.inputJson, "submissionId");

	const statusBadge = (status: string | undefined) =>
		status ? (
			<Badge size="xs" variant="light" color={SUBMISSION_STATUS_COLOR[status] ?? "gray"}>
				{t(`knowledge.submissionStatus_${status}`, { defaultValue: status })}
			</Badge>
		) : null;

	const header = (
		<Group gap={6} mb={8}>
			<Badge size="xs" variant="light" color="grape" leftSection={<IconGavel size={10} />}>
				{action}
			</Badge>
			{submissionId && (
				<Text size="xs" c="dimmed" ff="monospace">
					{submissionId}
				</Text>
			)}
		</Group>
	);

	if (action === "list_submissions") {
		const { data, truncated } = resolveActionData(toolCall, meta);
		const rows = Array.isArray(data) ? data : [];
		return (
			<Box mt="xs">
				{header}
				{truncated ? (
					<ActionJsonFallback toolCall={toolCall} title="KnowledgeReview: list_submissions" />
				) : (
					<Stack gap={8}>
						{rows.map((r, i) => {
							const s = asRecord(r);
							return (
								<MetaRow
									key={asString(s.id) ?? `submission-${i}`}
									icon={<IconGavel size={11} />}
									title={asString(s.title) ?? asString(s.id) ?? "—"}
									badges={statusBadge(asString(s.status))}
									subtitle={asString(s.changeNote)}
								/>
							);
						})}
						{rows.length === 0 && (
							<Text size="xs" c="dimmed">
								{t("knowledge.noSubmissions")}
							</Text>
						)}
					</Stack>
				)}
				<ErrorLine toolCall={toolCall} />
			</Box>
		);
	}

	if (action === "get_submission") {
		const { data, truncated } = resolveActionData(toolCall, meta);
		const s = asRecord(data);
		const diff = asString(s.diff);
		return (
			<Box mt="xs">
				{header}
				{truncated ? (
					<ActionJsonFallback toolCall={toolCall} title="KnowledgeReview: get_submission" />
				) : (
					<Stack gap={8}>
						<MetaRow
							icon={<IconGavel size={11} />}
							title={asString(s.title) ?? asString(s.id) ?? "—"}
							badges={statusBadge(asString(s.status))}
							subtitle={asString(s.changeNote)}
						/>
						{diff && (
							<ContentViewer
								content={diff}
								style={codeStyle}
								title={t("knowledge.diffTitle")}
								language="diff"
								contentType="diff"
							/>
						)}
					</Stack>
				)}
				<ErrorLine toolCall={toolCall} />
			</Box>
		);
	}

	// Write verdicts: approve / request_changes / comment / resolve_conflict.
	const findings = Array.isArray(toolCall.inputJson?.findings)
		? (toolCall.inputJson.findings as Record<string, unknown>[])
		: [];
	const output = resolveDisplayText(toolCall.outputJson);
	const resultStatus = (() => {
		try {
			return asString(asRecord(JSON.parse(output)).status);
		} catch {
			return undefined;
		}
	})();

	return (
		<Box mt="xs">
			<Group gap={6} mb={8}>
				<Badge size="xs" variant="light" color="grape" leftSection={<IconGavel size={10} />}>
					{action}
				</Badge>
				{statusBadge(resultStatus)}
				{submissionId && (
					<Text size="xs" c="dimmed" ff="monospace">
						{submissionId}
					</Text>
				)}
			</Group>
			{findings.length > 0 && (
				<Stack gap={6} mb={6}>
					<Text size="xs" fw={500}>
						{t("knowledge.findings")}
					</Text>
					{findings.map((f, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: findings have no stable id
						<FindingRow key={i} finding={f} />
					))}
				</Stack>
			)}
			{output && !resultStatus && (
				<Text size="xs" c="dimmed">
					{output}
				</Text>
			)}
			<ErrorLine toolCall={toolCall} />
		</Box>
	);
}

/** Detail renderer for the knowledge-base tool family. */
export function KnowledgeDetail({ toolCall }: { toolCall: ToolCallData }) {
	switch (toolCall.toolName) {
		case "KnowledgeSearch":
			return <KnowledgeSearchDetail toolCall={toolCall} />;
		case "KnowledgeRead":
			return <KnowledgeReadDetail toolCall={toolCall} />;
		case "KnowledgeCreate":
			return <KnowledgeCreateDetail toolCall={toolCall} />;
		case "KnowledgeEdit":
			return <KnowledgeEditDetail toolCall={toolCall} />;
		case "KnowledgeReview":
			return <KnowledgeReviewDetail toolCall={toolCall} />;
		default:
			// KnowledgeAdmin
			return <KnowledgeAdminDetail toolCall={toolCall} />;
	}
}
