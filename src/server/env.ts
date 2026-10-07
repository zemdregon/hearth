import type { User } from '../shared/types';

export interface Env {
  DB: D1Database;
  AI?: Ai;
  ASSETS?: Fetcher;
  FAMILY_MEMBERS?: string;
  FAMILY_TIMEZONE?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  APP_ORIGIN?: string;
  DEV_AUTH?: string;
}

export type FamilyConfig = { members: User[]; timezone: string; origin: string; dev: boolean };
export type Variables = { user: User; family: FamilyConfig };

export class ApiError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503, message: string) {
    super(message);
  }
}
