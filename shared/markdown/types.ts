export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "italic"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; url: string; children: Inline[] }
  | { kind: "image"; url: string; alt: string }
  | { kind: "break" };

export interface ListItem {
  marker: string;
  blocks: Block[];
}

export type TableAlign = "left" | "center" | "right" | null;

export type Block =
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "table"; align: TableAlign[]; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

export interface ParseOptions {
  /** Complete unclosed inline marks at the end of still-streaming text. */
  streaming?: boolean;
  /** Default true. */
  linkify?: boolean;
}

export type References = Map<string, string> & { linkify?: boolean };
