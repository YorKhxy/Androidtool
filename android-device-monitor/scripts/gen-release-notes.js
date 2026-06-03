/* eslint-disable */
// 自动生成「本次更新说明」并写入 release-notes.md（供 electron-builder 打进 latest.yml）。
// 来源：自上次发版以来的 git 提交（取 feat/fix/perf，去掉前缀作为更新条目）。
// 上次发版点用 update-releases/.last-release-commit 记录（首次发版回退到最近若干条提交）。
//
// 设计：永不让打包失败——git 不可用 / 无新提交等任何异常都兜底，exit 0。
// 路径全部从 __dirname 推导，不硬编码绝对路径。

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const notesFile = path.join(projectRoot, 'release-notes.md');
const markerDir = path.join(projectRoot, 'update-releases');
const markerFile = path.join(markerDir, '.last-release-commit');
const FIRST_RUN_RANGE = 'HEAD~50..HEAD'; // 没有上次发版标记时的回退范围

const readVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
};

// git 从 projectRoot 起会自动向上找到 .git（仓库根在上层目录），无需写死仓库根路径。
const git = (args) => execSync(`git ${args}`, { cwd: projectRoot, encoding: 'utf8' }).trim();

const main = () => {
  const version = readVersion();
  let head;
  try {
    head = git('rev-parse HEAD');
  } catch (e) {
    // 非 git 环境：保留现有 release-notes.md（若不存在给个兜底），不阻断打包。
    if (!fs.existsSync(notesFile)) {
      fs.writeFileSync(notesFile, `v${version}\n\n- 维护性更新\n`, 'utf8');
    }
    console.warn('[gen-release-notes] git 不可用，保留现有说明:', e.message);
    return;
  }

  // 计算「上次发版以来」的提交范围
  let lastCommit = null;
  try {
    lastCommit = fs.readFileSync(markerFile, 'utf8').trim() || null;
  } catch {
    lastCommit = null;
  }
  if (lastCommit) {
    try {
      git(`cat-file -e ${lastCommit}^{commit}`); // 标记的提交还在不在（可能被 rebase 丢了）
    } catch {
      lastCommit = null;
    }
  }
  const range = lastCommit ? `${lastCommit}..HEAD` : FIRST_RUN_RANGE;

  let subjects = [];
  try {
    subjects = git(`log ${range} --no-merges --pretty=%s`).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    try {
      subjects = git('log -50 --no-merges --pretty=%s').split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      subjects = [];
    }
  }

  // 取面向用户的提交（feat/fix/perf），去掉前缀作为条目；没有就退而用全部提交主题。
  const userFacing = subjects
    .filter((s) => /^(feat|fix|perf)\s*[:：]/i.test(s))
    .map((s) => s.replace(/^(feat|fix|perf)\s*[:：]\s*/i, '').trim())
    .filter(Boolean);
  // 去重（同一条信息可能多次出现）
  const seen = new Set();
  const items = (userFacing.length ? userFacing : subjects).filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  let date = '';
  try {
    date = git('log -1 --pretty=%ad --date=format:%Y-%m-%d');
  } catch {
    date = '';
  }

  const bullets = items.length ? items.map((s) => `- ${s}`).join('\n') : '- 维护性更新';
  const content = `v${version}${date ? `  (${date})` : ''}\n\n${bullets}\n`;
  fs.writeFileSync(notesFile, content, 'utf8');

  // 更新发版标记到当前 HEAD（下次从这里往后算）
  try {
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(markerFile, head + '\n', 'utf8');
  } catch (e) {
    console.warn('[gen-release-notes] 写发版标记失败:', e.message);
  }

  console.log(`[gen-release-notes] v${version}: 写入 ${items.length} 条更新说明`);
};

try {
  main();
} catch (e) {
  console.warn('[gen-release-notes] 生成异常，跳过（不影响打包）:', e && e.message);
}
process.exit(0);
