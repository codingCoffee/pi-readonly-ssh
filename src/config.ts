import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
};

function expandHome(p: string | null | undefined): string | null {
	if (!p) return null;
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	if (p === "~") return homedir();
	return p;
}

/**
 * Resolve which commands.yaml to use.
 * Priority: project `.pi/extensions/readonly-ssh/commands.yaml`
 *           -> global `~/.pi/agent/extensions/readonly-ssh/commands.yaml`
 *
 * The caller (extension entry) passes both candidate dirs (via import.meta.dirname
 * of wherever the extension itself was loaded from). We keep logic simple: just
 * use a single path next to index.ts. pi auto-discovery already scopes that.
 */
export function resolveConfigPath(extensionDir: string): string {
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

/** Write a fresh default config if one doesn't already exist. */
export function ensureConfig(configPath: string, defaultYaml: string): void {
	if (existsSync(configPath)) return;
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, defaultYaml, "utf8");
}
