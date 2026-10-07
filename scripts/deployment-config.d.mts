export const deploymentSecretNames: string[];
export type DeploymentConfiguration = { databaseName: string; migrationsDirectory: string; workerName: string; secrets: Record<string, string> };
export function validateDeployment(config: unknown, environment: Record<string, string | undefined>): { problems: string[]; deployment?: DeploymentConfiguration };
