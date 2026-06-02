import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DeviceInfo, DeviceFileEntry, PushProgress, PullProgress } from '@/shared/types';
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
  // 内联提示的语气：success 绿色（操作成功），warn 琥珀色（目录不存在/访问受限等温和提醒）
  const [noticeKind, setNoticeKind] = useState<'success' | 'warn'>('success');
  // 最近一次下载到 PC 的本地路径，用于「打开所在文件夹」快捷按钮
  const [lastDownloadPath, setLastDownloadPath] = useState<string | null>(null);
  // 当前目录内的文件名搜索关键词（仅过滤当前已加载的列表，不重新请求设备）
  const [search, setSearch] = useState('');
  // 多选下载：选中的文件路径集合 + 批量下载进度
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [pull, setPull] = useState<PullProgress | null>(null);
  const activePullIdRef = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [upload, setUpload] = useState<PushProgress | null>(null);
  const uploadDirRef = useRef<string>(ROOT_PATH);
  // 当前进行中的 uploadId。push 完成（invoke 返回）后置空，用于忽略晚于 invoke 返回到达的迟到进度事件，
  // 否则最后一个 done 事件会在 setUpload(null) 之后把进度条又设回 100%，导致按钮一直 disabled。
  const activeUploadIdRef = useRef<string | null>(null);
  // 新建文件夹：creatingFolder 控制输入行显隐，newFolderName 为输入值，creatingFolderBusy 防重复提交
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolderBusy, setCreatingFolderBusy] = useState(false);

  const deviceId = selectedDevice?.id ?? null;

  const loadDir = useCallback(
    async (path: string) => {
      if (!deviceId || !hasElectronAPI()) return;
      setLoading(true);
      setNotice('');
      // 切换目录后「打开所在文件夹」按钮指向的是旧的下载结果，已无意义，清掉避免挂在新提示上
      setLastDownloadPath(null);
      try {
        const result = await window.electronAPI!.listDeviceFiles(deviceId, path);
        if (result.success && result.data) {
          setEntries(result.data.entries);
          setCurrentPath(result.data.path);
          setSearch('');
          setSelectedPaths(new Set());
        } else {
          // 目录不存在 / 访问受限等：保留当前列表不动，仅给温和内联提示，不弹全局红色报错。
          // 例如 Pico 等 VR 设备没有 /sdcard/DCIM/Camera，点击「相机」快捷入口时不再惊扰用户。
          setNotice(result.error || '该目录不存在或无法访问');
          setNoticeKind('warn');
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
    setLastDownloadPath(null);
    try {
      const result = await window.electronAPI!.pullDeviceFile(deviceId, entry.path, entry.name, entry.isDir);
      if (result.success && result.data) {
        setNotice(`已下载到：${result.data}`);
        setNoticeKind('success');
        setLastDownloadPath(result.data);
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
        setNoticeKind('success');
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

  const toggleSelect = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // 批量下载选中的文件到 PC 同一个文件夹
  const downloadSelected = async () => {
    if (!deviceId || !hasElectronAPI() || selectedPaths.size === 0) return;
    // 只下载文件，忽略目录（目录批量下载交互复杂，单独「下载」按钮已支持单个目录）
    const items = entries
      .filter((e) => selectedPaths.has(e.path) && !e.isDir)
      .map((e) => ({ path: e.path, name: e.name }));
    if (items.length === 0) {
      onError('选中项中没有可下载的文件（目录请用行内「下载」按钮）');
      return;
    }
    const pullId = `pull-${Date.now()}-${items.length}`;
    activePullIdRef.current = pullId;
    setNotice('');
    setLastDownloadPath(null);
    setPull({ pullId, fileName: '', index: 0, total: items.length, status: 'downloading' });
    try {
      const result = await window.electronAPI!.pullDeviceFiles(deviceId, items, pullId);
      activePullIdRef.current = null;
      setPull(null);
      if (result.success && result.data) {
        const { savedDir, succeeded, failed } = result.data;
        setNotice(`已下载 ${succeeded} 个文件到 ${savedDir}${failed > 0 ? `，${failed} 个失败` : ''}`);
        setNoticeKind('success');
        setLastDownloadPath(savedDir);
        setSelectedPaths(new Set());
      } else if (result.error && result.error !== '取消下载') {
        onError(result.error);
      }
    } catch (err) {
      activePullIdRef.current = null;
      setPull(null);
      onError('批量下载失败：' + (err as Error).message);
    }
  };

  // 始终用最新目录作为上传目标（拖拽/上传都进当前目录）
  useEffect(() => {
    uploadDirRef.current = currentPath;
  }, [currentPath]);

  // 订阅主进程推送的批量下载进度
  useEffect(() => {
    if (!hasElectronAPI() || !window.electronAPI?.onPullProgress) return;
    const unsubscribe = window.electronAPI.onPullProgress((progress) => {
      if (progress.pullId !== activePullIdRef.current) return;
      setPull(progress);
    });
    return unsubscribe;
  }, []);

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
        setNoticeKind('success');
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

  // 在当前目录新建文件夹
  const handleCreateFolder = async () => {
    if (!deviceId || !hasElectronAPI()) return;
    const name = newFolderName.trim();
    if (!name) {
      onError('请输入文件夹名称');
      return;
    }
    if (/[\/\\]/.test(name)) {
      onError('文件夹名称不能包含 / 或 \\');
      return;
    }
    setCreatingFolderBusy(true);
    setNotice('');
    try {
      const result = await window.electronAPI!.createDeviceFolder(deviceId, currentPath, name);
      if (result.success) {
        setNotice(`已创建文件夹：${name}`);
        setNoticeKind('success');
        setCreatingFolder(false);
        setNewFolderName('');
        loadDir(currentPath);
      } else {
        onError(result.error || '创建文件夹失败');
      }
    } catch (err) {
      onError('创建文件夹失败：' + (err as Error).message);
    } finally {
      setCreatingFolderBusy(false);
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
  const keyword = search.trim().toLowerCase();
  const visibleEntries = keyword
    ? entries.filter((entry) => entry.name.toLowerCase().includes(keyword))
    : entries;

  return (
    <div
      style={{ padding: '16px', color: '#e2e8f0', position: 'relative', display: 'flex', flexDirection: 'column', maxHeight: '100%', minHeight: 0, boxSizing: 'border-box', width: '100%' }}
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
          onClick={() => { setCreatingFolder((v) => !v); setNewFolderName(''); }}
          style={{ marginLeft: 'auto', padding: '4px 12px', backgroundColor: creatingFolder ? '#4a90d9' : '#353550', border: 'none', borderRadius: '6px', color: creatingFolder ? '#fff' : '#cbd5e1', cursor: 'pointer', fontSize: '12px' }}
        >
          📁+ 新建文件夹
        </button>
        <button
          onClick={handleUploadClick}
          disabled={Boolean(upload)}
          style={{ padding: '4px 12px', backgroundColor: '#4a90d9', border: 'none', borderRadius: '6px', color: '#fff', cursor: upload ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: upload ? 0.6 : 1 }}
        >
          ⬆ 上传文件
        </button>
      </div>

      {/* 新建文件夹输入行 */}
      {creatingFolder && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder();
              else if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName(''); }
            }}
            placeholder={`在 ${currentPath} 下新建文件夹的名称`}
            style={{ flex: 1, minWidth: 0, padding: '6px 10px', backgroundColor: '#1f1f33', border: '1px solid #353550', borderRadius: '6px', color: '#e5e7eb', fontSize: '13px', outline: 'none' }}
          />
          <button
            onClick={handleCreateFolder}
            disabled={creatingFolderBusy}
            style={{ flexShrink: 0, padding: '6px 14px', backgroundColor: '#16a34a', border: 'none', borderRadius: '6px', color: '#fff', cursor: creatingFolderBusy ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: creatingFolderBusy ? 0.6 : 1 }}
          >{creatingFolderBusy ? '创建中…' : '创建'}</button>
          <button
            onClick={() => { setCreatingFolder(false); setNewFolderName(''); }}
            style={{ flexShrink: 0, padding: '6px 12px', backgroundColor: '#475569', border: 'none', borderRadius: '6px', color: '#e2e8f0', cursor: 'pointer', fontSize: '12px' }}
          >取消</button>
        </div>
      )}

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
        <div style={{ marginBottom: '12px', padding: '8px 12px', backgroundColor: noticeKind === 'warn' ? '#422006' : '#14532d', color: noticeKind === 'warn' ? '#fcd34d' : '#86efac', borderRadius: '6px', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <span style={{ wordBreak: 'break-all' }}>{notice}</span>
          {lastDownloadPath && (
            <button
              onClick={async () => {
                if (!hasElectronAPI()) return;
                const result = await window.electronAPI!.showItemInFolder(lastDownloadPath);
                if (!result.success && result.error) onError(result.error);
              }}
              style={{ flexShrink: 0, whiteSpace: 'nowrap', padding: '4px 12px', backgroundColor: '#16a34a', border: 'none', borderRadius: '6px', color: '#fff', cursor: 'pointer', fontSize: '12px' }}
            >📂 打开所在文件夹</button>
          )}
        </div>
      )}

      {/* 文件名搜索 */}
      <div style={{ marginBottom: '12px', position: 'relative' }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={'搜索当前目录文件名…'}
          style={{ width: '100%', boxSizing: 'border-box', padding: '8px 32px 8px 12px', backgroundColor: '#1f1f33', border: '1px solid #353550', borderRadius: '6px', color: '#e5e7eb', fontSize: '13px', outline: 'none' }}
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '14px', lineHeight: 1 }}
          >×</button>
        )}
      </div>

      {/* 批量下载操作栏：选中文件后出现 */}
      {selectedPaths.size > 0 && (
        <div style={{ marginBottom: '12px', padding: '8px 12px', backgroundColor: '#1e293b', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <span style={{ fontSize: '13px', color: '#cbd5e1' }}>已选中 {selectedPaths.size} 个文件</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setSelectedPaths(new Set())}
              disabled={Boolean(pull)}
              style={{ padding: '4px 12px', backgroundColor: '#475569', border: 'none', borderRadius: '6px', color: '#e2e8f0', cursor: pull ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: pull ? 0.6 : 1 }}
            >清空</button>
            <button
              onClick={downloadSelected}
              disabled={Boolean(pull)}
              style={{ padding: '4px 12px', backgroundColor: '#16a34a', border: 'none', borderRadius: '6px', color: '#fff', cursor: pull ? 'not-allowed' : 'pointer', fontSize: '12px', whiteSpace: 'nowrap', opacity: pull ? 0.6 : 1 }}
            >⬇ 下载选中 ({selectedPaths.size})</button>
          </div>
        </div>
      )}

      {/* 批量下载进度条 */}
      {pull && (
        <div style={{ marginBottom: '12px', padding: '10px 12px', backgroundColor: '#1e293b', borderRadius: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#cbd5e1', marginBottom: '6px' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
              {pull.status === 'error' ? '下载失败：' : '下载中：'}{pull.fileName || '准备中…'} ({pull.index + 1}/{pull.total})
            </span>
            <span>{Math.round(((pull.index + (pull.status === 'done' ? 1 : 0)) / pull.total) * 100)}%</span>
          </div>
          <div style={{ height: '6px', backgroundColor: '#334155', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.round(((pull.index + (pull.status === 'done' ? 1 : 0)) / pull.total) * 100)}%`, backgroundColor: '#16a34a', transition: 'width 240ms ease' }} />
          </div>
        </div>
      )}

      {/* 文件列表（内容超高时仅此区域滚动，上方工具区固定；内容少时按内容高度贴合） */}
      <div style={{ border: '1px solid #1f2937', borderRadius: '8px', overflow: 'auto', flex: '0 1 auto', minHeight: 0 }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'grid', gridTemplateColumns: '32px 1fr 80px 115px 200px', backgroundColor: '#1f2937', color: '#94a3b8', fontSize: '12px', fontWeight: 700, padding: '8px 12px', alignItems: 'center' }}>
          <input
            type="checkbox"
            title="全选/取消当前列表中的文件"
            checked={visibleEntries.filter((e) => !e.isDir).length > 0 && visibleEntries.filter((e) => !e.isDir).every((e) => selectedPaths.has(e.path))}
            onChange={(e) => {
              const fileEntries = visibleEntries.filter((en) => !en.isDir);
              setSelectedPaths((prev) => {
                const next = new Set(prev);
                if (e.target.checked) fileEntries.forEach((en) => next.add(en.path));
                else fileEntries.forEach((en) => next.delete(en.path));
                return next;
              });
            }}
          />
          <span>名称</span>
          <span style={{ textAlign: 'right' }}>大小</span>
          <span style={{ textAlign: 'right' }}>修改时间</span>
          <span style={{ textAlign: 'right' }}>操作</span>
        </div>

        {loading ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#6b7280', fontSize: '13px' }}>加载中…</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#6b7280', fontSize: '13px' }}>此目录为空</div>
        ) : visibleEntries.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#6b7280', fontSize: '13px' }}>没有匹配「{search.trim()}」的文件</div>
        ) : (
          visibleEntries.map((entry) => (
            <div
              key={entry.path}
              style={{
                display: 'grid',
                gridTemplateColumns: '32px 1fr 80px 115px 200px',
                alignItems: 'center',
                padding: '8px 12px',
                borderTop: '1px solid #1f2937',
                fontSize: '13px',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center' }}>
                {!entry.isDir && (
                  <input
                    type="checkbox"
                    checked={selectedPaths.has(entry.path)}
                    onChange={() => toggleSelect(entry.path)}
                  />
                )}
              </span>
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

      <div style={{ marginTop: '10px', fontSize: '11px', color: '#64748b', flexShrink: 0 }}>
        提示：照片/录像/下载等公共存储免 root 可访问；应用私有数据（/data/data）需要 root，访问受限时会提示。
      </div>
    </div>
  );
};
