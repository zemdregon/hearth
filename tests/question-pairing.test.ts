import { describe, expect, it } from 'vitest';
import { answerPairComplete, canViewAnswer, sameQuestionPair } from '../src/shared/question-pairing';
import type { Answer, FamilyRecord, QuestionPair, User } from '../src/shared/types';

const pair: QuestionPair = ['alex', 'sam'];
const members: User[] = ['alex', 'sam', 'lee'].map(id => ({ id, name: id, email: `${id}@example.com`, role: id === 'lee' ? 'admin' : 'member', color: '#555555' }));
const answer = (ownerId: string, changes: Partial<Answer> = {}): FamilyRecord<'answer'> => ({
  id: ownerId, kind: 'answer', ownerId, createdAt: '2026-01-01T12:00:00Z', updatedAt: '2026-01-01T12:00:00Z', version: 1,
  data: { date: '2026-01-01', questionId: 'question', choice: 0, shareToProfile: false, participantIds: pair, ...changes },
});

describe('question pair scope and answer visibility', () => {
  it('compares valid pairs without depending on order and rejects absent or malformed scopes', () => {
    expect(sameQuestionPair(pair, ['sam', 'alex'])).toBe(true);
    for (const scope of [undefined, null, [], ['alex'], ['alex', 'alex'], ['alex', 'sam', 'lee'], ['alex', 'lee'], ['', 'sam']]) {
      expect(sameQuestionPair(pair, scope)).toBe(false);
      expect(sameQuestionPair(scope, pair)).toBe(false);
    }
    expect(sameQuestionPair(undefined, undefined)).toBe(false);
    expect(sameQuestionPair(null, null)).toBe(false);
  });

  it('requires each recorded participant to answer with the same date, question, and pair', () => {
    const first = answer('alex');
    const partner = answer('sam');
    expect(answerPairComplete(first, [first, partner], pair)).toBe(true);
    expect(answerPairComplete(first, [first], pair)).toBe(false);
    for (const changes of [{ date: '2026-01-02' }, { questionId: 'other' }, { participantIds: undefined }, { participantIds: ['sam', 'lee'] as QuestionPair }]) {
      expect(answerPairComplete(first, [first, answer('sam', changes)], pair)).toBe(false);
    }
    expect(answerPairComplete(first, [first, partner], null)).toBe(false);
    expect(answerPairComplete(first, [first, partner], ['alex', 'lee'])).toBe(false);
    expect(answerPairComplete(answer('lee'), [first, partner, answer('lee')], pair)).toBe(false);
  });

  it('always preserves an author’s access, including unscoped history and inactive pairing', () => {
    const legacy = answer('alex', { participantIds: undefined, shareToProfile: true });
    expect(canViewAnswer(legacy, [legacy], 'alex', null, members)).toBe(true);
    expect(canViewAnswer(answer('sam'), [], 'sam', ['alex', 'lee'], members)).toBe(true);
    expect(canViewAnswer(legacy, [legacy, answer('sam', { participantIds: undefined })], 'sam', pair, members)).toBe(false);
  });

  it('releases answers to the partner only on completion, and to other members only with separate consent', () => {
    const first = answer('alex');
    const partner = answer('sam');
    expect(canViewAnswer(first, [first], 'sam', pair, members)).toBe(false);
    expect(canViewAnswer(first, [first, partner], 'sam', pair, members)).toBe(true);
    expect(canViewAnswer(first, [first, partner], 'lee', pair, members)).toBe(false);
    const shared = answer('alex', { shareToProfile: true });
    expect(canViewAnswer(shared, [shared], 'lee', pair, members)).toBe(false);
    expect(canViewAnswer(shared, [shared, partner], 'lee', pair, members)).toBe(true);
    expect(canViewAnswer(shared, [shared, partner], 'outsider', pair, members)).toBe(false);
  });

  it('withdraws release when active pairing or membership changes without changing stored consent', () => {
    const first = answer('alex', { shareToProfile: true });
    const records = [first, answer('sam')];
    expect(canViewAnswer(first, records, 'sam', null, members)).toBe(false);
    expect(canViewAnswer(first, records, 'lee', ['alex', 'lee'], members)).toBe(false);
    expect(canViewAnswer(first, records, 'lee', pair, members.filter(member => member.id !== 'sam'))).toBe(false);
    expect(first.data).toMatchObject({ shareToProfile: true, participantIds: ['alex', 'sam'] });
  });
});
