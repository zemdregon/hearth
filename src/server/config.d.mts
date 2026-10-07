import type { QuestionPair, User } from '../shared/types';

export function parseFamilyMembers(value: unknown): User[];
export function parseQuestionPair(value: unknown, members: User[]): QuestionPair | null;
export function parseAccessDomain(value: unknown): string;
export function parseTimezone(value?: unknown): string;
