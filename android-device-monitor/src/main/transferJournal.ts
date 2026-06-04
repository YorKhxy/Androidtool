import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { TransferTask, TransferTaskStatus, TransferResumeBatch } from '../shared/types';
import { logger } from './logger';

// 文件传输日志（journal）。批量上传/下载的任务清单落盘到 userData 目录，
// 作为进程崩溃 / 被强杀后识别未完成任务、文件级续传的唯一依据——内存里的进度状态
// 进程一被杀就没了。UI 不暴露宿主绝对路径（遵循 CONTEXT.md / CLAUDE.md 路径规范）。
//
// 仅在主进程使用，单例。内存镜像 tasks 是落盘的唯一来源，所有变更后立即原子写盘。

// 路径延迟解析：模块可能在 app ready 之前被 import，app.getPath 此时会抛错。
const getJournalPath = (): string => path.join(app.getPath('userData'), 'transfer-journal.json');
const getTmpPath = (): string => `${getJournalPath()}.tmp`;

let tasks: TransferTask[] = [];
let loaded = false;
// 应用是否正在退出。退出触发的传输中断不应标 failed / 清批次——要把进行中的任务
// 保留为 transferring（可恢复），否则优雅关闭（任务管理器「结束任务」=WM_CLOSE）会把
// before-quit 里 SIGTERM 掉的传输当成失败清出 journal，导致重启无可恢复项。
let quitting = false;

// 首次访问时从磁盘载入；文件不存在或解析失败一律容错为空（参照项目其它持久化的兜底写法）。
const ensureLoaded = (): void => {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(getJournalPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    tasks = Array.isArray(parsed) ? (parsed as TransferTask[]) : [];
  } catch {
    tasks = [];
  }
  // 清理上次异常退出残留的临时文件，避免堆积（没有则忽略）。
  try {
    fs.unlinkSync(getTmpPath());
  } catch {
    /* noop */
  }
};

// 原子写盘：先写 .tmp 再 rename 覆盖，避免写到一半崩溃损坏 journal 本身。
const persist = (): void => {
  try {
    const tmp = getTmpPath();
    fs.writeFileSync(tmp, JSON.stringify(tasks), 'utf-8');
    fs.renameSync(tmp, getJournalPath());
  } catch (error) {
    logger.error('transferJournal: persist failed:', error);
  }
};

// 写入一批新任务（全部 pending）。
export const createBatch = (batch: TransferTask[]): void => {
  if (batch.length === 0) return;
  ensureLoaded();
  tasks.push(...batch);
  persist();
};

// 更新单个任务状态并刷新 updatedAt。
export const markStatus = (taskId: string, status: TransferTaskStatus): void => {
  ensureLoaded();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.status = status;
  task.updatedAt = Date.now();
  persist();
};

// 移除单个任务（用户主动取消 / 传输失败了结时调用，使其不进恢复队列）。
export const removeTask = (taskId: string): void => {
  ensureLoaded();
  const before = tasks.length;
  tasks = tasks.filter((t) => t.id !== taskId);
  if (tasks.length !== before) persist();
};

// 移除整个批次（批量正常跑完、或用户丢弃恢复时调用）。
export const removeBatch = (batchId: string): void => {
  ensureLoaded();
  const before = tasks.length;
  tasks = tasks.filter((t) => t.batchId !== batchId);
  if (tasks.length !== before) persist();
};

// 取某批次的全部任务（续传时按此跳过 done、重传其余）。
export const getBatch = (batchId: string): TransferTask[] => {
  ensureLoaded();
  return tasks.filter((t) => t.batchId === batchId);
};

// 未完成 = pending / transferring，即没来得及了结就被杀的残留任务。
export const loadUnfinished = (): TransferTask[] => {
  ensureLoaded();
  return tasks.filter((t) => t.status === 'pending' || t.status === 'transferring');
};

// 把未完成任务按 batchId 聚合成给渲染层弹窗用的摘要。
export const getResumeBatches = (sampleLimit = 3): TransferResumeBatch[] => {
  const unfinished = loadUnfinished();
  const byBatch = new Map<string, TransferTask[]>();
  for (const task of unfinished) {
    const list = byBatch.get(task.batchId);
    if (list) list.push(task);
    else byBatch.set(task.batchId, [task]);
  }
  return Array.from(byBatch.values()).map((list) => ({
    batchId: list[0].batchId,
    direction: list[0].direction,
    deviceId: list[0].deviceId,
    remaining: list.length,
    sampleNames: list.slice(0, sampleLimit).map((t) => t.fileName),
  }));
};

// 是否有处于 transferring 的任务，供 before-quit 判断是否需要终止子进程。
export const hasActiveTransfers = (): boolean => {
  ensureLoaded();
  return tasks.some((t) => t.status === 'transferring');
};

// 标记应用进入退出流程。置位后，传输执行器对中断不再标 failed / 清批次，保留为可恢复。
export const setQuitting = (value: boolean): void => {
  quitting = value;
};

export const isQuitting = (): boolean => quitting;

// 清空全部任务（仅用于异常兜底 / 测试）。
export const clearAll = (): void => {
  ensureLoaded();
  tasks = [];
  persist();
};
