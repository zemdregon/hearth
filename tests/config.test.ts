import { describe, expect, it } from 'vitest';
import { parseFamilyMembers, parseQuestionPair } from '../src/server/config.mjs';

const members = parseFamilyMembers(JSON.stringify([
  { id: 'sam', name: 'Sam', role: 'member', color: '#A96743' },
  { id: 'alex', name: 'Alex', role: 'admin', color: '#38634A' },
  { id: 'lee', name: 'Lee', role: 'member', color: '#555555' },
]));

describe('daily question pair configuration', () => {
  it('infers only a two-member household, in stable canonical order', () => {
    const couple = members.slice(0, 2);
    expect(parseQuestionPair(undefined, couple)).toEqual(['alex', 'sam']);
    expect(couple.map(member => member.id)).toEqual(['sam', 'alex']);
    expect(parseQuestionPair(undefined, members.slice(0, 1))).toBeNull();
    expect(parseQuestionPair(undefined, members)).toBeNull();
  });

  it.each([null, 'null', '  null\n'])('allows explicit disabling: %j', value => {
    expect(parseQuestionPair(value, members.slice(0, 2))).toBeNull();
  });

  it('selects two existing members from a larger household and normalizes order', () => {
    expect(parseQuestionPair('["sam","alex"]', members)).toEqual(['alex', 'sam']);
    expect(parseQuestionPair('["alex","sam"]', members)).toEqual(['alex', 'sam']);
    expect(parseQuestionPair('["sam","lee"]', members)).toEqual(['lee', 'sam']);
  });

  it.each([
    '', ' ', '[bad json', '[]', '["alex"]', '["alex","sam","lee"]',
    '["alex","alex"]', '["alex","unknown-private-id"]', '["Alex","sam"]',
    '[" alex","sam"]', '["alex",null]', '["alex",1]', '{}', 'false', '"alex"',
    ['alex', 'sam'], {}, 0, false,
  ])('rejects malformed, ambiguous, or nonmember pairs: %j', value => {
    expect(() => parseQuestionPair(value, members)).toThrow();
  });

  it('never includes configured values in a parse error', () => {
    for (const value of ['["alex","unknown-private-id"]', 'private-pair-sentinel']) {
      expect(() => parseQuestionPair(value, members)).toThrowError(/^Question pair must (?:be valid JSON|contain two distinct family member ids, or null)$/);
    }
  });
});
