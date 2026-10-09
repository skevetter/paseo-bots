import { test } from "vitest";
import { parseMarkdown, retainBlocks } from "../shared/markdown/blocks";
import { longReply } from "./fixtures";
import { report } from "./report";

const text = longReply(12);
const blocks = parseMarkdown(text, { streaming: true });
const chunked = `${text} and one more streamed token`;

/** What Markdown does with each chunk of a streaming reply; BlockView re-renders the blocks that changed. */
const streamChunk = () => retainBlocks(blocks, parseMarkdown(chunked, { streaming: true }));

const changed = streamChunk().filter((block, index) => block !== blocks[index]).length;
process.stdout.write(
  `markdown: ${text.length} chars, ${blocks.length} blocks; ${changed} block(s) change identity per chunk\n`,
);

test("streaming markdown reply", async ({ bench }) => {
  await report("streaming markdown reply", [
    bench("one streamed chunk: parse", () => parseMarkdown(chunked, { streaming: true })),
    bench("one streamed chunk: parse and retain", streamChunk),
  ]);
});
