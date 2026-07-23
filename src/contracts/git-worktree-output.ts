import { z } from "zod";

function forbiddenGitCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      "~^:?*[\\\\".includes(character)
    );
  });
}

export const GitBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value.trim() === value &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !forbiddenGitCharacter(value),
    "invalid Git branch name",
  );

const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

interface ParsedWorktree {
  path: string;
  branch: string | null;
  headSha: string | null;
  bare: boolean;
  unsafe: boolean;
}

export interface ParsedGitWorktree {
  readonly path: string;
  readonly branch: string;
  readonly headSha: string;
}

export function parseGitWorktreePorcelain(input: string): readonly ParsedGitWorktree[] {
  if (input.length > 10 * 1_024 * 1_024) {
    throw new Error("Git worktree output exceeds 10 MiB");
  }
  const records: ParsedWorktree[] = [];
  let current: ParsedWorktree | null = null;
  const finish = (): void => {
    if (current !== null) {
      if (records.length >= 10_000) {
        throw new Error("Git worktree output contains too many records");
      }
      records.push(current);
      current = null;
    }
  };
  for (const line of `${input}\n`.split(/\r?\n/u)) {
    if (line.length === 0) {
      finish();
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1);
    if (key === "worktree") {
      finish();
      current = {
        path: value,
        branch: null,
        headSha: null,
        bare: false,
        unsafe: false,
      };
    } else if (current !== null && key === "HEAD") {
      if (current.headSha !== null) {
        throw new Error("Git worktree output repeats HEAD");
      }
      current.headSha = value;
    } else if (current !== null && key === "branch") {
      if (current.branch !== null) {
        throw new Error("Git worktree output repeats branch");
      }
      current.branch = value.replace(/^refs\/heads\//u, "");
    } else if (current !== null && key === "bare") {
      if (current.bare) {
        throw new Error("Git worktree output repeats bare");
      }
      current.bare = true;
    } else if (current !== null && (key === "detached" || key === "locked" || key === "prunable")) {
      current.unsafe = true;
    } else {
      throw new Error(`Git worktree output contains unknown field '${key}'`);
    }
  }
  return records.flatMap((record): ParsedGitWorktree[] => {
    if (record.unsafe) {
      throw new Error("Git worktree output contains an unsafe worktree state");
    }
    if (record.bare) {
      return [];
    }
    return [
      {
        path: z
          .string()
          .startsWith("/")
          .refine((path) => !/[\0\r\n]/u.test(path))
          .parse(record.path),
        branch: GitBranchSchema.parse(record.branch),
        headSha: gitObjectId.parse(record.headSha),
      },
    ];
  });
}
