import { z } from "zod";

export const safeId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u);

export const projectId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u);

export const repository = z
  .string()
  .min(3)
  .max(201)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);

export const projectProfileRepository = z
  .string()
  .min(3)
  .max(201)
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    "repository must be an owner/name GitHub repository",
  );

export const gitObjectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

function hasForbiddenGitCharacter(value: string): boolean {
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

export const gitBranch = z
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
      !hasForbiddenGitCharacter(value),
    "invalid Git branch name",
  );

export const projectDefaultBranch = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value, "branch must not have surrounding whitespace")
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !hasForbiddenGitCharacter(value),
    "defaultBranch must be a valid Git branch name",
  );

export const recoveryGitBranch = z
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
      !hasForbiddenGitCharacter(value),
    "invalid recovery branch",
  );

export const looseBranch = z.string().min(1).max(255);

export const workflowEntryPoint = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:/-]*[A-Za-z0-9])?$/u);

export const githubLogin = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u);

export const looseGithubLogin = z.string().min(1).max(100);

export const githubCheckName = z.string().min(1).max(255);

export const projectProfileLabelName = z
  .string()
  .min(1)
  .max(50)
  .refine((value) => value.trim() === value, "label must not have surrounding whitespace")
  .refine(
    (value) =>
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
      }),
    "label must not contain controls",
  );

export const stageLabelName = z
  .string()
  .min(1)
  .max(50)
  .refine((value) => value.trim() === value, "labels must not have surrounding whitespace")
  .refine(
    (value) =>
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
      }),
    "labels must not contain controls",
  );

export const looseLabelName = z.string().min(1).max(50);

export const absolutePath = z
  .string()
  .min(1)
  .max(4_096)
  .startsWith("/")
  .refine((value) => !/[\0\r\n]/u.test(value));
