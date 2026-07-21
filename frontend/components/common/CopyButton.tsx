import type { ReactNode } from "react";
import { useClipboard } from "../../hooks/useClipboard";

export interface CopyButtonProps {
	children: (payload: { copied: boolean; copy: () => void }) => ReactNode;
	value: string;
	timeout?: number;
}

export function CopyButton({ children, value, timeout = 1000 }: CopyButtonProps) {
	const clipboard = useClipboard({ timeout });
	return <>{children({ copied: clipboard.copied, copy: () => clipboard.copy(value) })}</>;
}
