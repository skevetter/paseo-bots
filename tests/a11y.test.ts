import { describe, expect, it } from "vitest";
import { actionsLabel, disclosureLabel } from "../client/a11y";

describe("icon button labels", () => {
  it("names the disclosure's next action", () => {
    expect(disclosureLabel(true, "Ada")).toBe("Collapse Ada");
    expect(disclosureLabel(false, "Pinned")).toBe("Expand Pinned");
  });

  it("names the row a kebab acts on", () => {
    expect(actionsLabel("Morning brief")).toBe("Actions for Morning brief");
  });
});
