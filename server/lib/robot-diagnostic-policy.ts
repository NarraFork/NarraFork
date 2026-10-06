import { normalizeExecutionPolicyRuleSet } from "@server/services/execution-policy/normalize";
import type {
	ExecutionPolicyRuleSet,
	LegacyExecutionPolicyRuleSet,
} from "@server/services/execution-policy/types";

/**
 * Read-only allow-list preset for robot field diagnostics.
 *
 * Why this exists: an external diagnostic narrator runs under bypassPermissions, where every
 * command the risk engine cannot classify as read-only is routed into the danger reflection
 * loop. Reflection is a separate LLM turn, so a field engineer walking through dozens of
 * inspection commands (`systemctl is-active`, `journalctl -u …`, `ss -tlnH`, `ping` a lidar)
 * would pay one extra round trip per command and the session becomes unusable.
 *
 * Every entry below is taken from the Lynx diagnostic knowledge base — the commands its
 * skills actually run (lynx-info / svcmon / netdiag / cfgcheck / logcollect / snapshot) and
 * the paths they actually read on AOS/GOS/NOS.
 *
 * Rules for editing this file:
 * - Only read-only forms. Patterns are token-prefix matched with per-token `*` globbing
 *   (see execution-policy/command-policy.ts), so `systemctl is-active *` admits exactly that
 *   subcommand while `systemctl restart …` stays outside the allow-list.
 * - Never add a bare `<tool> *` for a tool that also mutates state (`systemctl`, `ip`,
 *   `sysctl`). Enumerate the read-only subcommands instead.
 * - `sudo` is deliberately absent: prefix matching means `sudo journalctl …` starts with the
 *   `sudo` token and matches nothing here, so privileged variants keep their review.
 * - Directory rules grant `readOnly` only, so writes under these paths are never admitted by
 *   this preset.
 */

/** Read-only command forms, as token-prefix patterns. */
export const ROBOT_DIAGNOSTIC_COMMAND_WHITELIST: readonly string[] = [
	// ── Services and processes ─────────────────────────────
	// Only the inspecting subcommands; start/stop/restart/enable/disable/mask are excluded.
	"systemctl is-active *",
	"systemctl is-enabled *",
	"systemctl is-failed *",
	"systemctl status *",
	"systemctl show *",
	"systemctl cat *",
	"systemctl list-units *",
	"systemctl list-unit-files *",
	// journalctl is a reader except for its journal maintenance flags (`--rotate`, `--flush`,
	// `--vacuum-*`, `--sync`) which delete or roll log data. Since a prefix match cannot
	// exclude a later flag, the read intent is pinned by the first argument.
	"journalctl -u *",
	"journalctl --unit *",
	"journalctl -n *",
	"journalctl --lines *",
	"journalctl -f",
	"journalctl -k *",
	"journalctl -b *",
	"journalctl -p *",
	"journalctl -e",
	"journalctl -r *",
	"journalctl -x *",
	"journalctl --since *",
	"journalctl --until *",
	"journalctl --no-pager *",
	"journalctl --list-boots",
	"journalctl --disk-usage",
	"coredumpctl list",
	"coredumpctl list *",
	"pgrep *",
	"ps",
	"ps *",

	// ── Network ───────────────────────────────────────────
	// `ip` mixes inspection and mutation under the same objects, and matching is a token
	// *prefix* match: a bare `ip link` entry would also admit `ip link set eth0 down`, and a
	// trailing `ip link *` would admit `ip link delete veth0`. So the read verb is always
	// pinned as the final literal token, and the bare `ip <object>` form is deliberately
	// absent — callers must write the explicit `show`/`list` form.
	"ip addr show",
	"ip addr show *",
	"ip addr list",
	"ip addr list *",
	"ip link show",
	"ip link show *",
	"ip link list",
	"ip link list *",
	"ip route show",
	"ip route show *",
	"ip route list",
	"ip route list *",
	"ip route get *",
	"ip neigh show",
	"ip neigh show *",
	"ip neigh list",
	"ip neigh list *",
	// Option-first forms used by the diagnostic scripts (`ip -j addr show`, `ip -s link show`).
	"ip -j addr show",
	"ip -j addr show *",
	"ip -j link show",
	"ip -j link show *",
	"ip -j route show",
	"ip -j route show *",
	"ip -s link show",
	"ip -s link show *",
	"ip -br addr show",
	"ip -br link show",
	"ifconfig",
	"arp -n",
	"route -n",
	// `ss -K/--kill` force-closes sockets, which would cut live robot connections, so the
	// read flags are pinned rather than allowing a bare `ss`.
	"ss -t *",
	"ss -tl *",
	"ss -tln *",
	"ss -tlnH",
	"ss -tlnp",
	"ss -tu *",
	"ss -tul *",
	"ss -tuln",
	"ss -tulpn",
	"ss -u *",
	"ss -a *",
	"ss -s",
	"ss -l *",
	"ss -n *",
	"ss -p *",
	// netstat only exposes display options, so the bare form is safe. A pattern's `*` must
	// consume a token, hence both entries.
	"netstat",
	"netstat *",
	// `-c` is required so a probe cannot ping forever and stall the session.
	"ping -c *",
	"ping6 -c *",
	"nc -z *",
	"traceroute *",
	"tracepath *",

	// ── Time synchronization ──────────────────────────────
	// A bare `timedatectl` entry would prefix-match `timedatectl set-ntp true`, so only the
	// reading subcommands are listed.
	"timedatectl status",
	"timedatectl show",
	"timedatectl show *",
	"timedatectl list-timezones",
	"chronyc tracking",
	"chronyc sources",
	"chronyc sources *",
	"chronyc sourcestats",
	"ntpq -p",

	// ── System and resources ──────────────────────────────
	"uptime",
	"free",
	"free *",
	"df",
	"df *",
	"du *",
	"vmstat",
	"vmstat *",
	"iostat",
	"iostat *",
	"mpstat",
	"mpstat *",
	"lsblk",
	"lsblk *",
	"lsusb",
	"lsusb *",
	"lspci",
	"lspci *",
	"lscpu",
	"lsmod",
	"lsof *",
	// `dmesg` reads, but `-C` / `--clear` / `-c` wipe the kernel ring buffer, destroying
	// evidence a later diagnostic step may need. Pin the read flags instead of a bare entry.
	"dmesg -T",
	"dmesg -T *",
	"dmesg -H",
	"dmesg -H *",
	"dmesg -l *",
	"dmesg --level *",
	"dmesg -k",
	"dmesg -x",
	"dmesg --time-format *",
	"getprop",
	"getprop *",
	// Reading forms only; `sysctl -w` and `sysctl key=value` are excluded.
	"sysctl -a",
	"sysctl -n *",

	// ── Misc read-only inspection ─────────────────────────
	"strings *",
	"readlink -f *",
	"stat *",
];

