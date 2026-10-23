import { type Policy, type PolicyBody, PolicyBodySchema, type Referrer } from "../../shared/policies";

export interface PolicyDraft {
  name: string;
  purpose: string;
  advanced: string;
}

export interface PolicyEditorState {
  revision: string;
  policy: Policy | null;
  draft: PolicyDraft;
  conflict: boolean;
  notice: string | null;
  referrers: Referrer[];
  confirmDelete: boolean;
}

type PolicyRefusal = { status: "conflict"; error: string } | { status: "referenced"; referrers: Referrer[] };

export type PolicyEditorAction =
  | { type: "edit"; patch: Partial<PolicyDraft> }
  | { type: "saved"; revision: string; policy: Policy }
  | { type: "refused"; result: PolicyRefusal }
  | { type: "error"; message: string }
  | { type: "confirm-delete"; value: boolean };

export function createPolicyEditor(revision: string, policy: Policy | null): PolicyEditorState {
  const body = policy ?? PolicyBodySchema.parse({ name: "New policy" });
  const { name, purpose, roles, routing, budget, concurrency, taskClasses } = body;
  return {
    revision,
    policy,
    draft: {
      name: policy ? name : "",
      purpose,
      advanced: JSON.stringify({ taskClasses, roles, routing, budget, concurrency }, null, 2),
    },
    conflict: false,
    notice: null,
    referrers: [],
    confirmDelete: false,
  };
}

export function policyEditorReducer(state: PolicyEditorState, action: PolicyEditorAction): PolicyEditorState {
  switch (action.type) {
    case "edit":
      return {
        ...state,
        draft: { ...state.draft, ...action.patch },
        notice: state.conflict || state.referrers.length > 0 ? state.notice : null,
        confirmDelete: false,
      };
    case "saved":
      return {
        ...createPolicyEditor(action.revision, action.policy),
        notice: `Saved revision ${action.policy.revision}. Earlier revisions are unchanged.`,
      };
    case "refused":
      return refusedPolicyEditor(state, action.result);
    case "error":
      return { ...state, notice: action.message, confirmDelete: false };
    case "confirm-delete":
      return { ...state, confirmDelete: action.value };
  }
}

function refusedPolicyEditor(state: PolicyEditorState, result: PolicyRefusal): PolicyEditorState {
  if (result.status === "conflict") {
    return {
      ...state,
      conflict: true,
      notice: `${result.error} Reload saved policies to review the latest state before trying again. Your draft has not been saved.`,
      confirmDelete: false,
    };
  }
  return {
    ...state,
    notice:
      "Cannot delete this policy. Remove every binding below, then reload saved policies before trying again.",
    referrers: result.referrers,
    confirmDelete: false,
  };
}

const AdvancedPolicySchema = PolicyBodySchema.omit({ name: true, purpose: true });

export function parsePolicyDraft(
  draft: PolicyDraft,
): { ok: true; policy: PolicyBody } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(draft.advanced);
  } catch {
    return { ok: false, error: "Advanced settings must be a valid JSON object." };
  }
  const advanced = AdvancedPolicySchema.safeParse(json);
  if (!advanced.success) return { ok: false, error: policySchemaError(advanced.error) };
  const parsed = PolicyBodySchema.safeParse({ ...advanced.data, name: draft.name, purpose: draft.purpose });
  if (!parsed.success) return { ok: false, error: policySchemaError(parsed.error) };
  return { ok: true, policy: parsed.data };
}

function policySchemaError(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "Policy"}: ${issue.message}`).join("\n");
}

export function policyReferrerLabel(referrer: Referrer): string {
  if (referrer.kind === "global") return "Global policy binding";
  const kind = referrer.kind === "team" ? "Team" : "Bot";
  return `${kind}: ${referrer.name} (${referrer.id})`;
}
