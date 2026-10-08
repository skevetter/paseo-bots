import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import { Pressable, Text, type TextStyle, View } from "react-native";
import { nativeTokens } from "../../native";
import type { PaseoAgentPermissionResponse } from "../../paseo";
import { ui } from "../../typography";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  isQuestionAnswered,
  parseQuestionFormQuestions,
  type QuestionFormQuestion,
  questionShowsTextInput,
  resolveDismissLabel,
  shouldSubmitEmptyOnDismiss,
} from "./question";
import { isWeb, keysWithOccurrence, Spinner } from "./ui";

type Colors = PluginTheme["colors"];

interface QuestionFormCardProps {
  colors: Colors;
  input: Record<string, unknown> | undefined;
  compact: boolean;
  isResponding: boolean;
  onRespond(response: PaseoAgentPermissionResponse): void;
}

type QuestionSelectionState = Record<number, Set<number>>;
type RespondingAction = "submit" | "dismiss" | null;

interface QuestionFormState {
  selections: QuestionSelectionState;
  setSelections: Dispatch<SetStateAction<QuestionSelectionState>>;
  otherTexts: Record<number, string>;
  setOtherTexts: Dispatch<SetStateAction<Record<number, string>>>;
  activeIndex: number;
  setActiveIndex: Dispatch<SetStateAction<number>>;
  respondingAction: RespondingAction;
  setRespondingAction: Dispatch<SetStateAction<RespondingAction>>;
}

function useQuestionFormState(): QuestionFormState {
  const [selections, setSelections] = useState<QuestionSelectionState>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const [activeIndex, setActiveIndex] = useState(0);
  const [respondingAction, setRespondingAction] = useState<RespondingAction>(null);
  return {
    selections,
    setSelections,
    otherTexts,
    setOtherTexts,
    activeIndex,
    setActiveIndex,
    respondingAction,
    setRespondingAction,
  };
}

function toggledSelection(
  selected: ReadonlySet<number>,
  optionIndex: number,
  multiSelect: boolean,
): Set<number> {
  const next = new Set(selected);
  if (multiSelect) {
    if (next.has(optionIndex)) next.delete(optionIndex);
    else next.add(optionIndex);
    return next;
  }
  const wasSelected = next.has(optionIndex);
  next.clear();
  if (!wasSelected) next.add(optionIndex);
  return next;
}

interface QuestionFormActionsContext {
  questions: QuestionFormQuestion[];
  question: QuestionFormQuestion;
  index: number;
  selected: ReadonlySet<number>;
  state: QuestionFormState;
  input: Record<string, unknown> | undefined;
  isResponding: boolean;
  allAnswered: boolean;
  activeAnswered: boolean;
  isLast: boolean;
  onRespond(response: PaseoAgentPermissionResponse): void;
}

function createQuestionFormActions(context: QuestionFormActionsContext) {
  const { questions, question, index, selected, state, input, isResponding, onRespond } = context;
  const nextIndex = Math.min(index + 1, questions.length - 1);

  const toggle = (optionIndex: number) => {
    const next = toggledSelection(selected, optionIndex, question.multiSelect);
    state.setSelections((previous) => ({ ...previous, [index]: next }));
    if (question.multiSelect) return;
    // Single-select: an option and a typed answer replace each other.
    if (state.otherTexts[index]) {
      state.setOtherTexts((previous) => {
        const copy = { ...previous };
        delete copy[index];
        return copy;
      });
    }
    if (next.size > 0) state.setActiveIndex(nextIndex);
  };

  const setOther = (text: string) => {
    state.setOtherTexts((previous) => ({ ...previous, [index]: text }));
    if (!question.multiSelect && text.length > 0 && selected.size > 0)
      state.setSelections((previous) => ({ ...previous, [index]: new Set<number>() }));
  };

  const answers = () => ({
    ...(input ?? {}),
    answers: buildQuestionFormAnswers(questions, state.selections, state.otherTexts),
  });

  const dismiss = () => {
    state.setRespondingAction("dismiss");
    if (shouldSubmitEmptyOnDismiss(questions)) {
      onRespond({ behavior: "allow", updatedInput: answers() });
      return;
    }
    onRespond({ behavior: "deny", message: "Dismissed by user" });
  };

  const primary = () => {
    if (!context.isLast) {
      if (!context.activeAnswered || isResponding) return;
      state.setActiveIndex(nextIndex);
      return;
    }
    if (!context.allAnswered || isResponding) return;
    state.setRespondingAction("submit");
    onRespond({ behavior: "allow", updatedInput: answers() });
  };

  return { toggle, setOther, dismiss, primary };
}

