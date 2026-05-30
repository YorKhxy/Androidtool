import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DeviceInfo, DeviceFileEntry, PushProgress } from '@/shared/types';
import { hasElectronAPI } from '@/renderer/lib/electronApi';

interface FilesPanelProps {
  selectedDevice: DeviceInfo | null;
  onError: (message: string) => void;
}

const ROOT_PATH = '/sdcard';

// 常用目录快捷入口，覆盖照片/录像/下载/截图等绝大多数需求
const QUICK_LINKS: { label: string; path: string }[] = [
  { label: '内部存储', path: '/sdcard' },
  { label: '相机', path: '/sdcard/DCIM/Camera' },
  { label: '图片', path: '/sdcard/Pictures' },
  { label: '影片', path: '/sdcard/Movies' },
  { label: '下载', path: '/sdcard/Download' },
];

const formatSize = (bytes: number): string => {
  if (bytes <= 0) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const buildBreadcrumbs = (path: string): { label: string; path: string }[] => {
  const parts = path.split('/').filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
};

const parentPath = (path: string): string => {
  if (path === '/' || path === '') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
};

export const FilesPanel: React.FC<FilesPanelProps> = ({ selectedDevice, onError }) => {
  const [currentPath, setCurrentPath] = useState<string>(ROOT_PATH);
  const [entries, setEntries] = useState<DeviceFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>('');
  const [dragOver, setDragOver] = useState(false);
  const [upload, setUpload] = useState<PushProgress | null>(null);
  const uploadDirRef = useRef<string>(ROOT_PATH);
  // 当前进行中的 uploadId。push 完成（invoke 返回）后置空，用于忽略晚于 invoke 返回到达的迟到进度事件，
  // 否则最后一个 done 事件会在 setUpload(null) 之后把进度条又设回 100%，导致按钮一直 disabled。
  const activeUploadIdRef = useRef<string | null>(null);

  const deviceId = selectedDevice?.id ?? null;

  const loadDir = useCallback(
    async (path: string) => {
      if (!deviceId || !hasElectronAPI()) return;
      setLoading(true);
      setNotice('');
      try {
        const result = await window.electronAPI!.listDeviceFiles(deviceId, path);
        if (result.success && result.data) {
          setEntries(result.data.entries);
          setCurrentPath(result.data.path);
        } else {
          setEntries([]);
          onError(result.error || '列出设备文件失败');
        }
      } catch (err) {
        setEntries([]);
        onError('列出设备文件失败：' + (err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [deviceId, onError]
  );

  // 切换设备时回到根目录并重新加载
  useEffect(() => {
    if (deviceId) {
      loadDir(ROOT_PATH);
    } else {
      setEntries([]);
      setCurrentPath(ROOT_PATH);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const handleEntryClick = (entry: DeviceFileEntry) => {
    if (entry.isDir || entry.isSymlink) {
      loadDir(entry.path);
    }
  };

  const handleDownload = async (entry: DeviceFileEntry) => {
    if (!deviceId || !hasElectronAPI()) return;
    setDownloadingPath(entry.path);
    setNotice('');
    try {
      const result = await window.electronAPI!.pullDeviceFile(deviceId, entry.path, entry.name, entry.isDir);
      if (result.success && result.data) {
        setNotice(`已下载到：${result.data}`);
      } else if (result.error && result.error !== '取消下载') {
        onError(result.error);
      }
    } catch (err) {
      onError('下载失败：' + (err as Error).message);
    } finally {
      setDownloadingPath(null);
    }
  };

  // 删除采用行内二次确认：第一次点「删除」进入确认态，再点「确认删除」才真正删除。
  const doDelete = async (entry: DeviceFileEntry) => {
    if (!deviceId || !hasElectronAPI()) return;
    setConfirmDeletePath(null);
    setDeletingPath(entry.path);
    setNotice('');
    try {
      const result = await window.electronAPI!.deleteDeviceFile(deviceId, entry.path, entry.isDir);
      if (result.success) {
        setNotice(`已删除：${entry.name}`);
        loadDir(currentPath);
      } else {
        onError(result.error || '删除失败');
      }
    } catch (err) {
      onError('删除失败：' + (err as Error).message);
    } finally {
      setDeletingPath(null);
    }
  };

  // 始终用最新目录作为上传目标（拖拽/上传都进当前目录）
  useEffect(() => {
    uploadDirRef.current = currentPath;
  }, [currentPath]);

  // 订阅主进程推送的上传进度
  useEffect(() => {
    if (!hasElectronAPI() || !window.electronAPI?.onPushProgress) return;
    const unsubscribe = window.electronAPI.onPushProgress((progress) => {
      // 只处理当前活跃上传的事件，忽略 invoke 已返回后迟到的事件
      if (progress.uploadId !== activeUploadIdRef.current) return;
      setUpload(progress);
    });
    return unsubscribe;
  }, []);

  const uploadFiles = async (localPaths: string[]) => {
    if (!deviceId || !hasElectronAPI() || localPaths.length === 0) return;
    const targetDir = uploadDirRef.current;
    const uploadId = `up-${Date.now()}-${localPaths.length}`;
    activeUploadIdRef.current = uploadId;
    setNotice('');
    setUpload({ uploadId, fileName: '', index: 0, total: localPaths.length, percent: 0, status: 'uploading' });
    try {
      const result = await window.electronAPI!.pushDeviceFile(deviceId, targetDir, localPaths, uploadId);
      // 先停掉对该 uploadId 的事件响应，再清进度，避免迟到事件覆盖
      activeUploadIdRef.current = null;
      setUpload(null);
      if (result.success) {
        setNotice(`已上传 ${result.data} 个文件到 ${targetDir}`);
        loadDir(targetDir);
      } else if (result.error && result.error !== '取消选择') {
        onError(result.error);
      }
    } catch (err) {
      activeUploadIdRef.current = null;
      setUpload(null);
      onError('上传失败：' + (err as Error).message);
    }
  };

  const handleUploadClick = async () => {
    if (!hasElectronAPI()) return;
    const result = await window.electronAPI!.selectUploadFiles();
    if (result.success && result.data && result.data.length > 0) {
      uploadFiles(result.data);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // Electron 渲染层 File 对象带 .path 绝对路径
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => Boolean(p));
    if (paths.length > 0) {
      uploadFiles(paths);
    } else {
      onError('无法获取拖入文件的路径，请改用「上传文件」按钮');
    }
  };

  if (!selectedDevice) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: '#6b7280' }}>
        请选择一个设备后再浏览文件
      </div>
    );
  }

  const crumbs = buildBreadcrumbs(currentPath);
  const canGoUp = currentPath !== '/';

  return (
    <div
      style={{ padding: '16px', color: '#e2e8f0', position: 'relative' }}
      onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div style={{ position: 'absolute', inset: '8px', border: '2px dashed #4a90d9', borderRadius: '10px', backgroundColor: 'rgba(74,144,217,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, pointerEvents: 'none' }}>
          <span style={{ fontSize: '16px', color: '#93c5fd', fontWeight: 600 }}>松开即上传到 {currentPath}</span>
        </div>
      )}
      {/* 快捷入口 */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {QUICK_LINKS.map((link) => (
          <button
            key={link.path}
            onClick={() => loadDir(link.path)}
            style={{
              padding: '6px 12px',
              backgroundColor: currentPath === link.path ? '#4a90d9' : '#353550',
              border: 'none',
              borderRadius: '6px',
              color: currentPath === link.path ? '#fff' : '#cbd5e1',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            {link.label}
          </button>
        ))}
      </div>

      {/* 路径面包屑 + 上一级 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <button
          onClick={() => loadDir(parentPath(currentPath))}
          disabled={!canGoUp || loading}
          style={{
            padding: '4px 10px',
            backgroundColor: '#353550',
            border: 'none',
            borderRadius: '6px',
            color: !canGoUp ? '#64748b' : '#cbd5e1',
            cursor: !canGoUp || loading ? 'not-allowed' : 'pointer',
            fontSize: '12px',
          }}
        >
          ↑ 上一级
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexWrap: 'wrap', fontSize: '13px' }}>
          {crumbs.map((crumb, idx) => (
            <React.Fragment key={crumb.path}>
              {idx > 0 && <span style={{ color: '#475569' }}>/</span>}
              <button
                onClick={() => loadDir(crumb.path)}
                style={{ background: 'none', border: 'none', color: '#93c5fd', cursor: 'pointer', fontSize: '13px', padding: '2px 4px' }}
              >
                {crumb.label}
              </button>
            </React.Fragment>
          ))}
        </div>
        <button
          onClick={handleUploadClick}
          disabled={Boolean(upload)}
          style={{ marginLeft: 'auto', padding: '4px 12px', backgroundColor: '#4a90d9', border: 'none', borderRadius: '6px', color: '#fff', cursor: upload ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: upload ? 0.6 : 1 }}
        >
          ⬆ 上传文件
        </button>
      </div>

      {/* 上传进度条 */}
      {upload && (
        <div style={{ marginBottom: '12px', padding: '10px 12px', backgroundColor: '#1e293b', borderRadius: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#cbd5e1', marginBottom: '6px' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
              {upload.status === 'error' ? '上传失败：' : '上传中：'}{upload.fileName || '准备中…'}
              {upload.total > 1 && ` (${upload.index + 1}/${upload.total})`}
            </span>
            <span>{upload.percent}%</span>
          </div>
          <div style={{ height: '6px', backgroundColor: '#334155', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${upload.percent}%`, backgroundColor: upload.status === 'error' ? '#ef4444' : '#4a90d9', transition: 'width 240ms ease' }} />
          </div>
        </div>
      )}

      {notice && (
        <div style={{ marginBottom: '12px', padding: '8px 12px', backgroundColor: '#14532d', color: '#86efac', borderRadius: '6px', fontSize: '13px', wordBreak: 'break-all' }}>
          {notice}
        </div>
      )}

      {/* 文件列表 */}
      <div style={{ border: '1px solid #1f2937', borderRadius: '8px', overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 115px 200px', backgroundColor: '#1f2937', color: '#94a3b8', fontSize: '12px', fontWeight: 700, padding: '8px 12px' }}>
          <span>名称</span>
          <span style={{ textAlign: 'right' }}>大小</span>
          <span style={{ textAlign: 'right' }}>修改时间</span>
          <span style={{ textAlign: 'right' }}>操作</span>
        </div>

        {loading ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#6b7280', fontSize: '13px' }}>加载中…</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#6b7280', fontSize: '13px' }}>此目录为空</div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.path}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 80px 115px 200px',
                alignItems: 'center',
                padding: '8px 12px',
                borderTop: '1px solid #1f2937',
                fontSize: '13px',
              }}
            >
              <span
                onClick={() => handleEntryClick(entry)}
                style={{
                  cursor: entry.isDir || entry.isSymlink ? 'pointer' : 'default',
                  color: entry.isDir || entry.isSymlink ? '#93c5fd' : '#e2e8f0',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={entry.name}
              >
                {entry.isDir ? '📁 ' : entry.isSymlink ? '🔗 ' : '📄 '}
                {entry.name}
              </span>
              <span style={{ textAlign: 'right', color: '#94a3b8' }}>{entry.isDir ? '--' : formatSize(entry.size)}</span>
              <span style={{ textAlign: 'right', color: '#94a3b8' }}>{entry.mtime}</span>
              <span style={{ textAlign: 'right', display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => handleDownload(entry)}
                  disabled={downloadingPath === entry.path}
                  style={{
                    padding: '3px 10px',
                    backgroundColor: '#353550',
                    border: 'none',
                    borderRadius: '4px',
                    color: '#86efac',
                    cursor: downloadingPath === entry.path ? 'not-allowed' : 'pointer',
                    fontSize: '12px',
                    opacity: downloadingPath === entry.path ? 0.6 : 1,
                  }}
                >
                  {downloadingPath === entry.path ? '下载中…' : '下载'}
                </button>
                {confirmDeletePath === entry.path ? (
                  <>
                    <button
                      onClick={() => doDelete(entry)}
                      style={{ padding: '3px 8px', backgroundColor: '#ef4444', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer', fontSize: '12px' }}
                    >确认删除</button>
                    <button
                      onClick={() => setConfirmDeletePath(null)}
                      style={{ padding: '3px 8px', backgroundColor: '#475569', border: 'none', borderRadius: '4px', color: '#e2e8f0', cursor: 'pointer', fontSize: '12px' }}
                    >取消</button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDeletePath(entry.path)}
                    disabled={deletingPath === entry.path}
                    style={{ padding: '3px 10px', backgroundColor: '#353550', border: 'none', borderRadius: '4px', color: '#fca5a5', cursor: deletingPath === entry.path ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: deletingPath === entry.path ? 0.6 : 1 }}
                  >{deletingPath === entry.path ? '删除中…' : '删除'}</button>
                )}
              </span>
            </div>
          ))
        )}
      </div>

      <div style={{ marginTop: '10px', fontSize: '11px', color: '#64748b' }}>
        提示：照片/录像/下载等公共存储免 root 可访问；应用私有数据（/data/data）需要 root，访问受限时会提示。
      </div>
    </div>
  );
};
