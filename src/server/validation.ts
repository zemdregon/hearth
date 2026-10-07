import { z } from 'zod';
import type { RecordKind, RecordDataMap } from '../shared/types';
import { ApiError } from './env';

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '2200-12-31';
}, 'Use a valid calendar date between 1900 and 2200');
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const title = z.string().trim().min(1).max(200);
const shortText = z.string().trim().max(2000);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const ingredient = z.object({ name: z.string().trim().min(1).max(200), quantity: z.number().min(0).max(100_000).nullable(), quantityMax: z.number().min(0).max(100_000).optional(), unit: z.string().trim().max(50), note: z.string().trim().max(500).optional() }).strict().refine(value => value.quantityMax === undefined || (value.quantity !== null && value.quantityMax >= value.quantity), { message: 'Ingredient ranges must end at or above their starting quantity' });
const sourceUrl = z.url().max(2000).refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
}, 'Use an HTTP or HTTPS source URL');

export const dataSchemas = {
  recipe: z.object({ title, description: shortText, servings: z.number().int().min(1).max(1000), prepMinutes: z.number().int().min(0).max(10080), cookMinutes: z.number().int().min(0).max(10080), ingredients: z.array(ingredient).min(1).max(100), steps: z.array(z.string().trim().min(1).max(2000)).min(1).max(100), tags: z.array(z.string().trim().min(1).max(50)).max(20), sourceUrl: sourceUrl.optional(), favorite: z.boolean() }).strict(),
  task: z.object({ title, done: z.boolean(), assigneeId: id.optional(), dueDate: dateSchema.optional() }).strict(),
  note: z.object({ text: z.string().trim().min(1).max(5000), date: dateSchema }).strict(),
  habit: z.object({ title, userId: id, color }).strict(),
  habitLog: z.object({ habitId: id, date: dateSchema }).strict(),
  event: z.object({ title, date: dateSchema, emoji: z.string().max(20), description: shortText }).strict(),
  mood: z.object({ date: dateSchema, score: z.number().int().min(1).max(5), note: shortText, shared: z.boolean() }).strict(),
  answer: z.object({ questionId: id, date: dateSchema, choice: z.number().int().min(0).max(20), shareToProfile: z.boolean() }).strict(),
  profile: z.object({ bio: shortText, loves: z.array(z.string().trim().min(1).max(200)).max(30), suggestions: z.array(z.string().trim().min(1).max(500)).max(30) }).strict(),
  goal: z.object({ title, description: shortText, targetDate: dateSchema.optional(), milestones: z.array(z.object({ id, title, done: z.boolean() }).strict()).max(100).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Milestone ids must be unique'), completed: z.boolean() }).strict(),
} satisfies Record<RecordKind, z.ZodType>;

export const recordKindSchema = z.enum(['recipe', 'task', 'note', 'habit', 'habitLog', 'event', 'mood', 'answer', 'profile', 'goal']);
export const createSchema = z.object({ kind: recordKindSchema, data: z.unknown() }).strict();
export const updateSchema = z.object({ data: z.unknown(), version: z.number().int().positive().max(2_147_483_647) }).strict();
export const deleteSchema = z.object({ version: z.number().int().positive().max(2_147_483_647) }).strict();
export const moduleSchema = z.object({ enabled: z.boolean() }).strict();
export const importSchema = z.object({ mode: z.enum(['url', 'text', 'image']), value: z.string().min(1).max(7_000_000), mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional() }).strict();

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'Input'}: ${issue.message}`).join('; '));
  return parsed.data;
}

export function validateData<K extends RecordKind>(kind: K, input: unknown): RecordDataMap[K] {
  const data = parseInput<unknown>(dataSchemas[kind], input);
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 32_768) throw new ApiError(413, 'A record must be smaller than 32 KB.');
  return data as RecordDataMap[K];
}

export async function readJson(request: Request, limit = 65_536): Promise<unknown> {
  if (Number(request.headers.get('Content-Length')) > limit) throw new ApiError(413, 'This request is too large.');
  if (!request.body) throw new ApiError(400, 'A JSON request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(413, 'This request is too large.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'The request body must be valid JSON.');
  } finally { reader.releaseLock(); }
}
