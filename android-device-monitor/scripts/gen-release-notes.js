/* eslint-disable */
// 自动生成「本次更新说明」并写入 release-notes.md（供 electron-builder 打进 latest.yml）。
// 来源：自上次发版以来的 git 提交（取 feat/fix/perf，去掉前缀作为更新条目）。
//
// 「上次发版点」锚点优先级（越靠前越可靠）：
//   1) git 版本 tag（v*）——进版本库、跟 commit 走、换机器也在，由 make-update-package 发版时自动打。
//   2) update-releases/.last-release-commit 文件标记——兼容历史；但该目录被 gitignore，易丢，仅作过渡兜底。
//   3) 都没有 → 取最近 N 条提交，并「大声告警」，绝不静默把整段历史当成本次更新（这正是旧版老贴全历史的根因）。
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
const NO_ANCHOR_LOG_COUNT = 20; // 无任何可靠锚点时，只取最近这么多条提交（并告警），不再 HEAD~50 静默贴全历史

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

  // 计算「上次发版以来」的提交：锚点优先级 tag > 文件标记 > 小窗口兜底（见顶部说明）。
  const isAncestor = (ref) => {
    try {
      git(`merge-base --is-ancestor ${ref} HEAD`); // 锚点必须是 HEAD 的祖先，否则 ref..HEAD 会膨胀
      return true;
    } catch {
      return false;
    }
  };

  let anchor = null; // { ref, kind }
  // 1) 最近的可达版本 tag（v* 按版本号降序，取第一个是 HEAD 祖先的）
  try {
    const tags = git('tag --list "v*" --sort=-version:refname').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const t of tags) {
      if (isAncestor(t)) { anchor = { ref: t, kind: 'tag' }; break; }
    }
  } catch {
    /* 无 tag 或 git 版本不支持 --sort，继续往下兜底 */
  }
  // 2) 退而求其次：旧的文件标记（commit 仍在且是 HEAD 祖先才用）
  if (!anchor) {
    let lastCommit = null;
    try {
      lastCommit = fs.readFileSync(markerFile, 'utf8').trim() || null;
    } catch {
      lastCommit = null;
    }
    if (lastCommit && isAncestor(lastCommit)) anchor = { ref: lastCommit, kind: 'marker' };
  }

  let subjects = [];
  if (anchor) {
    console.log(`[gen-release-notes] 发版锚点 = ${anchor.kind} ${anchor.ref}`);
    try {
      subjects = git(`log ${anchor.ref}..HEAD --no-merges --pretty=%s`).split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      subjects = [];
    }
  } else {
    // 3) 无任何可靠锚点：取最近 N 条并「大声告警」，避免静默把整段历史当成本次更新。
    console.warn(
      `[gen-release-notes] 警告：未找到版本 tag / 有效发版标记，无法定位上次发版点；` +
        `回退到最近 ${NO_ANCHOR_LOG_COUNT} 条提交，请核对本次说明，或下次用 -NoAutoNotes 手写。`
    );
    try {
      subjects = git(`log -${NO_ANCHOR_LOG_COUNT} --no-merges --pretty=%s`).split('\n').map((s) => s.trim()).filter(Boolean);
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
