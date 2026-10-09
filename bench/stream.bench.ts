import { test } from "vitest";
import {
  buildRows,
  findRows,
  layoutStream,
  mergeEntries,
  retainLayout,
  type StreamLayout,
} from "../client/chat/stream/model";
import { chatEntries, streamedChunk } from "./fixtures";
import { report } from "./report";

const entries = chatEntries(2000);
const rows = buildRows(entries, true);
const layout = retainLayout(null, layoutStream(rows, true));
const chunk = streamedChunk(entries, " and one more streamed token");

/** What ChatStream does with each timeline page while a turn streams. */
function streamChunk(previous: StreamLayout) {
  const merged = mergeEntries(entries, [chunk]);
  const next = retainLayout(previous, layoutStream(buildRows(merged, true), true));
  return { next, data: [...next.items].reverse() };
}

const { next } = streamChunk(layout);
const changed = next.items.filter((item, index) => item !== layout.items[index]).length;
process.stdout.write(
  `stream: ${entries.length} entries, ${rows.length} rows; ${changed} row(s) change identity per chunk\n`,
);

test("chat stream, 2,000 rows", async ({ bench }) => {
  let fresh = entries;
  await report("chat stream, 2,000 rows", [
    bench(
      "buildRows (a chat's first build)",
      {
        beforeEach: () => {
          fresh = entries.map((entry) => ({ ...entry }));
        },
      },
      () => buildRows(fresh, true),
    ),
    bench("buildRows (entries seen before)", () => buildRows(entries, true)),
    bench("layoutStream", () => layoutStream(rows, true)),
    bench("retainLayout (fresh layout vs previous)", () => retainLayout(layout, layoutStream(rows, true))),
    bench("findRows", () => findRows(layout.items, "scheduler")),
    bench("mergeEntries (one streamed chunk)", () => mergeEntries(entries, [chunk])),
    bench("one streamed chunk, end to end", () => streamChunk(layout)),
  ]);
});