export function QuestionFormCard({ colors, input, compact, isResponding, onRespond }: QuestionFormCardProps) {
  const questions = useMemo(() => parseQuestionFormQuestions(input), [input]);
  const state = useQuestionFormState();

  if (!questions) return null;

  const index = Math.min(state.activeIndex, questions.length - 1);
  const question = questions[index];
  if (!question) return null;
  const allAnswered = areQuestionsAnswered(questions, state.selections, state.otherTexts);
  const activeAnswered = isQuestionAnswered(question, index, state.selections, state.otherTexts);
  const isLast = index === questions.length - 1;
  const selected = state.selections[index] ?? new Set<number>();
  const actions = createQuestionFormActions({
    questions,
    question,
    index,
    selected,
    state,
    input,
    isResponding,
    allAnswered,
    activeAnswered,
    isLast,
    onRespond,
  });

  return (
    <View
      style={{
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        gap: 12,
        backgroundColor: colors.surface1,
        borderColor: colors.border,
      }}
    >
      {questions.length > 1 ? (
        <QuestionTabs
          colors={colors}
          questions={questions}
          activeIndex={index}
          state={state}
          disabled={isResponding}
        />
      ) : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingBottom: 4,
        }}
      >
        <Text style={{ flex: 1, fontSize: ui(14), lineHeight: 22, color: colors.foreground }}>
          {question.question}
        </Text>
      </View>
      <View key={question.question} style={{ gap: 8 }}>
        {question.options.length > 0 ? (
          <QuestionOptions
            colors={colors}
            question={question}
            selected={selected}
            disabled={isResponding}
            onToggle={actions.toggle}
          />
        ) : null}
        {questionShowsTextInput(question) ? (
          <QuestionTextInput
            colors={colors}
            question={question}
            value={state.otherTexts[index] ?? ""}
            disabled={isResponding}
            onChangeText={actions.setOther}
            onSubmit={actions.primary}
          />
        ) : null}
      </View>
      <QuestionActions
        colors={colors}
        compact={compact}
        isResponding={isResponding}
        respondingAction={state.respondingAction}
        dismissLabel={resolveDismissLabel(questions)}
        primaryLabel={isLast ? "Submit" : "Next"}
        primaryDisabled={isResponding || (isLast ? !allAnswered : !activeAnswered)}
        onDismiss={actions.dismiss}
        onPrimary={actions.primary}
      />
    </View>
  );
}

function QuestionTabs({
  colors,
  questions,
  activeIndex,
  state,
  disabled,
}: {
  colors: Colors;
  questions: QuestionFormQuestion[];
  activeIndex: number;
  state: QuestionFormState;
  disabled: boolean;
}) {
  const keys = keysWithOccurrence(questions.map((entry) => entry.header));
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 12,
      }}
    >
      {questions.map((entry, entryIndex) => (
        <NavButton
          key={keys[entryIndex]}
          colors={colors}
          label={entry.header}
          total={questions.length}
          index={entryIndex}
          active={entryIndex === activeIndex}
          answered={isQuestionAnswered(entry, entryIndex, state.selections, state.otherTexts)}
          disabled={disabled}
          onPress={() => state.setActiveIndex(entryIndex)}
        />
      ))}
    </View>
  );
}

function QuestionOptions({
  colors,
  question,
  selected,
  disabled,
  onToggle,
}: {
  colors: Colors;
  question: QuestionFormQuestion;
  selected: ReadonlySet<number>;
  disabled: boolean;
  onToggle(optionIndex: number): void;
}) {
  const keys = keysWithOccurrence(question.options.map((option) => option.label));
  return (
    <View
      style={{ gap: 4 }}
      {...(!question.multiSelect
        ? { accessibilityRole: "radiogroup" as const, accessibilityLabel: question.question }
        : {})}
    >
      {question.options.map((option, optionIndex) => (
        <OptionRow
          key={keys[optionIndex]}
          colors={colors}
          question={question}
          label={option.label}
          description={option.description}
          selected={selected.has(optionIndex)}
          disabled={disabled}
          onPress={() => onToggle(optionIndex)}
        />
      ))}
    </View>
  );
}

function QuestionTextInput({
  colors,
  question,
  value,
  disabled,
  onChangeText,
  onSubmit,
}: {
  colors: Colors;
  question: QuestionFormQuestion;
  value: string;
  disabled: boolean;
  onChangeText(text: string): void;
  onSubmit(): void;
}) {
  const tokens = nativeTokens(colors);
  const placeholder =
    question.placeholder ?? (question.options.length === 0 ? "Type your answer..." : "Other...");
  return (
    <TextInput
      accessibilityLabel={question.question}
      value={value}
      onChangeText={onChangeText}
      onSubmitEditing={onSubmit}
      placeholder={placeholder}
      placeholderTextColor={colors.foregroundMuted}
      editable={!disabled}
      blurOnSubmit={false}
      style={{
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        fontSize: ui(14),
        borderColor: value.length > 0 ? tokens.borderAccent : colors.border,
        color: colors.foreground,
        backgroundColor: colors.surface2,
        ...(isWeb ? ({ outlineStyle: "none", outlineWidth: 0 } as unknown as TextStyle) : {}),
      }}
    />
  );
}

