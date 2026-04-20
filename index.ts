/**
 * readonly-ssh
 *
 * A pi extension that gives the LLM a new `ssh_exec` tool to run strictly
 * allow-listed, read-only commands on remote hosts over SSH.
 *
 * The allowlist lives in `commands.yaml` next to this file. Edit it and run
 * `/ssh-reload` to apply changes without restarting pi.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, resolveConfigPath, type Config } from "./src/config.js";
import { runSelfTests } from "./src/selftest.js";
import { registerSshExecTool } from "./src/tool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
	// Pick up whichever config file wins the priority chain. If the user has
	// not created their own override, this falls through to the bundled default
	// inside the installed package (read-only, but functional).
	let configPath = resolveConfigPath(__dirname);
	let config: Config = loadConfig(configPath);
	let savedActiveTools: string[] | null = null;
	let enabled = true;

	const applyToolState = () => {
		if (!enabled) {
			// Extension disabled: hide ssh_exec, and restore bash if strict mode
			// had previously removed it.
			if (savedActiveTools !== null) {
				pi.setActiveTools(savedActiveTools.filter((n) => n !== "ssh_exec"));
				savedActiveTools = null;
			} else {
				pi.setActiveTools(pi.getActiveTools().filter((n) => n !== "ssh_exec"));
			}
			return;
		}
		if (config.settings.strict_mode) {
			if (savedActiveTools === null) {
				savedActiveTools = pi.getActiveTools();
			}
			const filtered = pi.getAllTools()
				.map((t) => t.name)
				.filter((n) => n !== "bash");
			pi.setActiveTools(filtered);
		} else if (savedActiveTools !== null) {
			pi.setActiveTools(savedActiveTools);
			savedActiveTools = null;
		}
	};
	const applyStrictMode = applyToolState;

	registerSshExecTool(pi, () => config);

	pi.on("session_start", async (_event, ctx) => {
		// Self-test on load so misconfigurations are loud.
		const failures = runSelfTests(config);
		if (failures.length > 0) {
			ctx.ui.notify(
				`readonly-ssh: ${failures.length} self-test failure(s) — a dangerous command may be slipping through your allowlist. Run /ssh-reload for details.`,
				"warning",
			);
			for (const f of failures.slice(0, 5)) {
				console.warn(`[readonly-ssh] selftest: ${f}`);
			}
		}

		applyStrictMode();

		const hostCount = config.hosts.length;
		const cmdCount = config.commands.length;
		const hostBadge = config.settings.allow_any_host
			? `${hostCount} named + any`
			: `${hostCount} host${hostCount === 1 ? "" : "s"}`;
		ctx.ui.setStatus(
			"readonly-ssh",
			ctx.ui.theme.fg(
				"accent",
				`ro-ssh: ${cmdCount} cmds, ${hostBadge}${config.settings.strict_mode ? " [strict]" : ""}${enabled ? "" : " [off]"}`,
			),
		);

		if (hostCount === 0 && !config.settings.allow_any_host) {
			ctx.ui.notify(
				`readonly-ssh: no hosts configured. Edit ${configPath} and run /ssh-reload.`,
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		// Restore tools we disabled in strict mode, best-effort.
		if (savedActiveTools !== null) {
			try {
				pi.setActiveTools(savedActiveTools);
			} catch {
				/* ignore */
			}
		}
	});

	pi.registerCommand("ssh-allowed", {
		description: "List commands the readonly-ssh extension permits",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			lines.push(`readonly-ssh allowlist  (${config.commands.length} commands)`);
			lines.push(config.path);
			lines.push("");
			// Pad command names for alignment.
			const nameWidth = Math.min(
				16,
				config.commands.reduce((w, c) => Math.max(w, c.name.length), 0),
			);
			for (const c of config.commands) {
				const parts: string[] = [];
				if (c.subcommands?.length) parts.push(`sub: ${c.subcommands.join("|")}`);
				if (c.banned_flags?.length) parts.push(`banned: ${c.banned_flags.join(" ")}`);
				if (typeof c.max_args === "number") parts.push(`max_args=${c.max_args}`);
				const name = c.name.padEnd(nameWidth);
				lines.push(parts.length ? `  ${name}  ${parts.join("  ")}` : `  ${name}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("ssh-hosts", {
		description: "List hosts the readonly-ssh extension may target",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			const hostCount = config.hosts.length;
			const header = config.settings.allow_any_host
				? `readonly-ssh hosts  (${hostCount} named + any allowed)`
				: `readonly-ssh hosts  (${hostCount} host${hostCount === 1 ? "" : "s"})`;
			lines.push(header);
			lines.push(config.path);
			lines.push("");

			if (hostCount > 0) {
				const nameWidth = config.hosts.reduce((w, h) => Math.max(w, h.name.length), 0);
				lines.push("  Named hosts:");
				for (const h of config.hosts) {
					lines.push(`    • ${h.name.padEnd(nameWidth)}  →  ${h.ssh}`);
				}
				lines.push("");
			} else {
				lines.push("  (no named hosts configured)");
				lines.push("");
			}

			if (config.settings.allow_any_host) {
				lines.push("  allow_any_host = true");
				lines.push("    → any ssh target (user@host, host, or ~/.ssh/config alias) is accepted.");
			} else {
				lines.push("  allow_any_host = false");
				lines.push("    → only the named hosts above are accepted.");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("ssh-toggle", {
		description: "Enable/disable the readonly-ssh extension at runtime (usage: /ssh-toggle [on|off])",
		handler: async (args, ctx) => {
			const arg = (Array.isArray(args) ? args[0] : args)?.toString().trim().toLowerCase();
			let target: boolean;
			if (arg === "on" || arg === "enable" || arg === "enabled" || arg === "true" || arg === "1") {
				target = true;
			} else if (arg === "off" || arg === "disable" || arg === "disabled" || arg === "false" || arg === "0") {
				target = false;
			} else if (!arg) {
				target = !enabled;
			} else {
				ctx.ui.notify(`readonly-ssh: unknown argument '${arg}'. Use /ssh-toggle [on|off]`, "error");
				return;
			}
			if (target === enabled) {
				ctx.ui.notify(`readonly-ssh already ${enabled ? "enabled" : "disabled"}.`, "info");
				return;
			}
			enabled = target;
			applyToolState();
			const badge = config.settings.allow_any_host
				? `${config.hosts.length} named + any`
				: `${config.hosts.length} hosts`;
			ctx.ui.setStatus(
				"readonly-ssh",
				ctx.ui.theme.fg(
					"accent",
					`ro-ssh: ${config.commands.length} cmds, ${badge}${config.settings.strict_mode ? " [strict]" : ""}${enabled ? "" : " [off]"}`,
				),
			);
			if (enabled) {
				ctx.ui.notify(
					`readonly-ssh enabled: ssh_exec is active${config.settings.strict_mode ? " and bash is disabled (strict mode)" : ""}.`,
					"success",
				);
			} else {
				ctx.ui.notify(
					"readonly-ssh disabled: ssh_exec removed from active tools. bash restored if it was gated by strict mode.",
					"warning",
				);
			}
		},
	});

	pi.registerCommand("ssh-reload", {
		description: "Re-read the readonly-ssh YAML allowlist",
		handler: async (_args, ctx) => {
			try {
				// Re-resolve in case the user just created a higher-priority file
				// (e.g. a new ./.pi/readonly-ssh/commands.yaml).
				configPath = resolveConfigPath(__dirname);
				config = loadConfig(configPath);
			} catch (e) {
				ctx.ui.notify(`readonly-ssh: reload failed: ${(e as Error).message}`, "error");
				return;
			}
			const failures = runSelfTests(config);
			applyStrictMode();
			const badge = config.settings.allow_any_host
				? `${config.hosts.length} named + any`
				: `${config.hosts.length} hosts`;
			ctx.ui.setStatus(
				"readonly-ssh",
				ctx.ui.theme.fg(
					"accent",
					`ro-ssh: ${config.commands.length} cmds, ${badge}${config.settings.strict_mode ? " [strict]" : ""}${enabled ? "" : " [off]"}`,
				),
			);
			if (failures.length > 0) {
				ctx.ui.notify(
					`readonly-ssh reloaded, but ${failures.length} self-test failure(s). See console.`,
					"warning",
				);
				for (const f of failures) console.error(`[readonly-ssh] selftest: ${f}`);
			} else {
				ctx.ui.notify(
					`readonly-ssh reloaded: ${config.commands.length} cmds, ${config.hosts.length} host(s). Self-tests passed.`,
					"success",
				);
			}
		},
	});
}
