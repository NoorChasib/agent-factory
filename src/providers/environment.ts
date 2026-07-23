const INHERITED_WORKER_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "TERM",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
] as const;

function validEnvironmentValue(value: string): boolean {
  return value.length <= 32_768 && !/[\0\r\n]/u.test(value);
}

export function buildWorkerEnvironment(
  controllerEnvironment: Readonly<Record<string, string | undefined>>,
  shortLivedGitHubToken: string,
): Readonly<Record<string, string>> {
  if (
    shortLivedGitHubToken.length === 0 ||
    shortLivedGitHubToken.length > 4_096 ||
    !validEnvironmentValue(shortLivedGitHubToken)
  ) {
    throw new Error("short-lived GitHub token is invalid");
  }

  const environment: Record<string, string> = {};
  for (const key of INHERITED_WORKER_ENVIRONMENT_KEYS) {
    const value = controllerEnvironment[key];
    if (value === undefined) {
      continue;
    }
    if (!validEnvironmentValue(value)) {
      throw new Error(`worker environment value '${key}' is invalid`);
    }
    environment[key] = value;
  }
  environment.GH_PROMPT_DISABLED = "1";
  environment.GH_TOKEN = shortLivedGitHubToken;
  environment.GITHUB_TOKEN = shortLivedGitHubToken;
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}
