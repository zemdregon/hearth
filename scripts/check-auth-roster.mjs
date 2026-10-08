import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnrollmentRoster } from '../src/server/member-config.mjs';

const help = `Validate a proposed email-free Hearth roster (offline, no database changes).

Usage: npm run auth:roster:check -- --input <roster.json>

Each member must have id, name, role (admin/member), color (#RRGGBB), and
status (pending/suspended). Include a pending administrator. Preserve every
existing member id exactly; never reassign an id to a different person.
This validates shape only: it does not verify ownership against a database,
import members, create invitations, activate accounts, or sign anyone in.
No environment credentials are read. Supplied roster values are not printed.
`;

export function checkRosterFile(filename) {
  const descriptor = openSync(filename, 'r');
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 32768) throw new Error('Roster must be a regular file of at most 32 KiB.');
    const buffer = Buffer.alloc(32769);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 32768) throw new Error('Roster exceeds 32 KiB.');
    return parseEnrollmentRoster(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally {
    closeSync(descriptor);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(help);
  } else if (args.length !== 2 || args[0] !== '--input' || !args[1] || args[1].startsWith('--')) {
    console.error('Use --input <roster.json>, or --help. No database changes were made.');
    process.exitCode = 1;
  } else {
    try {
      const members = checkRosterFile(args[1]);
      console.log(`Valid proposed roster: ${members.length} members; ${members.filter(member => member.status === 'pending').length} pending, ${members.filter(member => member.status === 'suspended').length} suspended. No database changes were made. Ownership review and passkey enrollment are still required.`);
    } catch {
      console.error('Roster validation failed. Check the file and required fields using --help. No database changes were made.');
      process.exitCode = 1;
    }
  }
}
