import { test } from "vitest";
import { parseMarkdown } from "../shared/markdown/blocks";
import { longReply } from "./fixtures";
import { report } from "./report";

const text = longReply(12);
const blocks = parseMarkdown(text, { streaming: true });
const chunked = `${text} and one more streamed token`;
process.stdout.write(
  `markdown: ${text.length} chars, ${blocks.length} blocks; every block re-renders per chunk (BlockView isn't memoised)\n`,
);

test("streaming markdown reply", async ({ bench }) => {
  await report("streaming markdown reply", [
    bench("one streamed chunk: parse", () => parseMarkdown(chunked, { streaming: true })),
  ]);
});
