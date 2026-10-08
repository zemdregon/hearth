import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemo, demoMembers, prepareDemoAnswer, visibleDemo } from '../src/client/demo';
import { visibleRecords } from '../src/server/db';
import { questionForDate } from '../src/shared/questions';
import { kindModule, moduleIds } from '../src/shared/types';
import type { Bootstrap, FamilyRecord, User } from '../src/shared/types';

const ids = (records: FamilyRecord[]) => records.map(record => record.id).sort();
const day = '2026-01-01';
const lee: User = { id: 'lee', name: 'Lee', role: 'member', color: '#426c85' };

function answer(ownerId: string, date = day, overrides: Partial<FamilyRecord<'answer'>['data']> = {}): FamilyRecord<'answer'> {
  return { id: `${ownerId}-${date}`, kind: 'answer', ownerId, data: { date, questionId: questionForDate(date).id, choice: 0, shareToProfile: false, participantIds: ['alex', 'sam'], ...overrides }, createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z`, version: 1 };
}

function expectParity(source: Bootstrap) {
  for (const user of source.members) {
    const view = visibleDemo({ ...source, user });
    expect(ids(view.records), `Visibility for ${user.name}`).toEqual(ids(visibleRecords(source.records, user, source.members, source.modules, source.questionPair)));
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
    expect(source.members.every(member => !('email' in member))).toBe(true);
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

  it('reveals only within the explicit pair and releases opted-in preferences to other household members', () => {
    const source = createDemo();
    source.members = [...source.members, lee];
    source.records.push(answer('alex'), answer('sam'));
    expectParity(source);
    expect(visibleDemo(source).records.filter(record => record.kind === 'answer')).toHaveLength(2);
    expect(visibleDemo({ ...source, user: lee }).records.filter(record => record.kind === 'answer')).toHaveLength(0);
    source.records = source.records.map(record => record.kind === 'answer' && record.ownerId === 'alex' ? { ...record, data: { ...record.data, shareToProfile: true } } : record);
    expectParity(source);
    expect(visibleDemo({ ...source, user: lee }).records.filter(record => record.kind === 'answer').map(record => record.ownerId)).toEqual(['alex']);
  });

  it('keeps legacy and previous-pair answers private even when profile consent was recorded', () => {
    const source = createDemo();
    source.members = [...source.members, lee];
    source.records.push(answer('alex', day, { participantIds: undefined, shareToProfile: true }), answer('sam', day, { participantIds: undefined, shareToProfile: true }));
    expectParity(source);
    expect(visibleDemo(source).records.filter(record => record.kind === 'answer').map(record => record.ownerId)).toEqual(['alex']);
    expect(visibleDemo({ ...source, user: lee }).records.filter(record => record.kind === 'answer')).toHaveLength(0);
    source.records = [answer('alex', day, { shareToProfile: true }), answer('sam', day, { shareToProfile: true })];
    source.questionPair = ['alex', 'lee'];
    expectParity(source);
    expect(visibleDemo({ ...source, user: lee }).records.filter(record => record.kind === 'answer')).toHaveLength(0);
    source.questionPair = null;
    expectParity(source);
    expect(visibleDemo(source).records.filter(record => record.kind === 'answer').map(record => record.ownerId)).toEqual(['alex']);
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

describe('demo answer mutations preserve the same audience constraints', () => {
  it('normalizes a current expected pair and rejects stale or missing pairs', () => {
    const source = createDemo();
    const data = answer('alex').data;
    expect(prepareDemoAnswer(source, { ...data, participantIds: ['sam', 'alex'] }).participantIds).toEqual(['alex', 'sam']);
    expect(() => prepareDemoAnswer(source, { ...data, participantIds: undefined })).toThrow('pairing changed');
    expect(() => prepareDemoAnswer(source, { ...data, participantIds: ['alex', 'lee'] })).toThrow('pairing changed');
    expect(() => prepareDemoAnswer({ ...source, questionPair: null }, data)).toThrow('configured couple');
    expect(() => prepareDemoAnswer({ ...source, user: lee }, data)).toThrow('configured couple');
  });

  it('preserves identity and allows only withdrawal for old or legacy scopes', () => {
    const source = createDemo();
    const original = answer('alex');
    expect(() => prepareDemoAnswer(source, { ...original.data, date: '2026-02-02', questionId: questionForDate('2026-02-02').id }, original)).toThrow('cannot be changed');
    expect(() => prepareDemoAnswer(source, { ...original.data, participantIds: ['sam', 'alex'] }, original)).toThrow('cannot be changed');
    const legacy = answer('alex', day, { participantIds: undefined, shareToProfile: true });
    expect(prepareDemoAnswer(source, { ...legacy.data, shareToProfile: false }, legacy).participantIds).toBeUndefined();
    expect(() => prepareDemoAnswer(source, { ...legacy.data, participantIds: ['alex', 'sam'] }, legacy)).toThrow('cannot be changed');
    const unsharedLegacy = { ...legacy, data: { ...legacy.data, shareToProfile: false } };
    expect(() => prepareDemoAnswer(source, { ...unsharedLegacy.data, shareToProfile: true }, unsharedLegacy)).toThrow('private');
  });

  it('does not repurpose a day already answered under another scope or create duplicates', () => {
    const source = createDemo();
    source.records.push(answer('sam', day, { participantIds: undefined }));
    expect(() => prepareDemoAnswer(source, answer('alex').data)).toThrow('Start a new question tomorrow');
    source.records = [answer('alex')];
    expect(() => prepareDemoAnswer(source, answer('alex').data)).toThrow('already exists');
  });
});
