import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnrollmentRoster } from '../src/server/member-config.mjs';
import { checkRosterFile } from '../scripts/check-auth-roster.mjs';

const admin = { id: 'alex', name: 'Alex', role: 'admin', color: '#38634A', status: 'pending' };
const former = { id: 'sam', name: 'Sam', role: 'member', color: '#A96743', status: 'suspended' };
const folders: string[] = [];
function file(contents: string | Uint8Array) {
  const folder = mkdtempSync(join(tmpdir(), 'hearth-roster-'));
  folders.push(folder);
  const filename = join(folder, 'roster.json');
  writeFileSync(filename, contents);
  return filename;
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('email-free enrollment roster', () => {
  it('preserves permanent ids and suspended historical identities without activating anyone', () => {
    const members = parseEnrollmentRoster(JSON.stringify([admin, former]));
    expect(members).toEqual([admin, former]);
    expect(Object.keys(members[0]).sort()).toEqual(['color', 'id', 'name', 'role', 'status']);
    expect(parseEnrollmentRoster(JSON.stringify([{ ...admin, name: ' Alex ' }]))[0].name).toBe('Alex');
  });

  it.each([
    [], [former], [{ ...admin, status: 'active' }], [{ ...admin, status: 'suspended' }],
    [admin, { ...former, id: admin.id }], [{ ...admin, id: ' alex' }],
    [{ ...admin, id: 'a'.repeat(65) }], [{ ...admin, name: 'a'.repeat(101) }],
    [{ ...admin, name: 'Alex\u0000' }], [{ ...admin, role: 'owner' }],
    [{ ...admin, color: 'red' }], [{ ...admin, email: 'private-sentinel@example.test' }],
    [{ ...admin, password: 'private-sentinel' }], [{ ...admin, status: undefined }],
    [{ ...admin, user_handle: 'injected' }],
    Array.from({ length: 21 }, (_, index) => ({ ...admin, id: `member${index}` })),
  ].map(input => ({ input })))('rejects invalid, activating, duplicated or credential-bearing roster %#', ({ input }) => {
    expect(() => parseEnrollmentRoster(JSON.stringify(input))).toThrow('Invalid enrollment roster');
  });

  it('bounds encoded bytes and never includes supplied private values in validation errors', () => {
    for (const input of [undefined, null, {}, 'not-json', ' '.repeat(32769), JSON.stringify([{ ...admin, email: 'private-sentinel@example.test' }])]) {
      try { parseEnrollmentRoster(input); expect.fail('Expected validation failure'); }
      catch (error) {
        expect(String(error)).toContain('Invalid enrollment roster');
        expect(String(error)).not.toContain('private-sentinel');
      }
    }
    const input = JSON.stringify([admin]) + ' '.repeat(32768);
    expect(() => parseEnrollmentRoster(input)).toThrow();
  });
});

describe('offline roster check command', () => {
  it('checks an explicit file without rewriting it or displaying member values', () => {
    const original = JSON.stringify([admin, former]);
    const filename = file(original);
    expect(checkRosterFile(filename)).toEqual([admin, former]);
    const result = spawnSync(process.execPath, ['scripts/check-auth-roster.mjs', '--input', filename], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2 members; 1 pending, 1 suspended');
    expect(result.stdout).toContain('No database changes');
    expect(result.stdout).not.toContain(admin.name);
    expect(readFileSync(filename, 'utf8')).toBe(original);
  });

  it('rejects invalid UTF-8 and oversized input before parsing', () => {
    expect(() => checkRosterFile(file(new Uint8Array([0xff])))).toThrow();
    expect(() => checkRosterFile(file(' '.repeat(32769)))).toThrow();
  });

  it('rejects unknown operation flags and reports errors without source values', () => {
    const filename = file(JSON.stringify([{ ...admin, email: 'private-sentinel@example.test' }]));
    for (const args of [[], ['--apply'], ['--input', filename], ['--input', filename, '--remote']]) {
      const result = spawnSync(process.execPath, ['scripts/check-auth-roster.mjs', ...args], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('private-sentinel');
      expect(result.stderr).not.toContain(filename);
      expect(result.stderr).toContain('No database changes');
    }
  });
});
