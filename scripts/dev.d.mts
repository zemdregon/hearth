import type { ChildProcess } from 'node:child_process';
export type DevOptions = { apiPort: number; uiPort: number; help: boolean; check: boolean; skipBuild: boolean };
export function parseOptions(args: string[], environment?: Record<string, string | undefined>): DevOptions;
export function ensureLocalVars(directory: string): Promise<boolean>;
export function makeLocalWorkerConfig(base: unknown, directory: string): { name: string; main: string; compatibility_date: string; compatibility_flags: string[]; assets: { directory: string; binding: string }; d1_databases: { binding: string; database_name: string; database_id: string; migrations_dir: string; remote: boolean }[]; vars: Record<string, string>; workers_dev: boolean; preview_urls: boolean; send_metrics: boolean; observability: { enabled: boolean } };
export function checkPortAvailable(port: number): Promise<void>;
export function localEnvironment(): Record<string, string | undefined>;
export function waitReady(url: string, service: 'api' | 'ui', signal: AbortSignal): Promise<void>;
export function checkLocalSession(url: string, signal: AbortSignal): Promise<void>;
export type ManagedProcess = { child: ChildProcess; label: string; exit: Promise<{ code: number | null; signal: string | null; error?: Error }> };
export class ProcessSupervisor {
  spawn(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string | undefined>; stdio?: 'ignore' | 'inherit'; label?: string }): ManagedProcess;
  release(managed: ManagedProcess): void;
  stop(signal?: 'SIGTERM' | 'SIGINT' | 'SIGKILL'): Promise<void>;
}
