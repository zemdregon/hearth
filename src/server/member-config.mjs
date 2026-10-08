import { z } from 'zod';

const member = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
  role: z.enum(['admin', 'member']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  status: z.enum(['pending', 'suspended']),
}).strict();

const roster = z.array(member).min(1).max(20).superRefine((members, ctx) => {
  if (new Set(members.map(value => value.id)).size !== members.length) {
    ctx.addIssue({ code: 'custom', message: 'Member ids must be unique' });
  }
  if (!members.some(value => value.role === 'admin' && value.status === 'pending')) {
    ctx.addIssue({ code: 'custom', message: 'A pending administrator is required' });
  }
});

/** Validates only a proposed roster; does not authorize enrollment or import it. */
export function parseEnrollmentRoster(value) {
  try {
    if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 32768) throw new Error();
    return roster.parse(JSON.parse(value));
  } catch {
    // Do not expose supplied names, legacy emails or unknown credential fields.
    throw new Error('Invalid enrollment roster. Use 1–20 unique members with id, name, role, color and pending/suspended status, including a pending administrator.');
  }
}
