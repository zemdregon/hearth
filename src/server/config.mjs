import { z } from 'zod';

const memberSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254).transform(value => value.toLowerCase()),
  role: z.enum(['admin', 'member']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
}).strict();
const membersSchema = z.array(memberSchema).min(1).max(20).superRefine((members, ctx) => {
  if (new Set(members.map(member => member.id)).size !== members.length || new Set(members.map(member => member.email)).size !== members.length) {
    ctx.addIssue({ code: 'custom', message: 'Family ids and emails must be unique' });
  }
  if (!members.some(member => member.role === 'admin')) ctx.addIssue({ code: 'custom', message: 'An administrator is required' });
});

export function parseFamilyMembers(value) {
  if (typeof value !== 'string') throw new Error('Family members must be JSON text');
  return membersSchema.parse(JSON.parse(value));
}

export function parseAccessDomain(value) {
  if (typeof value !== 'string') throw new Error('An Access team domain is required');
  const domain = value.replace(/^https:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/i.test(domain)) throw new Error('Use a Cloudflare Access team domain');
  return domain.toLowerCase();
}

export function parseTimezone(value = 'UTC') {
  if (typeof value !== 'string' || !value) throw new Error('A valid timezone is required');
  new Intl.DateTimeFormat('en', { timeZone: value }).format();
  return value;
}
