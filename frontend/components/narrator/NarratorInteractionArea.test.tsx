import { expect, mock, test } from "bun:test";
import type { CSSProperties, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { returnFromModelTrace } from "./interaction/model-trace-return";
import type { NarratorInteractionAreaProps } from "./NarratorInteractionArea";

const returnButton: { click: () => void } = {
	click: () => {
		throw new Error("Return button was not rendered");
	},
};

const MenuStub = Object.assign(({ children }: { children?: ReactNode }) => <div>{children}</div>, {
	Target: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	Dropdown: () => null,
	Item: () => null,
});
mock.module("@mantine/core", () => ({
	Menu: MenuStub,
	ActionIcon: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
	Box: ({ children, ...props }: React.ComponentProps<"div">) => <div {...props}>{children}</div>,
	Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
	Stack: ({ children, style }: { children?: ReactNode; style?: CSSProperties }) => (
		<div data-region="queue" style={style}>
			{children}
		</div>
	),
	Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
	Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => {
		if (onClick) returnButton.click = onClick;
		return <button type="button">{children}</button>;
	},
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let resizeEnabled = false;
mock.module("../../hooks/useLocalPref", () => ({
	useLocalPref: () => [resizeEnabled, () => {}],
}));
mock.module("../../hooks/useResizableBottomSpacing", () => ({
	useBottomSpacing: () => 0,
	startBottomSpacingResize: () => {},
}));
mock.module("./panels/compact-context", () => ({ useNarratorPanelCompact: () => false }));
mock.module("./interaction/use-status-bar-props", () => ({ useStatusBarProps: () => ({}) }));
mock.module("./interaction/use-queued-message-actions", () => ({
	useQueuedMessageActions: () => ({}),
}));
mock.module("./header/NarratorGitBar", () => ({
	NarratorGitBar: () => <div data-region="git" />,
}));
mock.module("./interaction/QueuedMessageRow", () => ({
	QueuedMessageRow: () => null,
	QueuedAttachmentPreview: () => null,
}));
mock.module("./interaction/NarratorInteractionStatusBar", () => ({
	NarratorInteractionStatusBar: () => <div data-region="status" />,
}));
mock.module("./interaction/PendingAgentMessagesPanel", () => ({
	PendingAgentMessagesPanel: () => null,
}));
mock.module("./interaction/UploadProgressBar", () => ({
	UploadProgressBar: () => <div data-region="upload" />,
}));
mock.module("./composer/NarratorComposerRow", () => ({
	NarratorComposerRow: (props: { attachedImages: File[]; attachedTextFiles: File[] }) => (
		<div
			data-region="composer"
			data-images={props.attachedImages.length}
			data-files={props.attachedTextFiles.length}
		/>
	),
}));
mock.module("./permission/PermissionRuleResultNotice", () => ({
	PermissionRulePolicySync: () => null,
}));
const { NarratorInteractionArea } = await import("./NarratorInteractionArea");

function renderModelTraceReturn(options: Parameters<typeof returnFromModelTrace>[0]) {
	returnButton.click = () => {
		throw new Error("Return button was not rendered");
	};
	// No editable props are supplied: the modeltrace branch must not mount them or their hooks.
	const props = {
		onModelTraceReturn: () => returnFromModelTrace(options),
	} as NarratorInteractionAreaProps;
	const html = renderToStaticMarkup(<NarratorInteractionArea {...props} />);
	expect(html).toContain("modelTraceReturn");
	expect(html.match(/<button/g)).toHaveLength(1);
	expect(html).not.toContain("data-region");
	returnButton.click();
}

test("modeltrace return closes exactly its desktop dock panel without navigating to its parent", () => {
	const closeTrace = mock(() => {});
	const navigateToNarrator = mock(() => {});
	const navigateToDefault = mock(() => {});
	renderModelTraceReturn({
		narrator: { parentNarratorId: "source" },
		onClose: closeTrace,
		navigateToNarrator,
		navigateToDefault,
	});
	expect(closeTrace).toHaveBeenCalledTimes(1);
	expect(navigateToNarrator).not.toHaveBeenCalled();
	expect(navigateToDefault).not.toHaveBeenCalled();
});

test("modeltrace return on mobile without a dock navigates to the source narrator", () => {
	const navigateToNarrator = mock((_id: string) => {});
	const navigateToDefault = mock(() => {});
	renderModelTraceReturn({
		narrator: { parentNarratorId: "source" },
		navigateToNarrator,
		navigateToDefault,
	});
	expect(navigateToNarrator).toHaveBeenCalledWith("source");
	expect(navigateToDefault).not.toHaveBeenCalled();
});

test("modeltrace return respects authorized navigation metadata and deleted-parent fallback", () => {
	const navigateToNarrator = mock((_id: string) => {});
	const navigateToDefault = mock(() => {});
	renderModelTraceReturn({
		narrator: {
			parentNarratorId: "deleted-source",
			navigationSummary: { parentNarratorId: null },
		},
		navigateToNarrator,
		navigateToDefault,
	});
	expect(navigateToNarrator).not.toHaveBeenCalled();
	expect(navigateToDefault).toHaveBeenCalledTimes(1);
});

test("passes image/file resources into the composer without an external attachment strip", () => {
	// Control hooks and leaf panels are mocked: only the real area's composition is under test.
	const props = {
		common: { narratorId: "n", isWorkspacePreview: false },
		onOpenGitPanel: () => {},
		attachedImages: [new File(["image"], "image.png")],
		attachedTextFiles: [new File(["text"], "notes.txt")],
		queueDeps: { queuedMessages: [{}, {}, {}] },
		statusBarInputs: {},
		composerRowProps: {},
		sendingState: { attachmentCount: 2, progress: 50, canCancel: true },
	} as unknown as NarratorInteractionAreaProps;
	const html = renderToStaticMarkup(<NarratorInteractionArea {...props} />);
	const regions = [...html.matchAll(/data-region="([^"]+)"/g)].map((match) => match[1]);
	expect(regions).toEqual(["queue", "git", "status", "upload", "composer"]);
	expect(html).not.toContain('data-region="attachments"');
	expect(html).not.toContain('role="separator"');
	expect(html).not.toContain("ns-resize");
	expect(html).toContain("pointer-events:none");
	resizeEnabled = true;
	try {
		const enabledHtml = renderToStaticMarkup(<NarratorInteractionArea {...props} />);
		expect(enabledHtml).toContain('role="separator"');
		expect(enabledHtml).toContain("cursor:ns-resize");
	} finally {
		resizeEnabled = false;
	}
	expect(html).toContain('data-images="1"');
	expect(html).toContain('data-files="1"');
	expect(html).toContain(
		'data-region="queue" style="border-top:1px solid var(--mantine-color-default-border)',
	);
});
