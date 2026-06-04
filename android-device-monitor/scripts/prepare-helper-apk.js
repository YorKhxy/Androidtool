const fs = require('fs');
const path = require('path');

// 把 pico-network-helper 的构建产物（app-debug.apk）暂存到 android-device-monitor 的
// vendor/pico-helper/，供 electron-builder 通过 extraResources 随应用打包。
// 所有路径从脚本锚点（__dirname）推导，禁止硬编码盘符/绝对路径（见仓库 CLAUDE.md 路径规范）。

const PROJECT_ROOT = path.resolve(__dirname, '..'); // android-device-monitor/
const REPO_ROOT = path.resolve(PROJECT_ROOT, '..'); // 仓库根

// 助手 APK 的源（pico-network-helper 的 debug 构建产物）。
const HELPER_SOURCE_APK = path.join(
  REPO_ROOT,
  'pico-network-helper',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk'
);

// 暂存目标：vendor/pico-helper/pico-network-helper.apk（固定名，运行时定位不依赖版本）。
const TARGET_DIR = path.join(PROJECT_ROOT, 'vendor', 'pico-helper');
const TARGET_APK = path.join(TARGET_DIR, 'pico-network-helper.apk');

const main = () => {
  if (fs.existsSync(HELPER_SOURCE_APK)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
    fs.copyFileSync(HELPER_SOURCE_APK, TARGET_APK);
    console.log(`[helper:prepare] 已暂存弱网助手 APK：${TARGET_APK}`);
    return;
  }

  // 源 APK 不存在：若 vendor 已有旧产物则沿用并告警，否则报错指引先构建助手。
  if (fs.existsSync(TARGET_APK)) {
    console.warn(
      `[helper:prepare] 未找到新构建的助手 APK（${HELPER_SOURCE_APK}），沿用已暂存的 ${TARGET_APK}。`
    );
    return;
  }

  console.error('[helper:prepare] 未找到弱网助手 APK，且 vendor 中无已暂存产物。');
  console.error(`  期望源：${HELPER_SOURCE_APK}`);
  console.error('  请先在 pico-network-helper 目录执行：gradlew assembleDebug');
  process.exit(1);
};

main();