/**
 * Paths the diagnostic flow reads on the robot hosts. Granted read-only.
 *
 * `/dev` is intentionally absent: the camera-node checks in the knowledge base run on the
 * engineer's machine via Python `Path().exists()`, not as a shell read on the robot, so
 * there is no shell-side need to widen it.
 */
export const ROBOT_DIAGNOSTIC_READONLY_DIRS: readonly string[] = [
	// System configuration: netplan, hosts, resolv.conf, os-release, systemd units.
	"/etc",
	// Kernel pseudo-filesystems: cpuinfo, uptime, loadavg, device enumeration.
	"/proc",
	"/sys",
	"/var/log",
	// Robot business logs, including system/*.csv and the lidar driver log.
	"/var/opt/robot/log",
	// Robot identity: MFI.toml, HWI.toml, host_name.
	"/var/opt/robot/conf",
	// Navigation maps (NOS).
	"/var/opt/robot/data/maps",
	"/etc/opt/robot",
	// Robot program tree: version, git_commit, rl_deploy/conf, share/*, lidar/*.
	"/opt/robot",
	// Per-subsystem yaml/toml configuration.
	"/etc/robot",
	"/run/systemd",
];

/**
 * The preset as a legacy rule-set input, ready for normalization.
 *
 * pathFlavor is pinned to posix: the robot hosts are Linux, and the compiler drops rules
 * whose flavor does not match the target, so this cannot leak onto a Windows target.
 */
function robotDiagnosticLegacyRuleSet(): LegacyExecutionPolicyRuleSet {
	return {
		commandWhitelist: ROBOT_DIAGNOSTIC_COMMAND_WHITELIST.map((pattern) => ({
			pattern,
			enabled: true,
		})),
		whitelistDirs: ROBOT_DIAGNOSTIC_READONLY_DIRS.map((path) => ({
			path,
			accessLevel: "readOnly" as const,
			pathFlavor: "posix" as const,
			enabled: true,
		})),
	};
}

/**
 * Normalized preset rules, merged as an extra allow-list layer when an OAuth client opts in
 * via policy.allowRobotDiagnosticPreset. Reported under the "global" source because it is
 * instance-level trusted configuration, not per-narrator user input.
 */
export function robotDiagnosticRuleSet(): ExecutionPolicyRuleSet {
	return normalizeExecutionPolicyRuleSet(robotDiagnosticLegacyRuleSet(), "global");
}
