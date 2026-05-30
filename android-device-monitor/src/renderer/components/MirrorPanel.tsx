import type { MirrorSession, MirrorSessionStatus } from '../../shared/types';

type MirrorPanelProps = {
  deviceName: string;
  session: MirrorSession | null;
  starting: boolean;
  onStart: () => void;
  onStop: () => void;
};

const STATUS_META: Record<MirrorSessionStatus, { label: string; color: string; background: string }> = {
  starting: { label: '启动中', color: '#60a5fa', background: '#1d4ed822' },
  running: { label: '镜像中', color: '#22c55e', background: '#22c55e22' },
  stopped: { label: '已停止', color: '#9ca3af', background: '#4b556322' },
  failed: { label: '启动失败', color: '#ef4444', background: '#ef444422' },
};

const isActive = (session: MirrorSession | null, starting: boolean): boolean => {
  if (starting) return true;
  return session?.status === 'starting' || session?.status === 'running';
};

export function MirrorPanel({ deviceName, session, starting, onStart, onStop }: MirrorPanelProps) {
  const active = isActive(session, starting);
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
          <div style={{ fontSize: '13px', color: '#9ca3af' }}>当前设备：{deviceName}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
          onClick={active ? onStop : onStart}
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
        <div>· 物理键通过 scrcpy 快捷键触发：Alt+h 主页、Alt+b 返回、Alt+s 最近任务、Alt+p 电源、Alt+↑/↓ 音量。</div>
        <div>· 关闭镜像窗口或点「停止投屏」即结束，设备上无需安装任何应用。</div>
      </div>
    </div>
  );
}
