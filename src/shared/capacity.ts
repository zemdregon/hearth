import type { FamilyCapacity } from './types';

// Guidance only. D1's atomic triggers in 0002_storage_budget.sql enforce writes.
export const FAMILY_DATA_BYTES_LIMIT = 8_388_608;
export const FAMILY_RECORD_LIMIT = 10_000;

export function familyCapacity(dataBytes: number, recordCount: number): FamilyCapacity {
  if (dataBytes >= FAMILY_DATA_BYTES_LIMIT || recordCount >= FAMILY_RECORD_LIMIT) return 'full';
  if (dataBytes >= FAMILY_DATA_BYTES_LIMIT * 0.8 || recordCount >= FAMILY_RECORD_LIMIT * 0.8) return 'near-limit';
  return 'available';
}
