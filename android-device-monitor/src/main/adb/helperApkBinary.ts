import * as fs from 'fs';
import * as path from 'path';

// Pico 弱网助手 APK（pico-network-helper）随应用打包，运行时定位其绝对路径。
// 打包时由 scripts/prepare-helper-apk.js 暂存到 vendor/pico-helper/，
// 经 electron-builder extraResources 拷贝为 resources/pico-helper/。
// 路径全部从锚点推导，禁止硬编码盘符/绝对路径（见仓库 CLAUDE.md 路径规范）。

export const HELPER_APK_FILE_NAME = 'pico-network-helper.apk';

const PROCESS_WITH_RESOURCES = process as NodeJS.Process & { resourcesPath?: string };

const isExistingFile = (candidatePath: string): boolean => {
  try {
    return fs.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
};

export const getHelperApkCandidates = (): string[] => {
  const relativeApkPath = path.join('pico-helper', HELPER_APK_FILE_NAME);

  // 生产：打包后位于 process.resourcesPath/pico-helper/。
  const resourcesCandidate = PROCESS_WITH_RESOURCES.resourcesPath
    ? path.join(PROCESS_WITH_RESOURCES.resourcesPath, relativeApkPath)
    : '';
  // 开发：从项目工作目录的 vendor/ 取。
  const projectRootCandidate = path.resolve(process.cwd(), 'vendor', relativeApkPath);
  // 开发：从编译产物目录回推到 vendor/（dist/main/main → 项目根）。
  const compiledRootCandidate = path.resolve(__dirname, '../../../../vendor', relativeApkPath);

  return [resourcesCandidate, projectRootCandidate, compiledRootCandidate].filter(Boolean);
};

export const resolveHelperApkPath = (): string => {
  const candidates = getHelperApkCandidates();
  for (const candidatePath of candidates) {
    if (isExistingFile(candidatePath)) {
      return candidatePath;
    }
  }
  throw new Error(
    `未找到内置弱网助手 APK（${HELPER_APK_FILE_NAME}）。已检查：\n` +
      candidates.map((candidate) => `  - ${candidate}`).join('\n') +
      `\n请先在 pico-network-helper 执行 gradlew assembleDebug，并运行 npm run helper:prepare。`
  );
};
