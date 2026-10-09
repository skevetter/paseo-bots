import { memo } from "react";
import type { StreamLayoutItem } from "./model";
import { RowContent, type RowContext, RowFrame } from "./rows";
import { CompletedTurnFooter } from "./TurnFooter";

export const StreamItem = memo(function StreamItem({
  item,
  context,
  typeVersion,
}: {
  item: StreamLayoutItem;
  context: RowContext;
  typeVersion: number;
}) {
  return (
    <>
      {/* Rows read Paseo's font sizes while rendering; a size change remounts them. */}
      <RowFrame
        key={typeVersion}
        gapBelow={item.gapBelow}
        highlight={context.highlightKey === item.row.key ? context.colors.surface2 : undefined}
      >
        <RowContent row={item.row} context={context} compactBottom={item.compactBottom} />
      </RowFrame>
      {item.footer ? (
        <CompletedTurnFooter colors={context.colors} footer={item.footer} voice={context.voice} />
      ) : null}
    </>
  );
});