function QuestionActions({
  colors,
  compact,
  isResponding,
  respondingAction,
  dismissLabel,
  primaryLabel,
  primaryDisabled,
  onDismiss,
  onPrimary,
}: {
  colors: Colors;
  compact: boolean;
  isResponding: boolean;
  respondingAction: RespondingAction;
  dismissLabel: string;
  primaryLabel: string;
  primaryDisabled: boolean;
  onDismiss(): void;
  onPrimary(): void;
}) {
  const tokens = nativeTokens(colors);
  const [dismissHovered, setDismissHovered] = useState(false);
  return (
    <View
      style={
        compact
          ? { gap: 8 }
          : { gap: 8, flexDirection: "row", justifyContent: "flex-start", alignItems: "center" }
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={dismissLabel}
        onPress={onDismiss}
        disabled={isResponding}
        onHoverIn={() => setDismissHovered(true)}
        onHoverOut={() => setDismissHovered(false)}
        style={({ pressed }) => ({
          paddingVertical: 8,
          paddingHorizontal: 12,
          borderRadius: 6,
          alignItems: "center",
          borderWidth: 1,
          backgroundColor: dismissHovered ? colors.surface2 : colors.surface1,
          borderColor: tokens.borderAccent,
          opacity: pressed ? 0.9 : 1,
        })}
      >
        {respondingAction === "dismiss" && isResponding ? (
          <Spinner color={colors.foregroundMuted} />
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="X" size={14} color={colors.foregroundMuted} />
            <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>{dismissLabel}</Text>
          </View>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={primaryLabel}
        accessibilityState={{ disabled: primaryDisabled }}
        onPress={onPrimary}
        disabled={primaryDisabled}
        style={({ pressed }) => ({
          paddingVertical: 8,
          paddingHorizontal: 12,
          borderRadius: 6,
          alignItems: "center",
          borderWidth: 1,
          backgroundColor: colors.accent,
          borderColor: colors.accent,
          opacity: primaryDisabled ? 0.5 : pressed ? 0.9 : 1,
        })}
      >
        {respondingAction === "submit" && isResponding ? (
          <Spinner color={colors.accentForeground} />
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="Check" size={14} color={colors.accentForeground} />
            <Text style={{ fontSize: ui(14), color: colors.accentForeground }}>{primaryLabel}</Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

function NavButton({
  colors,
  label,
  index,
  total,
  active,
  answered,
  disabled,
  onPress,
}: {
  colors: Colors;
  label: string;
  index: number;
  total: number;
  active: boolean;
  answered: boolean;
  disabled: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={`Question ${index + 1} of ${total}`}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        minHeight: 28,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        borderWidth: 1,
        backgroundColor: active || hovered ? colors.surface2 : colors.surface1,
        borderColor: active ? colors.foregroundMuted : colors.border,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      {answered ? (
        <Icon name="Check" size={12} color={active ? colors.foreground : colors.foregroundMuted} />
      ) : null}
      <Text
        numberOfLines={1}
        style={{ fontSize: ui(14), color: active ? colors.foreground : colors.foregroundMuted }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function OptionRow({
  colors,
  question,
  label,
  description,
  selected,
  disabled,
  onPress,
}: {
  colors: Colors;
  question: QuestionFormQuestion;
  label: string;
  description?: string;
  selected: boolean;
  disabled: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const multi = question.multiSelect;
  return (
    <Pressable
      accessibilityRole={multi ? "checkbox" : "radio"}
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 6,
        backgroundColor: hovered || selected ? colors.surface2 : "transparent",
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <View style={{ flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <OptionIndicator colors={colors} multi={multi} selected={selected} />
        <View style={{ flex: 1, gap: 4 }}>
          <Text
            style={{
              fontSize: ui(14),
              lineHeight: 22,
              color: selected ? colors.foreground : colors.foregroundMuted,
            }}
          >
            {label}
          </Text>
          {description ? (
            <Text style={{ fontSize: ui(14), lineHeight: 20, color: colors.foregroundMuted }}>
              {description}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function OptionIndicator({ colors, multi, selected }: { colors: Colors; multi: boolean; selected: boolean }) {
  const tokens = nativeTokens(colors);
  return (
    <View
      style={{
        width: 18,
        height: 18,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        marginTop: 2,
        borderRadius: multi ? 4 : 999,
        borderColor: selected ? colors.accent : tokens.foregroundExtraMuted,
        backgroundColor: selected && multi ? colors.accent : "transparent",
      }}
    >
      {selected && multi ? <Icon name="Check" size={12} color={colors.accentForeground} /> : null}
      {selected && !multi ? (
        <View style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: colors.accent }} />
      ) : null}
    </View>
  );
}
