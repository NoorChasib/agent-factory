import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";

import {
  GITHUB_APP_ID_ENVIRONMENT,
  GITHUB_APP_PRIVATE_KEY_FILE_ENVIRONMENT,
  GitHubAppTokenBroker,
  GitHubAppTokenBrokerError,
  parseGitHubAppEnvironment,
  parseProjectProfile,
  parseProjectProfileYaml,
} from "../src";
import {
  FixedClockAdapter,
  InMemoryFileSystemAdapter,
  ScriptedGitHubTransport,
} from "../src/testing";

const profile = parseProjectProfileYaml(
  await Bun.file(new URL("fixtures/profiles/lumen-notes.yaml", import.meta.url)).text(),
);
const installation = await Bun.file(
  new URL("fixtures/github/installation.json", import.meta.url),
).text();
const installationToken = await Bun.file(
  new URL("fixtures/github/installation-token.json", import.meta.url),
).text();
const credentialPath = "/run/credentials/agent-factory/github-app.pem";
const environment = {
  [GITHUB_APP_ID_ENVIRONMENT]: "1234",
  [GITHUB_APP_PRIVATE_KEY_FILE_ENVIRONMENT]: credentialPath,
};

function response(status: number, body: string) {
  return {
    kind: "response" as const,
    response: {
      status,
      headers: {},
      body,
    },
  };
}

describe("GitHub App token broker", () => {
  test("signs an RS256 App JWT, mints reduced target-only credentials, and caches them", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
    });
    const privateKeyPem = privateKey
      .export({
        type: "pkcs8",
        format: "pem",
      })
      .toString();
    const fileSystem = new InMemoryFileSystemAdapter({
      [credentialPath]: {
        content: privateKeyPem,
        metadata: { kind: "file", mode: 0o400 },
      },
    });
    const transport = new ScriptedGitHubTransport([
      response(200, installation),
      response(201, installationToken),
    ]);
    const broker = new GitHubAppTokenBroker({
      environment,
      profiles: [profile],
      fileSystem,
      clock: new FixedClockAdapter(),
      transport,
      apiUrl: "https://api.github.test",
    });

    expect(await broker.tokenForProject(profile.id)).toBe("fixture-installation-token");
    expect(await broker.tokenForProject(profile.id)).toBe("fixture-installation-token");
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]?.url).toBe(
      "https://api.github.test/repos/ExampleOrg/lumen-notes/installation",
    );
    expect(transport.requests[1]?.url).toBe(
      "https://api.github.test/app/installations/7001/access_tokens",
    );
    expect(JSON.parse(transport.requests[1]?.body ?? "{}")).toEqual({
      repositories: ["lumen-notes"],
      permissions: {
        administration: "read",
        checks: "read",
        issues: "write",
        metadata: "read",
        pull_requests: "read",
        statuses: "read",
      },
    });

    const authorization = transport.requests[0]?.headers.authorization ?? "";
    const jwt = authorization.replace(/^Bearer /u, "");
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toEqual({
      iat: 1_784_764_740,
      exp: 1_784_765_340,
      iss: "1234",
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
    expect(JSON.stringify(transport.requests)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(transport.requests)).not.toContain(privateKeyPem);
    expect(fileSystem.readCount).toBe(1);
  });

  test("never resolves installations for a target that is not explicitly enabled", async () => {
    const disabled = parseProjectProfile({
      ...profile,
      enabled: false,
    });
    const broker = new GitHubAppTokenBroker({
      environment,
      profiles: [disabled],
      fileSystem: new InMemoryFileSystemAdapter(),
      clock: new FixedClockAdapter(),
      transport: new ScriptedGitHubTransport(),
      apiUrl: "https://api.github.test",
    });

    await expect(broker.tokenForProject(disabled.id)).rejects.toThrow("not explicitly enabled");
  });

  test("redacts invalid private-key contents and rejects PEM-in-environment configuration", async () => {
    const secretSentinel = "PEM-SECRET-SENTINEL";
    const fileSystem = new InMemoryFileSystemAdapter({
      [credentialPath]: {
        content: `-----BEGIN PRIVATE KEY-----\n${secretSentinel}\n-----END PRIVATE KEY-----`,
        metadata: { kind: "file", mode: 0o400 },
      },
    });
    const broker = new GitHubAppTokenBroker({
      environment,
      profiles: [profile],
      fileSystem,
      clock: new FixedClockAdapter(),
      transport: new ScriptedGitHubTransport(),
      apiUrl: "https://api.github.test",
    });

    try {
      await broker.tokenForProject(profile.id);
      throw new Error("expected invalid private key to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubAppTokenBrokerError);
      expect(String(error)).not.toContain(secretSentinel);
      expect(String(error)).not.toContain("BEGIN PRIVATE KEY");
    }
    expect(() =>
      parseGitHubAppEnvironment({
        [GITHUB_APP_ID_ENVIRONMENT]: "1234",
        [GITHUB_APP_PRIVATE_KEY_FILE_ENVIRONMENT]: "-----BEGIN PRIVATE KEY-----\nsecret",
      }),
    ).toThrow("credential-file path");
  });
});
