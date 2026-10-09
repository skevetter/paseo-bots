import { ActivityIndicator, Platform, View } from "react-native";

export const isWeb = Platform.OS === "web";
export const METADATA_SIZE = 13;

export function keysWithOccurrence(values: string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const occurrence = seen.get(value) ?? 0;
    seen.set(value, occurrence + 1);
    return `${value}-${occurrence}`;
  });
}

export function Spinner({ color, size = 20 }: { color: string; size?: number }) {
  const scale = size / 20;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator
        size="small"
        color={color}
        style={scale === 1 ? undefined : { transform: [{ scale }] }}
      />
    </View>
  );
}
