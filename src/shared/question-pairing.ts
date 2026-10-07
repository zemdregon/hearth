import type { FamilyRecord, QuestionPair, User } from './types';

/** Missing scopes (including legacy answers) never identify a pair. */
export function sameQuestionPair(left: readonly string[] | null | undefined, right: readonly string[] | null | undefined): boolean {
  const valid = (pair: readonly string[] | null | undefined): pair is readonly [string, string] =>
    Array.isArray(pair) && pair.length === 2 && pair.every(id => typeof id === 'string' && id.length > 0) && pair[0] !== pair[1];
  return valid(left) && valid(right) && left.every(id => right.includes(id));
}

/** Evaluate against the complete record set, before applying viewer visibility. */
export function answerPairComplete(answer: FamilyRecord<'answer'>, records: readonly FamilyRecord[], pair: QuestionPair | null): boolean {
  if (!pair || !sameQuestionPair(answer.data.participantIds, pair) || !pair.includes(answer.ownerId)) return false;
  return pair.every(ownerId => records.some(record => record.kind === 'answer'
    && record.ownerId === ownerId
    && record.data.date === answer.data.date
    && record.data.questionId === answer.data.questionId
    && sameQuestionPair(record.data.participantIds, pair)));
}

export function canViewAnswer(answer: FamilyRecord<'answer'>, records: readonly FamilyRecord[], viewerId: string, pair: QuestionPair | null, members: readonly User[]): boolean {
  if (answer.ownerId === viewerId) return true;
  if (!pair || !members.some(member => member.id === viewerId) || !pair.every(id => members.some(member => member.id === id))) return false;
  return answerPairComplete(answer, records, pair) && (pair.includes(viewerId) || answer.data.shareToProfile === true);
}
