import { describe, expect, it } from "vitest";
import { skillDeleteRpc, skillReadRpc, skillWriteRpc } from "../shared/rpc";

describe("skill RPC ids", () => {
  const parses = (id: string) => [
    skillReadRpc.input.safeParse({ id }).success,
    skillWriteRpc.input.safeParse({ id, text: "" }).success,
    skillDeleteRpc.input.safeParse({ id }).success,
  ];

  it("rejects ids that would leave the skills folder", () => {
    for (const id of [".", "..", ".hidden"]) expect(parses(id)).toEqual([false, false, false]);
  });

  it("accepts library skill ids", () => {
    for (const id of ["my-skill", "v1.2"]) expect(parses(id)).toEqual([true, true, true]);
  });
});
