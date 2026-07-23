import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type WorkerCommandSpawner,
	type WorkerCommandSpawnInput,
	workerCommandMain,
} from "../src/daemon/worker-command";

class RecordingSpawner implements WorkerCommandSpawner {
	public input: WorkerCommandSpawnInput | null = null;
	public stdin: string | null = null;

	public spawn(input: WorkerCommandSpawnInput) {
		this.input = structuredClone(input);
		return {
			processId: 404,
			writeStdin: async (stdin: string): Promise<void> => {
				this.stdin = stdin;
			},
			wait: async () => ({
				exitCode: 0,
				stdout: "worker output",
				stderr: "",
			}),
			kill: (_signal: "SIGINT" | "SIGTERM"): void => {},
		};
	}
}

const signals = {
	once(_signal: "SIGINT" | "SIGTERM", _listener: () => void): void {},
	off(_signal: "SIGINT" | "SIGTERM", _listener: () => void): void {},
};

describe("worker command wrapper", () => {
	test("spawns with exactly the specification environment and never inherits wrapper poison", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-factory-worker-command-"));
		const poisonName = "AGENT_FACTORY_WRAPPER_POISON_SENTINEL";
		const previousPoison = Bun.env[poisonName];
		Bun.env[poisonName] = "must-not-reach-worker";
		try {
			const specificationPath = join(directory, "execution-1-1.spec.json");
			const resultPath = join(directory, "execution-1-1.json");
			writeFileSync(
				specificationPath,
				JSON.stringify({
					schemaVersion: 1,
					executable: "provider-cli",
					argv: ["--structured-output"],
					cwd: directory,
					env: {
						GH_TOKEN: "ghs_specification-token",
						PATH: "/usr/bin",
					},
					stdin: "workflow prompt from specification",
					resultPath,
				}),
				{ mode: 0o600 },
			);
			chmodSync(specificationPath, 0o600);
			const spawner = new RecordingSpawner();

			expect(
				await workerCommandMain(
					["bun", "/factory/bin/worker-command.ts", specificationPath],
					spawner,
					signals,
				),
			).toBe(0);

			expect(spawner.input).toEqual({
				executable: "provider-cli",
				argv: ["--structured-output"],
				cwd: directory,
				env: {
					GH_TOKEN: "ghs_specification-token",
					PATH: "/usr/bin",
				},
			});
			expect(spawner.input?.env[poisonName]).toBeUndefined();
			expect(spawner.stdin).toBe("workflow prompt from specification");
			expect(existsSync(specificationPath)).toBe(false);
			expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
				status: "exited",
				exitCode: 0,
				stdout: "worker output",
				stderr: "",
				processId: 404,
			});
		} finally {
			if (previousPoison === undefined) {
				delete Bun.env[poisonName];
			} else {
				Bun.env[poisonName] = previousPoison;
			}
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("deletes an owner-only specification that fails validation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-factory-worker-command-"));
		try {
			const specificationPath = join(directory, "execution-1-1.spec.json");
			writeFileSync(specificationPath, JSON.stringify({ schemaVersion: 1, invalid: true }), {
				mode: 0o600,
			});
			chmodSync(specificationPath, 0o600);

			expect(
				await workerCommandMain(
					["bun", "/factory/bin/worker-command.ts", specificationPath],
					new RecordingSpawner(),
					signals,
				),
			).toBe(64);
			expect(existsSync(specificationPath)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
