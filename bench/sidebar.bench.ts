import { test } from "vitest";
import { displayTitle } from "../shared/chat";
import { BUCKET_LABELS, chatBucket } from "../shared/sidebar";
import { sidebarFixture, sidebarRender } from "./fixtures";
import { report } from "./report";

const fixture = sidebarFixture();
const chat = fixture.chats.get("bot-7")?.[3];
if (!chat) throw new Error("No chat");
process.stdout.write(`sidebar: ${sidebarRender(fixture).length} rows\n`);

test("sidebar, 50 bots", async ({ bench }) => {
  await report("sidebar, 50 bots", [
    bench("one render's data pipeline", () => sidebarRender(fixture)),
    bench("one chat row", () => `${displayTitle(chat.title)}, ${BUCKET_LABELS[chatBucket(chat)]}`),
  ]);
});
