import type { EnrollmentRosterMember } from '../src/shared/members';

export type OperatorOptions = {
  command: 'import' | 'bootstrap' | 'recover' | 'restore-lock'; remote: boolean; apply: boolean;
  config: string; expiresIn: number; input?: string; member?: string;
  persistTo?: string; output?: string; review?: string; help?: false;
};
export type OperatorTarget = {
  config: string; remote: boolean; persistTo: string | null;
  databaseName: string; databaseId: string; accountId: string | null;
};
export type OperatorSnapshot = {
  members: string; references_json: string; invalid_references: number;
  credential_count: number; tombstone_count: number; bootstrap_count: number; revision: string; auth_scope: 'member' | 'all';
};
export type OperatorPlan = {
  command: OperatorOptions['command']; member: string | null; target: OperatorTarget;
  roster: EnrollmentRosterMember[] | null; historicalIds: string[];
  revision: string; expiresIn: number; review: string;
};
export type OperatorRequest = { command?: string; file?: string };
export const operatorHelp: string;
export const referenceSql: string;
export function parseOperatorArgs(args: string[]): OperatorOptions | { help: true };
export function loadOperatorTarget(options: OperatorOptions): OperatorTarget;
export function operatorSnapshotSql(member?: string, allAuth?: boolean): string;
export function createOperatorPlan(options: OperatorOptions, target: OperatorTarget, snapshot: OperatorSnapshot, roster?: EnrollmentRosterMember[]): OperatorPlan;
export function createOperatorMutation(plan: OperatorPlan, material?: { now?: number; token?: string; operationId?: string; handles?: string[] }): { sql: string; operationId: string; grant: { memberId: string; purpose: string; token: string; createdAt: number; expiresAt: number } | null };
export function wranglerArguments(target: OperatorTarget, request: OperatorRequest): string[];
export function parseWranglerOutput(stdout: string, allowImportProgress?: boolean): Record<string, unknown>[];
export function runOperator(options: OperatorOptions, dependencies?: { execute?: (target: OperatorTarget, request: OperatorRequest) => Record<string, unknown>[]; print?: (message: string) => void }): { applied: boolean; review: string };
