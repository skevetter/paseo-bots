/** A disclosure's label names what pressing it does, so a screen reader hears the action. */
export function disclosureLabel(expanded: boolean, name: string): string {
  return `${expanded ? "Collapse" : "Expand"} ${name}`;
}

/** Names the row a kebab belongs to, since every row has one. */
export function actionsLabel(name: string): string {
  return `Actions for ${name}`;
}
