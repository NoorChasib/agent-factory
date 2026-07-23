import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkerResult, WorkerTerminalStatusSchema } from "../src/contracts/worker-result";
import { loadFactoryConfiguration, resolveXdgPaths } from "../src/operations/runtime";
import { InMemoryFileSystemAdapter } from "../src/testing";

const repositoryRoot = join(import.meta.dir, "..");
const exampleRoot = join(repositoryRoot, "config", "examples", "multi-project");
const protocolRoot = join(repositoryRoot, "config", "protocol", "worker-result", "v1");

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("shipped configuration examples", () => {
  test("loads the exact multi-project config and profiles through the production validator", async () => {
    const paths = resolveXdgPaths({
      XDG_CONFIG_HOME: "/fixture/config",
      XDG_STATE_HOME: "/fixture/state",
      XDG_DATA_HOME: "/fixture/data",
    });
    const fileSystem = new InMemoryFileSystemAdapter();
    fileSystem.put(paths.configFile, source(join(exampleRoot, "config.yaml")), {
      kind: "file",
      mode: 0o100600,
    });
    for (const name of ["hhc-aep.yaml", "lumen-notes.yaml"]) {
      fileSystem.put(
        join(paths.profilesDirectory, name),
        source(join(exampleRoot, "profiles", name)),
        {
          kind: "file",
          mode: 0o100600,
        },
      );
    }

    const loaded = await loadFactoryConfiguration(paths, fileSystem);

    expect(loaded.profiles.map((profile) => profile.id)).toEqual(["hhc-aep", "lumen-notes"]);
    expect(loaded.profiles.map((profile) => profile.enabled)).toEqual([false, false]);
    expect(loaded.profiles[0]).toMatchObject({
      repository: "NoorChasib/HHC-AEP",
      defaultBranch: "main",
      issueSelection: {
        owner: "project-workflow",
        controllerProvidesIssueNumber: false,
      },
    });
    expect(loaded.profiles[1]).toMatchObject({
      repository: "ExampleOrg/lumen-notes",
      defaultBranch: "trunk",
    });
    expect(fileSystem.readCount).toBe(3);
  });
});

describe("shipped worker-result protocol fixtures", () => {
  test("parses one version-1 JSON example for every terminal status", () => {
    const expected: ReadonlyMap<string, (typeof WorkerTerminalStatusSchema.options)[number]> =
      new Map([
        ["blocked.json", "blocked"],
        ["completed.json", "completed"],
        ["failed.json", "failed"],
        ["operator-required.json", "operator_required"],
        ["provider-limit.json", "provider_limit"],
        ["stalled.json", "stalled"],
      ]);

    const observed = readdirSync(protocolRoot)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const parsed = parseWorkerResult(JSON.parse(source(join(protocolRoot, name))) as unknown);
        const expectedStatus = expected.get(name);
        if (expectedStatus === undefined) {
          throw new Error(`unexpected shipped protocol fixture '${name}'`);
        }
        expect(parsed.terminalStatus).toBe(expectedStatus);
        return parsed.terminalStatus;
      });

    expect(new Set(observed)).toEqual(new Set(WorkerTerminalStatusSchema.options));
    expect(observed).toHaveLength(WorkerTerminalStatusSchema.options.length);
  });

  test("rejects every shipped malformed or untrusted JSON example", () => {
    const invalidRoot = join(protocolRoot, "invalid");
    const names = readdirSync(invalidRoot)
      .filter((name) => name.endsWith(".json"))
      .sort();

    expect(names).toEqual([
      "inconsistent-pull-request.json",
      "unknown-field.json",
      "unknown-status.json",
      "unversioned.json",
    ]);
    for (const name of names) {
      expect(() =>
        parseWorkerResult(JSON.parse(source(join(invalidRoot, name))) as unknown),
      ).toThrow();
    }
  });
});
