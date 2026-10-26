import { expect, mock, test } from "bun:test";
import type { CSSProperties, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NarratorInteractionAreaProps } from "./NarratorInteractionArea";

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
	Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
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
