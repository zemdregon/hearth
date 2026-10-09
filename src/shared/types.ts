import type { MemberIdentity } from './members';
import type { InventoryExport } from './inventory/wire';

export const moduleIds = ['recipes', 'tasks', 'notes', 'streaks', 'events', 'moods', 'questions', 'profiles', 'goals', 'inventory'] as const;
export type ModuleId = typeof moduleIds[number];
export type User = MemberIdentity;
export type Ingredient = { name: string; quantity: number | null; quantityMax?: number; unit: string; note?: string };
export type Recipe = { title: string; description: string; servings: number; prepMinutes: number; cookMinutes: number; ingredients: Ingredient[]; steps: string[]; tags: string[]; sourceUrl?: string; favorite: boolean };
export type Task = { title: string; done: boolean; assigneeId?: string; dueDate?: string };
export type Note = { text: string; date: string };
export type Habit = { title: string; userId: string; color: string };
export type HabitLog = { habitId: string; date: string };
export type FamilyEvent = { title: string; date: string; emoji: string; description: string };
export type Mood = { date: string; score: number; note: string; shared: boolean };
export type QuestionPair = [string, string];
// Missing participants identify legacy answers, which remain visible only to their author.
export type Answer = { questionId: string; date: string; choice: number; shareToProfile: boolean; participantIds?: QuestionPair };
export type Profile = { bio: string; loves: string[]; suggestions: string[] };
export type Goal = { title: string; description: string; targetDate?: string; milestones: { id: string; title: string; done: boolean }[]; completed: boolean };
export type RecordDataMap = { recipe: Recipe; task: Task; note: Note; habit: Habit; habitLog: HabitLog; event: FamilyEvent; mood: Mood; answer: Answer; profile: Profile; goal: Goal };
export type RecordKind = keyof RecordDataMap;
export type FamilyRecord<K extends RecordKind = RecordKind> = K extends RecordKind ? { id: string; kind: K; ownerId: string; data: RecordDataMap[K]; createdAt: string; updatedAt: string; version: number } : never;
export type ModuleConfig = { id: ModuleId; enabled: boolean };
export type FamilyCapacity = 'available' | 'near-limit' | 'full';
export type Bootstrap = { user: User; members: User[]; modules: ModuleConfig[]; records: FamilyRecord[]; timezone: string; questionPair: QuestionPair | null; capacity?: FamilyCapacity; demo?: boolean };
export type FamilyExport = Bootstrap & { schemaVersion: number; exportedAt: string; scope: string; inventory?: InventoryExport };
export type RecipeImportRequest = { mode: 'url' | 'text' | 'image'; value: string; mimeType?: string };
export type RecipeImportResponse = { recipe: Recipe; warnings: string[] };
export const kindModule: Record<RecordKind, ModuleId> = { recipe:'recipes', task:'tasks', note:'notes', habit:'streaks', habitLog:'streaks', event:'events', mood:'moods', answer:'questions', profile:'profiles', goal:'goals' };
