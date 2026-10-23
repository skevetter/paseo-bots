import { z } from "zod";

/** At most 200 receipts; unresolved operations pin theirs. If all are pinned, new operations refuse. */
export const MAX_RECEIPTS = 200;

/** A receipt names this many of the things its operation made, and counts the rest. */
export const MAX_RECEIPT_CREATED = 20;

/** The live file hash admitted before the config commit guards publication against intervening edits. */
const SkillPublicationSchema = z.object({
  id: z.string(),
  sha: z.string(),
  previousSha: z.string().nullable(),
});
export type SkillPublication = z.infer<typeof SkillPublicationSchema>;

/** What an applied operation left behind, saved in the same write as its changes. */
export const ReceiptSchema = z.object({
  operationId: z.string(),
  /** What kind of operation it was, such as the proposal's kind. */
  kind: z.string(),
  /** Of the operation's body; the same id with another hash is a different request. */
  bodyHash: z.string(),
  appliedAt: z.string(),
  /** Entities the operation made, as `<kind>:<id>`, in the order they were made. */
  created: z.array(z.string()).default([]),
  createdCount: z.number().int().default(0),
  notes: z.array(z.string()).default([]),
  skill: SkillPublicationSchema.optional(),
});
export type ApplicationReceipt = z.infer<typeof ReceiptSchema>;
