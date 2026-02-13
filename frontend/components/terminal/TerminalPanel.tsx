import { Box } from "@mantine/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { useTerminalWS } from "../../hooks/useTerminalWS";

interface TerminalPanelProps {
	terminalId: string;
}

export function TerminalPanel({ terminalId }: TerminalPanelProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);

	const { write, resize } = useTerminalWS(terminalId, {
		onOutput: (data) => {
			termRef.current?.write(data);
		},
		onExit: (code) => {
			termRef.current?.write(`\r\n[Process exited with code ${code}]\r\n`);
		},
		onError: (message) => {
			termRef.current?.write(`\r\n[Error: ${message}]\r\n`);
		},
	});

	useEffect(() => {
		if (!containerRef.current) return;

		const term = new Terminal({
			cursorBlink: true,
			fontSize: 14,
			fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
			theme: {
				background: "#1a1b26",
				foreground: "#c0caf5",
				cursor: "#c0caf5",
			},
		});
		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.open(containerRef.current);
		fitAddon.fit();

		termRef.current = term;
		fitAddonRef.current = fitAddon;

		term.onData((data) => write(data));

		const resizeObserver = new ResizeObserver(() => {
			fitAddon.fit();
			resize(term.cols, term.rows);
		});
		resizeObserver.observe(containerRef.current);

		return () => {
			resizeObserver.disconnect();
			term.dispose();
			termRef.current = null;
			fitAddonRef.current = null;
		};
	}, [write, resize]);

	return <Box ref={containerRef} h="100%" style={{ backgroundColor: "#1a1b26", padding: 4 }} />;
}
