import { z } from "zod";

// What a task promises and how it is judged. A contract only names verifiers: the approved implementation
// is looked up by id and must match the pinned digest. The schema has nowhere to put code, so the model
// being judged can't supply the check that judges it.

const Name = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/, "Use lowercase letters, digits, . _ and -");

/** Policies name the task classes they allow and the capabilities they need in the same words contracts do. */
export const TaskClassSchema = Name;
export const CapabilityNameSchema = Name;

/** The approved verifier and the digest of the definition it was approved at. */
export const VerifierRefSchema = z.strictObject({
  id: Name,
  digest: z.string().regex(/^[a-f0-9]{64}$/, "A SHA-256 hex digest"),
});
export type VerifierRef = z.infer<typeof VerifierRefSchema>;

export const SIDE_EFFECTS = [
  "none",
  "workspace_files",
  "memory_write",
  "network_read",
  "network_write",
  "external_message",
  "external_change",
] as const;
export const SideEffectSchema = z.enum(SIDE_EFFECTS);
export type SideEffect = z.infer<typeof SideEffectSchema>;

/** `never`: a failed attempt isn't repeated. `idempotent`: repeating it is safe. `reconcile_first`: check what already happened, then continue. */
export const REPLAY_MODES = ["never", "idempotent", "reconcile_first"] as const;
export const ReplayModeSchema = z.enum(REPLAY_MODES);
export type ReplayMode = z.infer<typeof ReplayModeSchema>;

export const EVIDENCE_KINDS = [
  "tool_result",
  "artifact",
  "output_schema_match",
  "diff",
  "verifier_report",
] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

const InputSchema = z.strictObject({
  name: Name,
  description: z.string().max(500),
  type: z.enum(["text", "number", "boolean", "artifact"]),
});

const MAX_DEADLINE_SECONDS = 7 * 86_400;

const repeats = (values: readonly string[]) => values.length !== new Set(values).size;

const ContractShape = z.strictObject({
  version: z.literal(1),
  taskClass: TaskClassSchema,
  goal: z.string().min(1).max(4000),
  requiredInputs: z.array(InputSchema).max(50),
  /** A JSON Schema document the output must satisfy; null when the task has no machine-checkable shape. */
  outputSchema: z.record(z.string(), z.unknown()).nullable(),
  verifiers: z.array(VerifierRefSchema).max(20),
  permittedSideEffects: z.array(SideEffectSchema).min(1).max(SIDE_EFFECTS.length),
  capabilities: z.array(Name).max(50),
  /** Seconds from admission; null for none. */
  deadlineSeconds: z.number().int().positive().max(MAX_DEADLINE_SECONDS).nullable(),
  replayMode: ReplayModeSchema,
  evidenceRequirements: z.array(EvidenceKindSchema).max(EVIDENCE_KINDS.length),
});

type Shape = z.infer<typeof ContractShape>;

const CHECKS: readonly { path: keyof Shape; message: string; broken: (contract: Shape) => boolean }[] = [
  {
    path: "requiredInputs",
    message: "Input names repeat",
    broken: (c) => repeats(c.requiredInputs.map((input) => input.name)),
  },
  {
    path: "verifiers",
    message: "A verifier is listed twice",
    broken: (c) => repeats(c.verifiers.map((verifier) => verifier.id)),
  },
  {
    path: "permittedSideEffects",
    message: "A side effect is listed twice",
    broken: (c) => repeats(c.permittedSideEffects),
  },
  { path: "capabilities", message: "A capability is listed twice", broken: (c) => repeats(c.capabilities) },
  {
    path: "evidenceRequirements",
    message: "An evidence kind is listed twice",
    broken: (c) => repeats(c.evidenceRequirements),
  },
  {
    path: "permittedSideEffects",
    message: "none can't be combined with other side effects",
    broken: (c) => c.permittedSideEffects.includes("none") && c.permittedSideEffects.length > 1,
  },
  {
    path: "evidenceRequirements",
    message: "output_schema_match needs an output schema",
    broken: (c) => c.evidenceRequirements.includes("output_schema_match") && c.outputSchema === null,
  },
  {
    path: "evidenceRequirements",
    message: "verifier_report needs a verifier",
    broken: (c) => c.evidenceRequirements.includes("verifier_report") && c.verifiers.length === 0,
  },
];

export const TaskContractSchema = ContractShape.superRefine((contract, context) => {
  for (const { path, message, broken } of CHECKS)
    if (broken(contract)) context.addIssue({ code: "custom", path: [path], message });
});
export type TaskContract = z.infer<typeof TaskContractSchema>;
