import type { QuestionAnswer, QuestionItem } from '../client/types.js';

/** One question with its options numbered, indented like the rest of interactive mode. */
export function formatQuestion(item: QuestionItem): string {
  const lines = [`  ${item.header ? `${item.header}: ` : ''}${item.question}`];
  item.options.forEach((o, i) => lines.push(`    ${i + 1}. ${o.label}${o.description ? ` (${o.description})` : ''}`));
  return lines.join('\n');
}

/** What the answer prompt asks for. */
export function questionPrompt(item: QuestionItem): string {
  const n = item.options.length;
  const pick = n === 0 ? '' : item.allow_multiple ? `numbers from 1 to ${n}, separated by commas or spaces` : `a number from 1 to ${n}`;
  const own = item.allow_custom ? (pick ? ', or your own answer' : 'your own answer') : '';
  return `Answer (${pick}${own}; Enter cancels): `;
}

export type ParsedAnswer = { answer: QuestionAnswer } | { cancel: true } | { retry: string };

/**
 * Reads one typed line as the answer to `item`: option numbers, else free text when the question
 * offers it. An empty line or `/cancel` cancels the whole question.
 */
export function parseQuestionAnswer(item: QuestionItem, line: string): ParsedAnswer {
  const text = line.trim();
  if (text === '' || text === '/cancel') return { cancel: true };
  const n = item.options.length;
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  if (n > 0 && tokens.every((t) => /^\d+$/.test(t))) {
    const nums = [...new Set(tokens.map(Number))];
    const valid = nums.every((x) => x >= 1 && x <= n) && (item.allow_multiple || nums.length === 1);
    if (valid) return { answer: { item_id: item.id, selected_option_ids: nums.map((x) => item.options[x - 1].id) } };
  }
  if (item.allow_custom) return { answer: { item_id: item.id, selected_option_ids: [], custom_text: text } };
  return { retry: item.allow_multiple ? `Choose numbers from 1 to ${n}.` : `Choose one number from 1 to ${n}.` };
}
