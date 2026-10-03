import { expect, mock, test } from "bun:test";
import type { CSSProperties, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NarratorInteractionAreaProps } from "./NarratorInteractionArea";

mock.module("@mantine/core", () => ({
	Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
mock.module("../../hooks/useResizableBottomSpacing", () => ({
	useBottomSpacing: () => 0,
	startBottomSpacingResize: () => {},
}));
mock.module("./panels/compact-context", () => ({ useNarratorPanelCompact: () => false }));
mock.module("./interaction/use-status-bar-props", () => ({ useStatusBarProps: () => ({}) }));
mock.module("./interaction/use-queued-message-actions", () => ({
	useQueuedMessageActions: () => ({}),
}));
mock.module("./header/ChapterBar", () => ({
	ChapterBar: () => <div data-region="git" />,
	NarratorGitBar: () => <div data-region="git" />,
}));
mock.module("./interaction/QueuedMessageRow", () => ({
	QueuedMessageRow: () => null,
	QueuedAttachmentPreview: () => null,
}));
mock.module("./interaction/NarratorInteractionStatusBar", () => ({
	NarratorInteractionStatusBar: () => <div data-region="status" />,
}));
mock.module("./interaction/AttachmentPreviews", () => ({
	AttachmentPreviews: ({
		attachedImages,
		attachedTextFiles,
	}: {
		attachedImages: File[];
		attachedTextFiles: File[];
	}) => (
		<div
			data-region="attachments"
			data-images={attachedImages.length}
			data-files={attachedTextFiles.length}
		/>
	),
}));
mock.module("./interaction/UploadProgressBar", () => ({
	UploadProgressBar: () => <div data-region="upload" />,
}));
mock.module("./composer/NarratorComposerRow", () => ({
	NarratorComposerRow: () => <div data-region="composer" />,
}));
mock.module("./permission/PermissionRuleResultNotice", () => ({
	PermissionRuleResultNotice: () => null,
}));
const { NarratorInteractionArea } = await import("./NarratorInteractionArea");

for (const chapterId of ["chapter", null]) {
	test(`${chapterId ? "chapter" : "standalone"} places image/file previews below status and immediately above composer`, () => {
		// Control hooks and leaf panels are mocked: only the real area's composition is under test.
		const props = {
			common: { narratorId: "n", isWorkspacePreview: false },
			chapterId,
			onOpenGitPanel: () => {},
			attachedImages: [new File(["image"], "image.png")],
			attachedTextFiles: [new File(["text"], "notes.txt")],
			queueDeps: { queuedMessages: [{}, {}, {}] },
			statusBarInputs: {},
			composerRowProps: {},
			sendingState: { attachmentCount: 2, progress: 50, canCancel: true },
			isChapterMerged: false,
		} as unknown as NarratorInteractionAreaProps;
		const html = renderToStaticMarkup(<NarratorInteractionArea {...props} />);
		const regions = [...html.matchAll(/data-region="([^"]+)"/g)].map((match) => match[1]);
		expect(regions).toEqual(["queue", "git", "status", "attachments", "upload", "composer"]);
		expect(html).toContain('data-images="1"');
		expect(html).toContain('data-files="1"');
		expect(html).toContain(
			'data-region="queue" style="border-top:1px solid var(--mantine-color-default-border)',
		);
	});
}
