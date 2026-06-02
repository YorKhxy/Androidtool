import * as fs from 'fs';
import * as path from 'path';

export type ScrcpyBinarySource = 'bundled' | 'system';

export interface ResolvedScrcpyBinary {
  path: string;
  source: ScrcpyBinarySource;
}

type SupportedScrcpyTarget = 'win';

// scrcpy 目前仅随应用打包 Windows 预编译包，其余平台依赖系统安装的 scrcpy。
const EXECUTABLE_NAME = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy';
const PROCESS_WITH_RESOURCES = process as NodeJS.Process & { resourcesPath?: string };

const getScrcpyTarget = (): SupportedScrcpyTarget | null => {
  if (process.platform === 'win32') return 'win';
  return null;
};

const isExistingFile = (candidatePath: string): boolean => {
  try {
    return fs.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
};

export const getBundledScrcpyCandidates = (): string[] => {
  const target = getScrcpyTarget();
  if (!target) {
    return [];
  }

  const relativeExecutablePath = path.join('scrcpy', target, EXECUTABLE_NAME);
  const projectRootCandidate = path.resolve(process.cwd(), 'vendor', relativeExecutablePath);
  const compiledRootCandidate = path.resolve(__dirname, '../../../../vendor', relativeExecutablePath);
  const resourcesCandidate = PROCESS_WITH_RESOURCES.resourcesPath
    ? path.join(PROCESS_WITH_RESOURCES.resourcesPath, relativeExecutablePath)
    : '';

  return [resourcesCandidate, projectRootCandidate, compiledRootCandidate].filter(Boolean);
};

export const resolveBundledScrcpyBinaryPath = (): string | null => {
  for (const candidatePath of getBundledScrcpyCandidates()) {
    if (isExistingFile(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
};
