import { z } from "zod";

/**
 * Receipts are kept for the last 200 operations, as many as the proposals the host keeps, so every proposal
 * that can still be accepted has its receipt until it is. Older ones are dropped first.
 */
export const MAX_RECEIPTS = 200;

/** A receipt names this many of the things its operation made, and counts the rest. */
export const MAX_RECEIPT_CREATED = 20;

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
});
export type ApplicationReceipt = z.infer<typeof ReceiptSchema>;
