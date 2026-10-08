import { useEffect, useState } from "react";
import {
  Dimensions,
  Keyboard,
  type KeyboardEvent,
  LayoutAnimation,
  NativeModules,
  Platform,
  TurboModuleRegistry,
} from "react-native";

/** iOS heights below this are the predictive bar alone; matches Paseo's keyboard shift. */
const IOS_KEYBOARD_MIN_HEIGHT = 120;

/** A frame at or below the screen bottom is a hidden or undocked keyboard. */
function iosKeyboardHeight(event: Pick<KeyboardEvent, "endCoordinates">, screenHeight: number): number {
  const { height, screenY } = event.endCoordinates;
  if (!(height > 0) || (Number.isFinite(screenY) && screenY >= screenHeight)) return 0;
  return height < IOS_KEYBOARD_MIN_HEIGHT ? 0 : height;
}

/**
 * Plugins get no keyboard handling from the host, and Paseo runs edge-to-edge, so Android
 * doesn't resize the window either. iOS uses keyboardWillChangeFrame so accessory bars and
 * split keyboards track; Android only reports after the fact, so the jump is eased.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const ios = Platform.OS === "ios";
    let current = 0;
    const apply = (next: number, duration: number | undefined) => {
      if (next === current) return;
      current = next;
      if (ios) {
        LayoutAnimation.configureNext(
          LayoutAnimation.create(
            duration || 250,
            LayoutAnimation.Types.keyboard,
            LayoutAnimation.Properties.opacity,
          ),
        );
      } else {
        LayoutAnimation.configureNext(
          LayoutAnimation.create(
            duration || 200,
            LayoutAnimation.Types.easeInEaseOut,
            LayoutAnimation.Properties.opacity,
          ),
        );
      }
      setHeight(next);
    };
    const subscriptions = ios
      ? [
          Keyboard.addListener("keyboardWillChangeFrame", (event) =>
            apply(iosKeyboardHeight(event, Dimensions.get("screen").height), event.duration),
          ),
          Keyboard.addListener("keyboardWillHide", (event) => apply(0, event.duration)),
        ]
      : [
          Keyboard.addListener("keyboardDidShow", (event) =>
            apply(Math.max(0, event.endCoordinates.height), undefined),
          ),
          Keyboard.addListener("keyboardDidHide", () => apply(0, undefined)),
        ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);
  return height;
}

type SafeAreaModule = {
  getConstants?: () => { initialWindowMetrics?: { insets?: { bottom?: number } } | null };
};
let initialBottomInset: number | null | undefined;

function readInitialBottomInset(): number | null {
  if (initialBottomInset !== undefined) return initialBottomInset;
  initialBottomInset = null;
  try {
    const module =
      (TurboModuleRegistry.get("RNCSafeAreaContext") as SafeAreaModule | null) ??
      (NativeModules.RNCSafeAreaContext as SafeAreaModule | undefined);
    const bottom = module?.getConstants?.().initialWindowMetrics?.insets?.bottom;
    if (typeof bottom === "number" && Number.isFinite(bottom) && bottom >= 0) initialBottomInset = bottom;
  } catch {
    // Not available to plugins on this build.
  }
  return initialBottomInset;
}

/**
 * Plugins get no insets API, so without the app's startup metrics this infers the iPhone
 * home indicator from the screen: every iPhone with one is at least 812pt tall.
 */
export function homeIndicatorInset(): number {
  if (Platform.OS === "web") return 0;
  const { width, height } = Dimensions.get("screen");
  const landscape = width > height;
  const measured = readInitialBottomInset();
  if (Platform.OS === "ios") {
    const pad = (Platform as { isPad?: boolean }).isPad === true;
    const portrait = measured ?? (!pad && Math.max(width, height) >= 812 ? 34 : 0);
    // iOS shrinks the home-indicator inset to 21 in landscape.
    return landscape && portrait > 0 ? Math.min(portrait, 21) : portrait;
  }
  return measured ?? 0;
}
