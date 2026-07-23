import type { ClockAdapter } from "../adapters/interfaces";
import type { GitHubMutationLedger } from "../github";
import type { MutationRecord, MutationState, NewMutation } from "../ledger";
import { MutationRecordSchema, NewMutationSchema } from "../ledger";

export interface MutationIdAdapter {
  nextMutationId(): string;
}

function clone<T>(input: T): T {
  return structuredClone(input);
}

function timestamp(clock: ClockAdapter): string {
  const now = clock.now();
  if (Number.isNaN(now.getTime())) {
    throw new Error("in-memory mutation ledger clock returned an invalid date");
  }
  return now.toISOString();
}

function allowedTransition(current: MutationState, next: MutationState): boolean {
  switch (current) {
    case "pending":
      return next === "applied" || next === "ambiguous" || next === "reconciled";
    case "applied":
      return next === "ambiguous" || next === "reconciled";
    case "ambiguous":
      return next === "reconciled";
    case "reconciled":
      return false;
  }
}

export class InMemoryGitHubMutationLedger implements GitHubMutationLedger {
  readonly #clock: ClockAdapter;
  readonly #ids: MutationIdAdapter;
  readonly #records: MutationRecord[] = [];

  public constructor(clock: ClockAdapter, ids: MutationIdAdapter) {
    this.#clock = clock;
    this.#ids = ids;
  }

  public recordMutation(input: NewMutation): MutationRecord {
    const parsed = NewMutationSchema.parse(clone(input));
    const existing = this.#records.find(
      (record) => record.idempotencyKey === parsed.idempotencyKey,
    );
    if (existing !== undefined) {
      if (
        JSON.stringify(parsed) !==
        JSON.stringify({
          projectId: existing.projectId,
          executionId: existing.executionId,
          kind: existing.kind,
          subjectType: existing.subjectType,
          subjectNumber: existing.subjectNumber,
          intendedMutation: existing.intendedMutation,
          idempotencyKey: existing.idempotencyKey,
        })
      ) {
        throw new Error("idempotency key identifies a different mutation");
      }
      return clone(existing);
    }
    const at = timestamp(this.#clock);
    const record = MutationRecordSchema.parse({
      ...parsed,
      mutationId: this.#ids.nextMutationId(),
      state: "pending",
      result: null,
      createdAt: at,
      updatedAt: at,
    });
    this.#records.push(record);
    return clone(record);
  }

  public transitionMutation(
    mutationId: string,
    nextState: MutationState,
    result: unknown = null,
  ): MutationRecord {
    const index = this.#records.findIndex((record) => record.mutationId === mutationId);
    const current = this.#records[index];
    if (index < 0 || current === undefined) {
      throw new Error(`unknown mutation '${mutationId}'`);
    }
    if (!allowedTransition(current.state, nextState)) {
      throw new Error(`invalid mutation transition ${current.state} -> ${nextState}`);
    }
    const updated = MutationRecordSchema.parse({
      ...current,
      state: nextState,
      result,
      updatedAt: timestamp(this.#clock),
    });
    this.#records[index] = updated;
    return clone(updated);
  }

  public listMutations(states?: readonly MutationState[]): readonly MutationRecord[] {
    const selected = states === undefined ? null : new Set(states);
    return this.#records
      .filter((record) => selected === null || selected.has(record.state))
      .map(clone);
  }
}
