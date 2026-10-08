import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { familyCapacity, FAMILY_DATA_BYTES_LIMIT, FAMILY_RECORD_LIMIT } from '../src/shared/capacity';
import { createDemo, visibleDemo } from '../src/client/demo';
import type { FamilyRecord } from '../src/shared/types';

describe('coarse family capacity', () => {
  it('warns at either threshold, including exact byte and item boundaries', () => {
    const warningBytes = Math.ceil(FAMILY_DATA_BYTES_LIMIT * 0.8);
    expect(familyCapacity(warningBytes - 1, 7999)).toBe('available');
    expect(familyCapacity(warningBytes, 0)).toBe('near-limit');
    expect(familyCapacity(0, 8000)).toBe('near-limit');
    expect(familyCapacity(FAMILY_DATA_BYTES_LIMIT - 1, 9999)).toBe('near-limit');
    expect(familyCapacity(FAMILY_DATA_BYTES_LIMIT, 0)).toBe('full');
    expect(familyCapacity(0, FAMILY_RECORD_LIMIT)).toBe('full');
    expect(familyCapacity(FAMILY_DATA_BYTES_LIMIT + 1, FAMILY_RECORD_LIMIT + 1)).toBe('full');
  });

  it('keeps guidance ceilings aligned with the deployed atomic SQL guards', () => {
    const migration = readFileSync(new URL('../migrations/0002_storage_budget.sql', import.meta.url), 'utf8');
    expect(migration).toContain(`record_count FROM family_storage WHERE id = 1) >= ${FAMILY_RECORD_LIMIT}`);
    expect(migration.match(new RegExp(`> ${FAMILY_DATA_BYTES_LIMIT}`, 'g'))).toHaveLength(2);
  });

  it('counts private and paused demo data without revealing it and recomputes after removal', () => {
    const source = createDemo();
    const hidden: FamilyRecord<'mood'> = { id: 'private-large', kind: 'mood', ownerId: 'sam', data: { date: '2026-01-01', score: 3, shared: false, note: '🌿'.repeat(1_700_000) }, version: 1, createdAt: '', updatedAt: '' };
    source.records = [hidden];
    source.modules = source.modules.map(module => ({ ...module, enabled: false }));
    const view = visibleDemo(source);
    expect(view.capacity).toBe('near-limit');
    expect(view.records).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('private-large');
    expect(source.records).toEqual([hidden]);
    expect(visibleDemo({ ...source, records: [] }).capacity).toBe('available');
  });
});
