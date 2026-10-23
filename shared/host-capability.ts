/**
 * What PaseoApi offers a plugin: no server_info or feature map (only the SDK's DaemonClient can read
 * it), so the one signal a host without caller-selected creation IDs gives is the Error the SDK throws
 * when `agentId` is passed. Pinned against the real SDK in tests/sdk-contract.test.ts; docs/compatibility.md.
 */
export const CALLER_SELECTED_IDS_UNSUPPORTED = "Update the host to use caller-selected creation IDs.";

export type HostCapability = "managed-identity";

/** A feature this plugin needs is missing on the connected Paseo host. Never retry; never degrade. */
export class HostCapabilityError extends Error {
  readonly capability: HostCapability;

  constructor(capability: HostCapability) {
    super(
      "This Paseo host is too old for managed chat identity (caller-selected agent ids). Update Paseo to use this feature.",
    );
    this.name = "HostCapabilityError";
    this.capability = capability;
  }
}

/** Typed form of an SDK creation error, or null when the error is about something else. */
export function toHostCapabilityError(error: unknown): HostCapabilityError | null {
  if (error instanceof HostCapabilityError) return error;
  return error instanceof Error && error.message === CALLER_SELECTED_IDS_UNSUPPORTED
    ? new HostCapabilityError("managed-identity")
    : null;
}
