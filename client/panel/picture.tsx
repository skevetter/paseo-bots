import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsAction } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { PALETTE_COUNT, paletteSwatch } from "../../shared/pixel";
import { pickFileHandles, squareImage } from "../web";
import { InputField } from "./fields";
import { StackedRow } from "./rows";

type Colors = PluginTheme["colors"];

/** Pictures are stored with the bot or team, so they're scaled down to this many pixels. */
export const PICTURE_SIZE = 192;
const IMAGE_URL = /^(https?:\/\/\S+|data:image\/\S+)$/i;
const MAX_UPLOAD = 20 * 1024 * 1024;
const PALETTES = Array.from({ length: PALETTE_COUNT }, (_, index) => index);

/** Web file picker; resolves to a square data URL, or null when nothing was picked. */
export async function pickPicture(): Promise<string | null> {
  const [file] = await pickFileHandles({
    accept: "image/png,image/jpeg,image/webp,image/gif",
    multiple: false,
  });
  if (!file) return null;
  if (file.size > MAX_UPLOAD) throw new Error("Pick a picture under 20 MB.");
  return squareImage(`data:${file.mimeType};base64,${await file.readBase64()}`, PICTURE_SIZE);
}

export function ColourRow({
  colors,
  value,
  onChange,
}: {
  colors: Colors;
  value: number | null;
  onChange(palette: number | null): void;
}) {
  return (
    <StackedRow colors={colors} label="Colour">
      <View
        accessibilityRole="radiogroup"
        style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}
      >
        <Swatch
          colors={colors}
          label="Automatic colour"
          color={null}
          selected={value === null}
          onPress={() => onChange(null)}
        />
        {PALETTES.map((palette) => (
          <Swatch
            key={palette}
            colors={colors}
            label={`Colour ${palette + 1}`}
            color={paletteSwatch(palette)}
            selected={value === palette}
            onPress={() => onChange(palette)}
          />
        ))}
      </View>
    </StackedRow>
  );
}

function Swatch({
  colors,
  label,
  color,
  selected,
  onPress,
}: {
  colors: Colors;
  label: string;
  color: string | null;
  selected: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      aria-checked={selected}
      hitSlop={12}
      onPress={onPress}
      style={{
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: color ?? "transparent",
        borderWidth: selected ? 2 : color ? 0 : 1,
        borderColor: selected ? colors.foreground : colors.foregroundMuted,
        borderStyle: color || selected ? "solid" : "dashed",
      }}
    />
  );
}

export function PictureSource(props: {
  colors: Colors;
  imageUrl: string | null;
  hint: string;
  placeholder: string;
  onChange(imageUrl: string | null): void;
}) {
  if (props.imageUrl?.startsWith("data:"))
    return (
      <SettingsAction
        label="Image"
        hint="Uploaded or generated"
        actionLabel="Remove"
        onPress={() => props.onChange(null)}
      />
    );
  return <ImageUrlField {...props} />;
}

function ImageUrlField({
  colors,
  imageUrl,
  hint,
  placeholder,
  onChange,
}: {
  colors: Colors;
  imageUrl: string | null;
  hint: string;
  placeholder: string;
  onChange(imageUrl: string | null): void;
}) {
  const [text, setText] = useState(imageUrl ?? "");
  return (
    <InputField
      colors={colors}
      label="Image URL"
      hint={hint}
      error={text.trim() && !IMAGE_URL.test(text.trim()) ? "Use an https:// or data:image URL" : null}
      initialValue={text}
      placeholder={placeholder}
      onChangeText={(url) => {
        setText(url);
        const trimmed = url.trim();
        if (!trimmed) onChange(null);
        else if (IMAGE_URL.test(trimmed)) onChange(trimmed);
      }}
    />
  );
}
