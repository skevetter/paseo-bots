import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, type TextStyle } from "react-native";
import { createTextMeasurer, domNode, observeWidth, type TextMeasurer } from "../../web";
import { clampHeight } from "./logic";

const web = Platform.OS === "web";

interface InputHeightOptions {
  inputRef: RefObject<unknown>;
  text: string;
  minHeight: number;
  maxHeight: number;
  fontSize: number;
}

export function useInputHeight({ inputRef, text, minHeight, maxHeight, fontSize }: InputHeightOptions): {
  style: TextStyle;
  scrollEnabled: boolean;
} {
  const [height, setHeight] = useState(minHeight);
  const measurer = useRef<TextMeasurer | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const measureText = useCallback(
    (value: string) => {
      const measured = measurer.current?.measure(domNode(inputRef.current), value);
      if (measured === null || measured === undefined) return;
      const next = clampHeight(measured, minHeight, maxHeight);
      setHeight((current) => (Math.abs(current - next) < 1 ? current : next));
    },
    [inputRef, minHeight, maxHeight],
  );
  const measure = useCallback(() => measureText(textRef.current), [measureText]);
  const latestMeasure = useRef(measure);
  latestMeasure.current = measure;

  useEffect(() => {
    if (!web) return;
    measurer.current = createTextMeasurer();
    latestMeasure.current();
    return () => {
      measurer.current?.dispose();
      measurer.current = null;
    };
    // The mirror lives as long as the input.
  }, []);

  const layout = useMemo(() => ({ text, fontSize }), [text, fontSize]);
  useLayoutEffect(() => {
    if (web) measureText(layout.text);
  }, [layout, measureText]);

  useEffect(() => (web ? observeWidth(domNode(inputRef.current), measure) : undefined), [inputRef, measure]);

  if (!web) return { style: { minHeight, maxHeight }, scrollEnabled: true };
  return { style: { height, minHeight, maxHeight }, scrollEnabled: height >= maxHeight };
}
