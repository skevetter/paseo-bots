export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionFormQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
}

export type QuestionSelections = Record<number, ReadonlySet<number>>;
export type QuestionOtherTexts = Record<number, string>;

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function parseQuestionOption(opt: unknown): QuestionOption | null {
  if (typeof opt !== "object" || opt === null) return null;
  const o = opt as Record<string, unknown>;
  if (typeof o.label !== "string") return null;
  return {
    label: o.label,
    ...(typeof o.description === "string" ? { description: o.description } : {}),
  };
}

function parseQuestionOptions(input: unknown[]): QuestionOption[] | null {
  const options: QuestionOption[] = [];
  for (const opt of input) {
    const option = parseQuestionOption(opt);
    if (!option) return null;
    options.push(option);
  }
  return options;
}

function parseQuestion(item: unknown): QuestionFormQuestion | null {
  if (typeof item !== "object" || item === null) return null;
  const q = item as Record<string, unknown>;
  if (typeof q.question !== "string" || typeof q.header !== "string" || !Array.isArray(q.options))
    return null;
  const options = parseQuestionOptions(q.options);
  if (!options) return null;
  return {
    question: q.question,
    header: q.header,
    options,
    multiSelect: q.multiSelect === true,
    allowOther: q.allowOther === true || q.isOther === true,
    allowEmpty: q.allowEmpty === true,
    placeholder: readOptionalString(q, "placeholder"),
    dismissLabel: readOptionalString(q, "dismissLabel"),
  };
}

export function parseQuestionFormQuestions(input: unknown): QuestionFormQuestion[] | null {
  if (
    typeof input !== "object" ||
    input === null ||
    !Array.isArray((input as Record<string, unknown>).questions)
  )
    return null;
  const questions: QuestionFormQuestion[] = [];
  for (const item of (input as Record<string, unknown>).questions as unknown[]) {
    const question = parseQuestion(item);
    if (!question) return null;
    questions.push(question);
  }
  return questions.length > 0 ? questions : null;
}

export function questionShowsTextInput(question: QuestionFormQuestion): boolean {
  return question.options.length === 0 || question.allowOther;
}

export function isQuestionAnswered(
  question: QuestionFormQuestion,
  index: number,
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  const selected = selections[index];
  if (selected && selected.size > 0) return true;
  if (!questionShowsTextInput(question)) return false;
  if (otherTexts[index]?.trim()) return true;
  return question.allowEmpty;
}

export function areQuestionsAnswered(
  questions: QuestionFormQuestion[] | null,
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): boolean {
  return (
    questions?.every((question, index) => isQuestionAnswered(question, index, selections, otherTexts)) ??
    false
  );
}

/** Answers keyed by question header: option labels joined by ", ", or the typed answer. */
export function buildQuestionFormAnswers(
  questions: QuestionFormQuestion[],
  selections: QuestionSelections,
  otherTexts: QuestionOtherTexts,
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const answer = resolveQuestionAnswer(question, selections[index], otherTexts[index]?.trim());
    if (answer !== undefined) answers[question.header] = answer;
  });
  return answers;
}

function selectedOptionLabels(
  question: QuestionFormQuestion,
  selected: ReadonlySet<number> | undefined,
): string[] {
  if (!selected) return [];
  return Array.from(selected).map((option) => {
    const entry = question.options[option];
    if (!entry) throw new Error(`Question "${question.header}" has no option at index ${option}`);
    return entry.label;
  });
}

function resolveQuestionAnswer(
  question: QuestionFormQuestion,
  selected: ReadonlySet<number> | undefined,
  other: string | undefined,
): string | undefined {
  const labels = selectedOptionLabels(question, selected);
  if (questionShowsTextInput(question)) {
    if (other) {
      // Multi-select keeps the checked options and appends the typed answer; single-select replaces them.
      return question.multiSelect ? [...labels, other].join(", ") : other;
    }
    if (question.allowEmpty && question.options.length === 0) return "";
  }
  return labels.length > 0 ? labels.join(", ") : undefined;
}

export function shouldSubmitEmptyOnDismiss(questions: QuestionFormQuestion[]): boolean {
  return (
    questions.length > 0 &&
    questions.every((question) => question.allowEmpty && question.options.length === 0)
  );
}

export function resolveDismissLabel(questions: QuestionFormQuestion[], fallback = "Dismiss"): string {
  return questions.find((question) => question.dismissLabel)?.dismissLabel ?? fallback;
}
