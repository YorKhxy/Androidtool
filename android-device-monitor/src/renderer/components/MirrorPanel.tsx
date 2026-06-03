import { useState } from 'react';
import type { MirrorSession, MirrorSessionStatus } from '../../shared/types';

type MirrorStartParams = { maxSize?: number; bitRate?: string; forwardAudio?: boolean };

type MirrorPanelProps = {
  deviceName: string;
  isPico: boolean;
  session: MirrorSession | null;
  starting: boolean;
  onStart: (params: MirrorStartParams) => void;
  onStop: () => void;
  onToggleAudio: (forward: boolean) => void; // 投屏中实时切换音频去向
};

const STATUS_META: Record<MirrorSessionStatus, { label: string; color: string; background: string }> = {
  starting: { label: '启动中', color: '#60a5fa', background: '#1d4ed822' },
  running: { label: '镜像中', color: '#22c55e', background: '#22c55e22' },
  stopped: { label: '已停止', color: '#9ca3af', background: '#4b556322' },
  failed: { label: '启动失败', color: '#ef4444', background: '#ef444422' },
};

const MAX_SIZE_OPTIONS: { label: string; value: number | undefined }[] = [
  { label: '不限', value: undefined },
  { label: '1280', value: 1280 },
  { label: '1600', value: 1600 },
];

const BIT_RATE_OPTIONS = ['4M', '8M', '16M'];

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Alt + h', action: '主页 Home' },
  { keys: 'Alt + b', action: '返回 Back' },
  { keys: 'Alt + s', action: '最近任务' },
  { keys: 'Alt + p', action: '电源键' },
  { keys: 'Alt + ↑ / ↓', action: '音量加 / 减' },
  { keys: 'Alt + r', action: '旋转屏幕' },
];

const selectStyle = (disabled: boolean) => ({
  padding: '6px 10px',
  fontSize: '13px',
  color: '#e5e7eb',
  backgroundColor: '#1f1f33',
  border: '1px solid #353550',
  borderRadius: '6px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
});

const isActive = (session: MirrorSession | null, starting: boolean): boolean => {
  if (starting) return true;
  return session?.status === 'starting' || session?.status === 'running';
};

