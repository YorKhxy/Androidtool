import * as fs from 'fs';
import * as path from 'path';

export type AdbBinarySource = 'bundled' | 'system';

export interface ResolvedAdbBinary {
  path: string;
  source: AdbBinarySource;
}

type SupportedPlatformToolsTarget = 'win' | 'darwin' | 'linux';

const EXECUTABLE_NAME = process.platform === 'win32' ? 'adb.exe' : 'adb';
const PROCESS_WITH_RESOURCES = process as NodeJS.Process & { resourcesPath?: string };

const getPlatformToolsTarget = (): SupportedPlatformToolsTarget | null => {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  return null;
};

const isExistingFile = (candidatePath: string): boolean => {
  try {
    return fs.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
};

export const getBundledAdbCandidates = (): string[] => {
  const target = getPlatformToolsTarget();
  if (!target) {
    return [];
  }

  const relativeExecutablePath = path.join('platform-tools', target, 'platform-tools', EXECUTABLE_NAME);
  const projectRootCandidate = path.resolve(process.cwd(), 'vendor', relativeExecutablePath);
  const compiledRootCandidate = path.resolve(__dirname, '../../../../vendor', relativeExecutablePath);
  const resourcesCandidate = PROCESS_WITH_RESOURCES.resourcesPath
    ? path.join(PROCESS_WITH_RESOURCES.resourcesPath, relativeExecutablePath)
    : '';

  return [resourcesCandidate, projectRootCandidate, compiledRootCandidate].filter(Boolean);
};

export const resolveBundledAdbBinaryPath = (): string | null => {
  for (const candidatePath of getBundledAdbCandidates()) {
    if (isExistingFile(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
};
