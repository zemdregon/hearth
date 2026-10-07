import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemo, demoMembers, visibleDemo } from '../src/client/demo';
import { visibleRecords } from '../src/server/db';
import { questionForDate } from '../src/shared/questions';
import { kindModule, moduleIds } from '../src/shared/types';
import type { Bootstrap, FamilyRecord, User } from '../src/shared/types';

const ids = (records: FamilyRecord[]) => records.map(record => record.id).sort();
const day = '2026-01-01';
const lee: User = { id: 'lee', name: 'Lee', email: 'lee@example.test', role: 'member', color: '#426c85' };

function answer(ownerId: string, date = day, overrides: Partial<FamilyRecord<'answer'>['data']> = {}): FamilyRecord<'answer'> {
  return { id: `${ownerId}-${date}`, kind: 'answer', ownerId, data: { date, questionId: questionForDate(date).id, choice: 0, shareToProfile: false, ...overrides }, createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, version: 1 };
}

function expectParity(source: Bootstrap) {
  for (const user of source.members) {
    const view = visibleDemo({ ...source, user });
    expect(ids(view.records), `Visibility for ${user.name}`).toEqual(ids(visibleRecords(source.records, user, source.members, source.modules)));
  }
}

afterEach(() => vi.useRealTimers());

describe('local demo fixture', () => {
  it('uses UTC calendar dates consistently at midnight and leap day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2024-03-01T00:00:00.001Z'));
    const source = createDemo();
    expect(source.timezone).toBe('UTC');
    expect(source.demo).toBe(true);
    expect(source.records.find(record => record.id === 'note-today')?.data).toMatchObject({ date: '2024-03-01' });
    expect(source.records.find(record => record.id === 'walk-1')?.data).toMatchObject({ date: '2024-02-29' });
    expect(source.records.find(record => record.id === 'walk-7')?.data).toMatchObject({ date: '2024-02-23' });
    expect(source.members.every(member => member.email.endsWith('@example.test'))).toBe(true);
  });

  it('returns fresh records so a new demo discards earlier sample edits', () => {
    const first = createDemo();
    const recipe = first.records.find(record => record.kind === 'recipe');
    if (!recipe || recipe.kind !== 'recipe') throw new Error('Recipe fixture is required.');
    recipe.data.title = 'Changed in this demo';
    recipe.data.ingredients[0].name = 'Changed ingredient';
    first.records.splice(1, 1);
    const second = createDemo();
    expect(second.records.find(record => record.id === recipe.id)?.data).not.toMatchObject({ title: 'Changed in this demo' });
    const secondRecipe = second.records.find(record => record.id === recipe.id);
    expect(secondRecipe?.kind === 'recipe' && secondRecipe.data.ingredients[0].name).not.toBe('Changed ingredient');
    expect(second.records.length).toBe(first.records.length + 1);
  });
});

describe('demo visibility follows the real API policy', () => {
  it('shows shared moods and only the current member’s private moods', () => {
    const source = createDemo();
    expectParity(source);
    const admin = visibleDemo(source);
    expect(ids(admin.records)).toContain('mood-alex');
    expect(ids(admin.records)).not.toContain('mood-sam');
    const sam = visibleDemo({ ...source, user: demoMembers[1] });
    expect(ids(sam.records)).toContain('mood-alex');
    expect(ids(sam.records)).toContain('mood-sam');
  });

  it('keeps an opted-in answer private until the other member answers the same prompt and day', () => {
    const source = createDemo();
    source.records.push(answer('alex', day, { shareToProfile: true }));
    expectParity(source);
    expect(visibleDemo({ ...source, user: demoMembers[1] }).records.some(record => record.kind === 'answer')).toBe(false);
    source.records.push(answer('sam', '2026-01-02'));
    expectParity(source);
    expect(visibleDemo(source).records.filter(record => record.kind === 'answer')).toHaveLength(1);
    source.records.push(answer('sam', day, { questionId: 'different-question' }));
    expectParity(source);
    expect(visibleDemo(source).records.filter(record => record.kind === 'answer')).toHaveLength(1);
  });

  it('reveals answers together after every configured member has answered', () => {
    const source = createDemo();
    source.members = [...source.members, lee];
    source.records.push(answer('alex'), answer('sam'));
    expectParity(source);
    expect(visibleDemo(source).records.filter(record => record.kind === 'answer')).toHaveLength(1);
    expect(visibleDemo({ ...source, user: lee }).records.filter(record => record.kind === 'answer')).toHaveLength(0);
    source.records.push(answer('lee'));
    expectParity(source);
    for (const user of source.members) {
      expect(visibleDemo({ ...source, user }).records.filter(record => record.kind === 'answer')).toHaveLength(3);
    }
  });

  it('hides a departed member’s answer even after every current member answers', () => {
    const source = createDemo();
    source.records.push(answer('alex'), answer('sam'), answer('departed-member', day, { shareToProfile: true }));
    expectParity(source);
    expect(visibleDemo(source).records.filter(record => record.kind === 'answer').map(record => record.ownerId).sort()).toEqual(['alex', 'sam']);
  });

  it('keeps disabled modules hidden and restores their unchanged data when re-enabled', () => {
    const source = createDemo();
    source.records.push(answer('alex'), answer('sam'));
    const original = JSON.stringify(source);
    const originalVisible = ids(visibleDemo(source).records);
    for (const module of moduleIds) {
      const paused = { ...source, modules: source.modules.map(item => item.id === module ? { ...item, enabled: false } : item) };
      expectParity(paused);
      expect(visibleDemo(paused).records.every(record => kindModule[record.kind] !== module)).toBe(true);
    }
    const allPaused = { ...source, modules: source.modules.map(module => ({ ...module, enabled: false })) };
    expect(visibleDemo(allPaused).records).toHaveLength(0);
    expectParity(allPaused);
    expect(JSON.stringify(source)).toBe(original);
    expect(ids(visibleDemo(source).records)).toEqual(originalVisible);
  });

  it('hides a partner’s answer again if a required answer is removed', () => {
    const source = createDemo();
    source.records.push(answer('alex'), answer('sam'));
    expect(visibleDemo(source).records.filter(record => record.kind === 'answer')).toHaveLength(2);
    source.records = source.records.filter(record => record.id !== `alex-${day}`);
    expectParity(source);
    expect(visibleDemo(source).records.filter(record => record.kind === 'answer')).toHaveLength(0);
    expect(visibleDemo({ ...source, user: demoMembers[1] }).records.filter(record => record.kind === 'answer')).toHaveLength(1);
  });
});
