#!/usr/bin/env bun

import { resolve } from "node:path";

import { BunCommandAdapter } from "../adapters/bun-command";
import { LocalRuntimeFileSystemAdapter } from "../adapters/local-runtime";
import { CryptoIdSource, SystemClockAdapter } from "../adapters/operations";
import {
  LocalFactoryReleaseBuildAdapter,
  LocalReleaseFileSystemAdapter,
  SqliteReleaseLedgerAdapter,
} from "../adapters/releases";
import { commandEnvironment, initialObservationState } from "../daemon/composition";
import { openSqliteLedger } from "../ledger";
import {
  loadFactoryConfiguration,
  prepareXdgDirectories,
  resolveXdgPaths,
} from "../operations/runtime";
import { ReleaseBootstrapper } from "../releases/bootstrap";
import { ReleaseBuilder } from "../releases/builder";
import { ReleaseStore } from "../releases/store";

export async function bootstrapReleaseMain(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<void> {
  const commitSha = argv[0];
  if (commitSha === undefined || argv.length !== 1) {
    throw new Error("usage: bun run bootstrap -- <factory-commit-sha>");
  }

  const paths = resolveXdgPaths(environment);
  const runtimeFiles = new LocalRuntimeFileSystemAdapter();
  await prepareXdgDirectories(paths, runtimeFiles);
  const configuration = await loadFactoryConfiguration(paths, runtimeFiles);
  const clock = new SystemClockAdapter();
  const ids = new CryptoIdSource();
  const ledger = openSqliteLedger({
    stateDirectory: paths.stateDirectory,
    instanceId: `bootstrap-${process.pid}`,
    clock,
    ids,
    initialState: initialObservationState(configuration.profiles),
  });
  try {
    const releaseFiles = new LocalReleaseFileSystemAdapter();
    const store = new ReleaseStore({
      root: paths.releaseDirectory,
      fileSystem: releaseFiles,
      clock,
      ids,
    });
    await store.prepare();
    const sourceRepository =
      environment.AGENT_FACTORY_SOURCE_REPOSITORY ?? resolve(import.meta.dir, "..", "..");
    const commandEnv = commandEnvironment(environment);
    const builder = new ReleaseBuilder({
      builds: new LocalFactoryReleaseBuildAdapter({
        commands: new BunCommandAdapter(),
        repositoryRoot: sourceRepository,
        checkoutRoot: paths.releaseBuildDirectory,
        environment: commandEnv,
      }),
      store,
    });
    const result = await new ReleaseBootstrapper({
      builder,
      store,
      ledger: new SqliteReleaseLedgerAdapter({
        ledger,
        backupDirectory: paths.releaseBackupDirectory,
      }),
    }).bootstrap(commitSha);
    process.stdout.write(
      `${JSON.stringify(
        {
          releaseId: result.releaseId,
          currentReleaseId: result.currentReleaseId,
          alreadyInstalled: result.alreadyInstalled,
          mode: "observation",
          rolloutStage: "observation",
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    ledger.close();
  }
}

if (import.meta.main) {
  try {
    await bootstrapReleaseMain(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Agent Factory bootstrap failed"}\n`,
    );
    process.exitCode = 1;
  }
}
