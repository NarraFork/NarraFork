import {
	closeSearchPanel,
	findNext,
	findPrevious,
	getSearchQuery,
	replaceAll,
	replaceNext,
	SearchQuery,
	selectMatches,
	setSearchQuery,
} from "@codemirror/search";
import { type EditorView, type Panel, runScopeHandlers } from "@codemirror/view";
import { ActionIcon, Box, Button, Checkbox, Group, Stack, TextInput, Tooltip } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconSearch, IconSelectAll, IconX } from "@tabler/icons-react";
import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

export interface EditorSearchPanelState {
	dom: HTMLElement;
	view: EditorView;
	query: SearchQuery;
	readOnly: boolean;
}

/** CodeMirror owns search state and shortcuts; React supplies our themed UI via a portal. */
export function createEditorSearchPanel(
	view: EditorView,
	publish: (panel: EditorSearchPanelState | null) => void,
): Panel {
	const dom = view.dom.ownerDocument.createElement("div");
	dom.dataset.editorSearchPanel = "true";
	let query = getSearchQuery(view.state);
	let readOnly = view.state.readOnly;
	const notify = () => publish({ dom, view, query, readOnly });
	dom.addEventListener("keydown", (event) => {
		// Composition Enter commits the IME candidate, never a match or replacement.
		if (event.isComposing || event.keyCode === 229) return;
		if (runScopeHandlers(view, event, "search-panel")) {
			event.preventDefault();
			event.stopPropagation();
		} else if (event.key === "Enter") {
			const target = event.target as HTMLElement | null;
			if (target?.hasAttribute("main-field")) {
				event.preventDefault();
				event.stopPropagation();
				(event.shiftKey ? findPrevious : findNext)(view);
			} else if (target?.hasAttribute("data-replace-field") && !view.state.readOnly) {
				event.preventDefault();
				event.stopPropagation();
				replaceNext(view);
			}
		}
	});
	return {
		dom,
		top: true,
		mount: notify,
		update(update) {
			const nextQuery = getSearchQuery(update.state);
			// Cursor, highlight and document changes don't rerender the search form.
			if (nextQuery === query && update.state.readOnly === readOnly) return;
			query = nextQuery;
			readOnly = update.state.readOnly;
			notify();
		},
		destroy: () => publish(null),
	};
}

export function EditorSearchPanel({ view, query, readOnly }: EditorSearchPanelState) {
	const { t } = useTranslation("narrator");
	const phrases = t("fileEditor.searchPhrases", { returnObjects: true }) as Record<string, string>;
	const label = (key: string) => phrases[key] ?? key;
	const input = useRef<HTMLInputElement>(null);
	useLayoutEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	const invalidQuery = !!query.search && !query.valid;
	// The portal commits after CodeMirror measured the initially empty panel.
	// biome-ignore lint/correctness/useExhaustiveDependencies: these UI changes alter panel height after CodeMirror's own update.
	useLayoutEffect(() => {
		view.requestMeasure();
	}, [view, readOnly, invalidQuery, t]);

	const change = (
		patch: Partial<
			Pick<SearchQuery, "search" | "replace" | "caseSensitive" | "regexp" | "wholeWord">
		>,
	) => {
		view.dispatch({
			effects: setSearchQuery.of(new SearchQuery({ ...getSearchQuery(view.state), ...patch })),
		});
	};

	return (
		<Box
			p="xs"
			role="search"
			aria-label={t("fileEditor.search")}
			style={{
				background: "var(--mantine-color-body)",
				color: "var(--mantine-color-text)",
				fontFamily: "var(--mantine-font-family)",
				borderBottom: "1px solid var(--mantine-color-default-border)",
			}}
		>
			<Stack gap="xs">
				<Group gap={4} wrap="nowrap" align="flex-start">
					<TextInput
						ref={input}
						size="xs"
						name="search"
						main-field="true"
						aria-label={label("Find")}
						placeholder={label("Find")}
						leftSection={<IconSearch size={14} />}
						value={query.search}
						onChange={(event) => change({ search: event.currentTarget.value })}
						error={invalidQuery ? t("fileEditor.searchInvalidRegex") : undefined}
						style={{ flex: 1, minWidth: 0 }}
					/>
					<Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
						<Tooltip label={label("previous")} openDelay={200}>
							<ActionIcon
								variant="subtle"
								size="sm"
								aria-label={label("previous")}
								disabled={!query.valid}
								onClick={() => findPrevious(view)}
							>
								<IconArrowUp size={14} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={label("next")} openDelay={200}>
							<ActionIcon
								variant="subtle"
								size="sm"
								aria-label={label("next")}
								disabled={!query.valid}
								onClick={() => findNext(view)}
							>
								<IconArrowDown size={14} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={label("all")} openDelay={200}>
							<ActionIcon
								variant="subtle"
								size="sm"
								aria-label={label("all")}
								disabled={!query.valid}
								onClick={() => selectMatches(view)}
							>
								<IconSelectAll size={14} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={label("close")} openDelay={200}>
							<ActionIcon
								variant="subtle"
								size="sm"
								color="gray"
								aria-label={label("close")}
								onClick={() => closeSearchPanel(view)}
							>
								<IconX size={14} />
							</ActionIcon>
						</Tooltip>
					</Group>
				</Group>
				<Group gap="sm">
					<Checkbox
						size="xs"
						label={label("match case")}
						checked={query.caseSensitive}
						onChange={(event) => change({ caseSensitive: event.currentTarget.checked })}
					/>
					<Checkbox
						size="xs"
						label={label("by word")}
						checked={query.wholeWord}
						onChange={(event) => change({ wholeWord: event.currentTarget.checked })}
					/>
					<Checkbox
						size="xs"
						label={label("regexp")}
						checked={query.regexp}
						onChange={(event) => change({ regexp: event.currentTarget.checked })}
					/>
				</Group>
				{!readOnly && (
					<Group gap={4}>
						<TextInput
							size="xs"
							name="replace"
							data-replace-field="true"
							aria-label={label("Replace")}
							placeholder={label("Replace")}
							value={query.replace}
							onChange={(event) => change({ replace: event.currentTarget.value })}
							style={{ flex: "1 1 120px", minWidth: 0 }}
						/>
						<Group gap={4} wrap="nowrap">
							<Button
								size="compact-xs"
								variant="default"
								disabled={!query.valid}
								onClick={() => replaceNext(view)}
							>
								{label("replace")}
							</Button>
							<Button
								size="compact-xs"
								variant="light"
								disabled={!query.valid}
								onClick={() => replaceAll(view)}
							>
								{label("replace all")}
							</Button>
						</Group>
					</Group>
				)}
			</Stack>
		</Box>
	);
}
