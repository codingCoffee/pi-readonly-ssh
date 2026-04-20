import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";

export interface CommandRule {
	name: string;
	subcommands?: string[];
	banned_flags?: string[];
	banned_args_regex?: string[];
	max_args?: number;
	allow_globs?: boolean;
}

export interface HostEntry {
	name: string;
	ssh: string;
}

export interface Settings {
	strict_mode: boolean;
	max_output_bytes: number;
	default_timeout_sec: number;
	allow_globs: boolean;
	audit_log: string | null;
	allow_any_host: boolean;
}

export interface Config {
	settings: Settings;
	hosts: HostEntry[];
	commands: CommandRule[];
	/** absolute path to the YAML this came from */
	path: string;
}

const DEFAULT_SETTINGS: Settings = {
	strict_mode: false,
	max_output_bytes: 1024 * 1024,
	default_timeout_sec: 30,
	allow_globs: true,
	audit_log: null,
	allow_any_host: false,
};

function expandHome(p: string | null | undefined): string | null {
	if (!p) return null;
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	if (p === "~") return homedir();
	return p;
}

/**
 * Candidate config paths in priority order (first hit wins).
 *
 * 1. $READONLY_SSH_CONFIG                             (explicit override)
 * 2. ./.pi/readonly-ssh/commands.yaml                 (project-local, CWD-relative)
 * 3. $XDG_CONFIG_HOME/pi-readonly-ssh/commands.yaml   (per-user, fallback ~/.config/...)
 * 4. <extensionDir>/commands.yaml                     (bundled default shipped in the npm tarball)
 *
 * If none of 1–3 exist, the bundled default at (4) is used read-only. Users
 * who want to customize the policy create a file at (2) or (3) themselves.
 */
export function getCandidateConfigPaths(extensionDir: string): string[] {
	const candidates: string[] = [];

	const envPath = process.env.READONLY_SSH_CONFIG;
	if (envPath && envPath.trim().length > 0) {
		candidates.push(resolve(expandHome(envPath) ?? envPath));
	}

	candidates.push(resolve(process.cwd(), ".pi", "readonly-ssh", "commands.yaml"));

	candidates.push(resolve(xdgConfigHome(), "pi-readonly-ssh", "commands.yaml"));

	candidates.push(resolve(extensionDir, "commands.yaml"));

	return candidates;
}

function xdgConfigHome(): string {
	const x = process.env.XDG_CONFIG_HOME;
	if (x && x.trim().length > 0) return x;
	return resolve(homedir(), ".config");
}

/**
 * Resolve which commands.yaml to actually read. Returns the first candidate
 * that exists on disk. Falls back to the bundled default, which is guaranteed
 * to exist because it ships in the npm tarball.
 */
export function resolveConfigPath(extensionDir: string): string {
	for (const p of getCandidateConfigPaths(extensionDir)) {
		if (existsSync(p)) return p;
	}
	// Unreachable in practice — the bundled default always exists. Keep a
	// sensible fallback anyway.
	return resolve(extensionDir, "commands.yaml");
}

export function loadConfig(configPath: string): Config {
	if (!existsSync(configPath)) {
		throw new Error(`readonly-ssh: config not found at ${configPath}`);
	}
	const raw = readFileSync(configPath, "utf8");
	let parsed: any;
	try {
		parsed = YAML.parse(raw);
	} catch (e) {
		throw new Error(`readonly-ssh: failed to parse ${configPath}: ${(e as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`readonly-ssh: ${configPath} is empty or invalid`);
	}

	const settings: Settings = { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) };
	settings.audit_log = expandHome(settings.audit_log as any);

	const hosts: HostEntry[] = Array.isArray(parsed.hosts) ? parsed.hosts : [];
	for (const h of hosts) {
		if (!h || typeof h.name !== "string" || typeof h.ssh !== "string") {
			throw new Error(`readonly-ssh: invalid host entry in ${configPath}: ${JSON.stringify(h)}`);
		}
	}

	const commands: CommandRule[] = Array.isArray(parsed.commands) ? parsed.commands : [];
	for (const c of commands) {
		if (!c || typeof c.name !== "string") {
			throw new Error(`readonly-ssh: invalid command entry in ${configPath}: ${JSON.stringify(c)}`);
		}
	}

	// Ensure audit log dir exists (best-effort)
	if (settings.audit_log) {
		try {
			mkdirSync(dirname(settings.audit_log), { recursive: true });
		} catch {
			/* ignore */
		}
	}

	return { settings, hosts, commands, path: configPath };
}


