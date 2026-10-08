import type { FamilyRecord, RecordDataMap, RecordKind } from '../../src/shared/types';
import { addDays } from '../../src/shared/calendar';
import { questionForDate } from '../../src/shared/questions';

/** Fictional, deterministic families near today's enforced record ceiling. */
export function scalingRecords(days: number, habits: number): FamilyRecord[] {
  const records: FamilyRecord[] = [];
  function add<K extends RecordKind>(kind: K, id: string, data: RecordDataMap[K], ownerId = 'alex', date = '2025-01-01') {
    records.push({ id, kind, ownerId, data, version: 1, createdAt: `${date}T12:00:00.000Z`, updatedAt: `${date}T12:00:00.000Z` } as FamilyRecord);
  }
  for (let i = 0; i < 500; i++) add('recipe', `recipe-${i}`, {
    title: `Family recipe ${i}`, description: `A fictional family meal ${i}. ` + 'Prepare together and serve at the table. '.repeat(6),
    servings: 4, prepMinutes: 20, cookMinutes: 30, favorite: i % 4 === 0, tags: ['Dinner', `Group ${i % 12}`],
    ingredients: Array.from({ length: 12 }, (_, j) => ({ name: `Ingredient ${i}-${j}`, quantity: j + 1, unit: 'g', note: 'Prepared before cooking' })),
    steps: Array.from({ length: 8 }, (_, j) => `Step ${j + 1} for recipe ${i}. ` + 'Combine the prepared ingredients and cook until ready. '.repeat(3)),
  });
  for (let day = 0; day < days; day++) {
    const date = addDays('2020-01-01', day);
    for (const member of ['alex', 'sam']) {
      add('mood', `mood-${member}-${day}`, { date, score: (day % 5) + 1, shared: true, note: `Fictional day ${day} for ${member}. ` + 'A quiet walk and time together. '.repeat(6) }, member, date);
      add('answer', `answer-${member}-${day}`, { date, questionId: questionForDate(date).id, choice: 0, shareToProfile: false, participantIds: ['alex', 'sam'] }, member, date);
    }
    for (let habit = 0; habit < habits; habit++) add('habitLog', `log-${habit}-${day}`, { habitId: `habit-${habit}`, date }, habit % 2 === 0 ? 'alex' : 'sam', date);
  }
  for (let i = 0; i < habits; i++) {
    const owner = i % 2 === 0 ? 'alex' : 'sam';
    add('habit', `habit-${i}`, { title: `Habit ${i}`, userId: owner, color: '#557461' }, owner);
  }
  for (const member of ['alex', 'sam']) add('profile', `profile-${member}`, { bio: 'A fictional family member.', loves: ['Walking', 'Cooking'], suggestions: ['Plan a day outside'] }, member);
  for (let i = 0; i < 100; i++) {
    add('task', `task-${i}`, { title: `Family task ${i}`, done: i % 2 === 0 });
    add('note', `note-${i}`, { date: addDays('2020-01-01', i), text: `Family note ${i}. ` + 'Remember the little things. '.repeat(5) });
  }
  for (let i = 0; i < 50; i++) add('event', `event-${i}`, { title: `Family event ${i}`, date: addDays('2025-01-01', i), emoji: '🌿', description: 'A fictional family gathering.' });
  for (let i = 0; i < 20; i++) add('goal', `goal-${i}`, { title: `Family goal ${i}`, description: 'Make time for a new adventure.', completed: false, milestones: [{ id: `step-${i}`, title: 'Make a plan', done: false }] });
  return records;
}
