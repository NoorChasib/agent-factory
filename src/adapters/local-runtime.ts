import { Database } from "bun:sqlite";
import type { Stats } from "node:fs";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { statfs } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
	DiskUsage,
	DiskUsageAdapter,
	DoctorSystemAdapter,
	FileMetadata,
	RuntimeFileSystemAdapter,
} from "@/adapters/interfaces.ts";

function fileKind(value: Stats): FileMetadata["kind"] {
	if (value.isFile()) {
		return "file";
	}
	if (value.isDirectory()) {
		return "directory";
	}
	if (value.isSymbolicLink()) {
		return "symbolic-link";
	}
	return "other";
}

function metadata(path: string): FileMetadata {
	const value = lstatSync(path);
	return {
		kind: fileKind(value),
		mode: value.mode,
	};
}

export class LocalRuntimeFileSystemAdapter implements RuntimeFileSystemAdapter {
	public async stat(path: string): Promise<FileMetadata> {
		return metadata(path);
	}

	public async readText(path: string): Promise<string> {
		return readFileSync(path, "utf8");
	}

	public async ensureDirectory(path: string, mode: number): Promise<void> {
		mkdirSync(path, { recursive: true, mode });
		chmodSync(path, mode);
	}

	public async listFiles(path: string): Promise<readonly string[]> {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => join(path, entry.name))
			.sort();
	}
}

export class LocalDiskUsageAdapter implements DiskUsageAdapter {
	public async usage(path: string): Promise<DiskUsage> {
		const value = await statfs(path);
		const totalBytes = Number(value.blocks * value.bsize);
		const availableBytes = Number(value.bavail * value.bsize);
		return { usedBytes: totalBytes - availableBytes, totalBytes };
	}
}

const VERSION_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
	bun: ["--version"],
	claude: ["--version"],
	codex: ["--version"],
	gh: ["--version"],
	git: ["--version"],
	herdr: ["--version"],
};

export class LocalDoctorSystemAdapter implements DoctorSystemAdapter {
	readonly #environment: Readonly<Record<string, string | undefined>>;
	readonly #systemdUserDirectory: string;
	readonly #workingDirectory: string;

	public constructor(
		options: {
			readonly environment?: Readonly<Record<string, string | undefined>>;
			readonly systemdUserDirectory?: string;
			readonly workingDirectory?: string;
		} = {},
	) {
		this.#environment = options.environment ?? Bun.env;
		this.#systemdUserDirectory =
			options.systemdUserDirectory ??
			join(
				this.#environment.XDG_CONFIG_HOME ?? join(this.#environment.HOME ?? "", ".config"),
				"systemd",
				"user",
			);
		this.#workingDirectory = options.workingDirectory ?? dirname(import.meta.dir);
	}

	public async binaryVersion(name: string): Promise<string | null> {
		const argv = VERSION_ARGUMENTS[name];
		if (argv === undefined) {
			return null;
		}
		try {
			const process = Bun.spawn([name, ...argv], {
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: this.#environment.PATH ?? "" },
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				process.exited,
				new Response(process.stdout).text(),
				new Response(process.stderr).text(),
			]);
			if (exitCode !== 0) {
				return null;
			}
			return (stdout.trim() || stderr.trim()).split(/\r?\n/u)[0]?.slice(0, 500) ?? null;
		} catch {
			return null;
		}
	}

	public async socketReachable(path: string): Promise<boolean> {
		try {
			const response = await fetch("http://localhost/health", { unix: path });
			return response.ok;
		} catch {
			return false;
		}
	}

	public async systemdUnitPresent(unitName: string): Promise<boolean> {
		const roots = [
			this.#systemdUserDirectory,
			"/usr/lib/systemd/user",
			"/usr/local/lib/systemd/user",
		];
		return roots.some((root) => existsSync(join(root, basename(unitName))));
	}

	public async ledgerSchemaVersion(path: string): Promise<number | null> {
		if (!existsSync(path) || !statSync(path).isFile()) {
			return null;
		}
		let database: Database | null = null;
		try {
			database = new Database(path, { readonly: true, strict: true });
			const row = database
				.query<{ version: number | null }, []>(
					"SELECT MAX(version) AS version FROM schema_migrations",
				)
				.get();
			return row?.version ?? null;
		} catch {
			return null;
		} finally {
			database?.close();
		}
	}

	public async liveProbe(
		provider: "claude" | "codex" | "github",
	): Promise<{ readonly ok: boolean; readonly detail: string }> {
		const probes = {
			github: { command: ["gh", "api", "rate_limit"], stdin: "" },
			claude: {
				command: [
					"claude",
					"--print",
					"--output-format",
					"json",
					"Reply with exactly: agent-factory-doctor-ok",
				],
				stdin: "",
			},
			codex: {
				command: [
					"codex",
					"exec",
					"--json",
					"--sandbox",
					"read-only",
					"--skip-git-repo-check",
					"-",
				],
				stdin: "Reply with exactly: agent-factory-doctor-ok",
			},
		};
		const probe = probes[provider];
		try {
			const process = Bun.spawn(probe.command, {
				stdout: "pipe",
				stderr: "pipe",
				stdin: "pipe",
				env: { ...this.#environment },
				cwd: this.#workingDirectory,
			});
			process.stdin.write(probe.stdin);
			await process.stdin.end();
			const [exitCode] = await Promise.all([
				process.exited,
				new Response(process.stdout).text(),
				new Response(process.stderr).text(),
			]);
			return {
				ok: exitCode === 0,
				detail:
					exitCode === 0 ? `${provider} live probe succeeded` : `${provider} live probe failed`,
			};
		} catch {
			return { ok: false, detail: `${provider} live probe unavailable` };
		}
	}
}
