import { describe, expect, it } from 'vitest';
import { failureMessage } from '../src/client/modules/family-ui';

const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

describe('family mutation failure wording', () => {
  it('explains an edit conflict only for a save that lost a version race', () => {
    expect(failureMessage(failure('Refresh and try again.', 409), 'save')).toMatch(/changed while you were editing/);
    expect(failureMessage(failure('Refresh and try again.', 409), 'delete')).toBe('Refresh and try again.');
  });
  it('keeps the server’s own text when the family store is full', () => {
    const full = 'Family storage is full (8 MB or 10,000 items). Export and remove older items to make room.';
    expect(failureMessage(failure(full, 409), 'save')).toBe(full);
  });
  it('falls back to a generic message for non-errors', () => {
    expect(failureMessage('boom', 'save')).toBe('Something went wrong. Please try again.');
  });
});