export function MirrorPanel({ deviceName, isPico, session, starting, onStart, onStop, onToggleAudio }: MirrorPanelProps) {
  const [maxSize, setMaxSize] = useState<number | undefined>(undefined);
  const [bitRate, setBitRate] = useState<string>('8M');
  const [showShortcuts, setShowShortcuts] = useState(false);
  // 启动时是否把声音转到电脑（未投屏时由此控制初值）。默认 false：声音留在设备本机输出。
  const [forwardAudio, setForwardAudio] = useState(false);

  const active = isActive(session, starting);
  // 复选框的真值：投屏中以主进程会话的实际音频状态为准，未投屏时用本地初值。
  const audioOn = active ? Boolean(session?.audioForwarded) : forwardAudio;
  const status: MirrorSessionStatus = starting ? 'starting' : session?.status ?? 'stopped';
  const meta = STATUS_META[status];

  return (
    <div style={{ maxWidth: '720px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          backgroundColor: '#2b2b45',
          border: '1px solid #353550',
          borderRadius: '10px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ fontSize: '15px', fontWeight: 600, color: '#fff' }}>投屏镜像与操控</div>
          <div style={{ fontSize: '13px', color: '#9ca3af' }}>
            当前设备：{deviceName}
            {isPico && <span style={{ color: '#a78bfa', marginLeft: '8px' }}>· Pico 单眼裁切</span>}
          </div>
          <div>
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: meta.color,
                backgroundColor: meta.background,
                padding: '2px 10px',
                borderRadius: '999px',
              }}
            >
              {meta.label}
            </span>
          </div>
        </div>

        <button
          onClick={active ? onStop : () => onStart({ maxSize, bitRate, forwardAudio })}
          disabled={starting}
          style={{
            padding: '10px 22px',
            fontSize: '14px',
            fontWeight: 600,
            color: '#fff',
            backgroundColor: active ? '#ef4444' : '#4a90d9',
            border: 'none',
            borderRadius: '8px',
            cursor: starting ? 'not-allowed' : 'pointer',
            opacity: starting ? 0.7 : 1,
          }}
        >
          {active ? '停止投屏' : '开始投屏'}
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '20px',
          padding: '14px 20px',
          backgroundColor: '#1f1f33',
          border: '1px solid #353550',
          borderRadius: '10px',
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#cbd5e1' }}>
          分辨率上限
          <select
            value={maxSize ?? ''}
            disabled={active}
            onChange={(e) => setMaxSize(e.target.value ? Number(e.target.value) : undefined)}
            style={selectStyle(active)}
          >
            {MAX_SIZE_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.value ?? ''}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#cbd5e1' }}>
          码率
          <select value={bitRate} disabled={active} onChange={(e) => setBitRate(e.target.value)} style={selectStyle(active)}>
            {BIT_RATE_OPTIONS.map((rate) => (
              <option key={rate} value={rate}>
                {rate}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#cbd5e1', cursor: starting ? 'not-allowed' : 'pointer', opacity: starting ? 0.6 : 1 }}
          title="默认声音留在设备本机播放；勾选把设备声音转到电脑（设备本机会静音）。投屏过程中可随时切换，不影响画面。"
        >
          <input
            type="checkbox"
            checked={audioOn}
            disabled={starting}
            onChange={(e) => {
              // 投屏中实时切换；未投屏时仅记录启动初值。
              if (active) onToggleAudio(e.target.checked);
              else setForwardAudio(e.target.checked);
            }}
            style={{ cursor: starting ? 'not-allowed' : 'pointer' }}
          />
          把设备声音传到电脑{active ? '（可实时切换）' : ''}
        </label>
        {active && <span style={{ fontSize: '12px', color: '#6b7280' }}>分辨率 / 码率投屏中不可改，声音可随时切换</span>}
      </div>

      {isPico && (
        <div
          style={{
            padding: '12px 16px',
            backgroundColor: '#a78bfa18',
            border: '1px solid #a78bfa44',
            borderRadius: '8px',
            color: '#c4b5fd',
            fontSize: '13px',
            lineHeight: 1.6,
          }}
        >
          ⚠️ Pico 设备：仅支持 <b>2D 界面</b>（启动器、平面应用）的触屏操控；VR 沉浸场景的 <b>6DoF 手柄无法操控</b>（手柄输入走 VR runtime，非标准 Android 事件，scrcpy 无法注入）。画面已自动裁切为单眼显示。
        </div>
      )}

      {status === 'failed' && session?.error && (
        <div
          style={{
            padding: '12px 16px',
            backgroundColor: '#ef444422',
            border: '1px solid #ef444455',
            borderRadius: '8px',
            color: '#fca5a5',
            fontSize: '13px',
            wordBreak: 'break-all',
          }}
        >
          {session.error}
        </div>
      )}

      <div
        style={{
          padding: '16px 20px',
          backgroundColor: '#1f1f33',
          border: '1px solid #353550',
          borderRadius: '10px',
          fontSize: '13px',
          color: '#cbd5e1',
          lineHeight: 1.7,
        }}
      >
        <div style={{ fontWeight: 600, color: '#e5e7eb', marginBottom: '6px' }}>使用说明</div>
        <div>· 点击「开始投屏」会调起独立的 scrcpy 镜像窗口，高帧率显示并可操控设备。</div>
        <div>· 在镜像窗口内用鼠标点击 / 拖拽操作触屏，键盘可直接输入文字。</div>
        <div>· 把 .apk 文件拖进镜像窗口可直接安装；拖其他文件则推送到设备 /sdcard/Download/（安装无窗口内提示，结果可在设备查看）。</div>
        <div>· 关闭镜像窗口或点「停止投屏」即结束，设备上无需安装任何应用。</div>

        <button
          onClick={() => setShowShortcuts((v) => !v)}
          style={{
            marginTop: '12px',
            padding: '6px 0',
            fontSize: '13px',
            fontWeight: 600,
            color: '#60a5fa',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          {showShortcuts ? '▾ 收起快捷键速查' : '▸ 展开快捷键速查'}
        </button>

        {showShortcuts && (
          <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {SHORTCUTS.map((s) => (
              <div
                key={s.keys}
                style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px', padding: '3px 0', borderBottom: '1px solid #2b2b45' }}
              >
                <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{s.keys}</span>
                <span style={{ color: '#e5e7eb' }}>{s.action}</span>
              </div>
            ))}
            <div style={{ marginTop: '4px', fontSize: '12px', color: '#6b7280' }}>
              修饰键 MOD 默认为左 Alt 或左 Super，可在 scrcpy 启动参数中改。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
