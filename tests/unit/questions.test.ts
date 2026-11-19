import { describe, expect, it } from 'vitest';
import { parseQuestionAnswer, questionPrompt } from '../../src/modes/questions.js';
import { questionOf } from '../helpers/cli.js';

const item = (allow = {}) => questionOf('t', allow).items[0];

describe('parseQuestionAnswer', () => {
  it('one number; several only when allowed; out of range asks again', () => {
    expect(parseQuestionAnswer(item(), ' 3 ')).toEqual({ answer: { item_id: 'q0', selected_option_ids: ['q0-o2'] } });
    expect(parseQuestionAnswer(item(), '1,2')).toEqual({ retry: 'Choose one number from 1 to 3.' });
    expect(parseQuestionAnswer(item({ allow_multiple: true }), '1,2')).toEqual({ answer: { item_id: 'q0', selected_option_ids: ['q0-o0', 'q0-o1'] } });
    expect(parseQuestionAnswer(item({ allow_multiple: true }), '4')).toEqual({ retry: 'Choose numbers from 1 to 3.' });
  });

  it('text that is no valid selection is an answer of one\'s own when allowed', () => {
    expect(parseQuestionAnswer(item({ allow_custom: true }), '7')).toEqual({ answer: { item_id: 'q0', selected_option_ids: [], custom_text: '7' } });
    expect(parseQuestionAnswer(item(), 'the newest')).toEqual({ retry: 'Choose one number from 1 to 3.' });
  });

  it('an empty line or /cancel cancels', () => {
    expect(parseQuestionAnswer(item(), '')).toEqual({ cancel: true });
    expect(parseQuestionAnswer(item({ allow_custom: true }), '/cancel')).toEqual({ cancel: true });
  });

  it('the prompt says what it accepts', () => {
    expect(questionPrompt(item({ allow_multiple: true, allow_custom: true }))).toBe(
      'Answer (numbers from 1 to 3, separated by commas or spaces, or your own answer; Enter cancels): ',
    );
  });
});
