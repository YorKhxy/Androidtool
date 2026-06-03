import * as path from 'path';
import * as nodeFs from 'fs';
import type { ADBManager } from './adb/ADBManager';
import { IPC_CHANNELS } from '../shared/ipc/channels';
import type { TransferTask, TransferBatchResult } from '../shared/types';
import * as transferJournal from './transferJournal';

// 文件批量传输的执行核心。被 index.ts / index-prod.ts 两个入口共用，避免把同一套
// journal 埋点 + 进度回传逻辑在两处重复。入口层只负责：弹目录对话框、注册 IPC、提供
// 「向渲染层发消息」的回调，真正的循环、journal 状态推进、临时文件语义都收口在这里。

// 向渲染层发进度的回调（入口层用 mainWindow?.webContents.send 实现，窗口可能已关）。
type Send = (channel: string, payload: unknown) => void;

let seq = 0;
// batchId / taskId 需唯一：同一毫秒内连续创建靠自增序列兜底，不依赖随机。
export const makeBatchId = (): string => `batch-${Date.now()}-${seq++}`;
const makeTaskId = (): string => `task-${Date.now()}-${seq++}`;

// 由本地文件列表构造一批「上传」任务（全部 pending）。size 取不到填 0，不阻断。
export const buildUploadBatch = (
  deviceId: string,
  remoteDir: string,
  localPaths: string[]
): TransferTask[] => {
  const batchId = makeBatchId();
  const now = Date.now();
  return localPaths.map((localPath) => {
    let size = 0;
    try {
      size = nodeFs.statSync(localPath).size;
    } catch {
      size = 0;
    }
    return {
      id: makeTaskId(),
      batchId,
      direction: 'upload',
      deviceId,
      sourcePath: localPath,
      targetPath: remoteDir,
      fileName: path.basename(localPath),
      size,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
  });
};

// 由设备文件列表构造一批「下载」任务。savedDir 写进 targetPath，恢复时直接复用、不再弹框。
export const buildDownloadBatch = (
  deviceId: string,
  savedDir: string,
  items: { path: string; name: string }[]
): TransferTask[] => {
  const batchId = makeBatchId();
  const now = Date.now();
  return items.map((item) => ({
    id: makeTaskId(),
    batchId,
    direction: 'download',
    deviceId,
    sourcePath: item.path,
    targetPath: savedDir,
    fileName: item.name,
    size: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }));
};

// 执行一批上传（新建或恢复共用）。跳过已 done 的任务，逐个 markStatus 并回传进度。
// stopOnError=true 复刻原上传「首个失败即中止整批」语义（新建上传）；恢复时为 false，
// 失败也继续传完其余文件。无论正常跑完还是中途抛错，finally 都把整批清出 journal——
// 已了结（done/failed）的不再进恢复队列，符合「仅崩溃/被杀残留才恢复」。
export const runUploadBatch = async (
  adbManager: ADBManager,
  send: Send,
  batch: TransferTask[],
  uploadId: string,
  stopOnError: boolean
): Promise<TransferBatchResult> => {
  const total = batch.length;
  let succeeded = 0;
  let failed = 0;
  try {
    for (let index = 0; index < total; index++) {
      const task = batch[index];
      if (task.status === 'done') {
        succeeded++;
        continue;
      }
      transferJournal.markStatus(task.id, 'transferring');
      try {
        await adbManager.pushDeviceFile(
          task.deviceId,
          task.sourcePath,
          task.targetPath,
          task.fileName,
          (percent) => {
            send(IPC_CHANNELS.PUSH_DEVICE_FILE_PROGRESS, {
              uploadId, fileName: task.fileName, index, total, percent, status: 'uploading',
            });
          }
        );
        transferJournal.markStatus(task.id, 'done');
        succeeded++;
        send(IPC_CHANNELS.PUSH_DEVICE_FILE_PROGRESS, {
          uploadId, fileName: task.fileName, index, total, percent: 100, status: 'done',
        });
      } catch (err) {
        transferJournal.markStatus(task.id, 'failed');
        failed++;
        send(IPC_CHANNELS.PUSH_DEVICE_FILE_PROGRESS, {
          uploadId, fileName: task.fileName, index, total, percent: 0, status: 'error',
          error: (err as Error).message,
        });
        if (stopOnError) throw err;
      }
    }
    return { succeeded, failed };
  } finally {
    transferJournal.removeBatch(batch[0].batchId);
  }
};

// 执行一批下载（新建或恢复共用）。下载一律继续传完其余文件（与原批量下载一致）。
export const runDownloadBatch = async (
  adbManager: ADBManager,
  send: Send,
  batch: TransferTask[],
  pullId: string
): Promise<TransferBatchResult> => {
  const total = batch.length;
  let succeeded = 0;
  let failed = 0;
  try {
    for (let index = 0; index < total; index++) {
      const task = batch[index];
      if (task.status === 'done') {
        succeeded++;
        continue;
      }
      transferJournal.markStatus(task.id, 'transferring');
      send(IPC_CHANNELS.PULL_DEVICE_FILE_PROGRESS, {
        pullId, fileName: task.fileName, index, total, status: 'downloading',
      });
      try {
        await adbManager.pullDeviceFile(
          task.deviceId,
          task.sourcePath,
          path.join(task.targetPath, task.fileName)
        );
        transferJournal.markStatus(task.id, 'done');
        succeeded++;
        send(IPC_CHANNELS.PULL_DEVICE_FILE_PROGRESS, {
          pullId, fileName: task.fileName, index, total, status: 'done',
        });
      } catch (err) {
        transferJournal.markStatus(task.id, 'failed');
        failed++;
        send(IPC_CHANNELS.PULL_DEVICE_FILE_PROGRESS, {
          pullId, fileName: task.fileName, index, total, status: 'error', error: (err as Error).message,
        });
      }
    }
    return { succeeded, failed };
  } finally {
    transferJournal.removeBatch(batch[0].batchId);
  }
};

// 丢弃一批未完成任务：清理设备端/本地残留 .part，再把整批移出 journal。
export const discardBatch = async (adbManager: ADBManager, batchId: string): Promise<void> => {
  const batch = transferJournal.getBatch(batchId);
  for (const task of batch) {
    if (task.direction === 'upload') {
      await adbManager.removeRemotePartial(task.deviceId, task.targetPath, task.fileName);
    } else {
      // 下载残留：目标同目录下的 .<fileName>.part（盘根场景用的系统临时目录已自动清理）。
      try {
        nodeFs.rmSync(path.join(task.targetPath, `.${task.fileName}.part`), { force: true });
      } catch {
        /* 残留清理失败忽略 */
      }
    }
  }
  transferJournal.removeBatch(batchId);
};
