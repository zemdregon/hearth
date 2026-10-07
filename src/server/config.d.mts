import type { User } from '../shared/types';

export function parseFamilyMembers(value: unknown): User[];
export function parseAccessDomain(value: unknown): string;
export function parseTimezone(value?: unknown): string;
