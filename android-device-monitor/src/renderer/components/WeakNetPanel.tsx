import { useMemo, useState } from 'react';
import type { WeakNetworkHelperStatus, WeakNetworkProfile } from '../../shared/types';
import { WEAK_NETWORK_PRESETS } from '../../shared/types';

type WeakNetParams = Omit<WeakNetworkProfile, 'packageName'>;

type WeakNetPanelProps = {
  deviceConnected: boolean;
  status: WeakNetworkHelperStatus;
  installedPackages: string[];
  loadingPackages: boolean;
  busy: boolean;
  errorMessage: string | null;
  onRefreshPackages: () => void;
  onRefreshStatus: () => void;
  onInstallHelper: () => void;
  onStart: (profile: WeakNetworkProfile) => void;
  onStop: () => void;
  onAuthorize: () => void;
};

const DEFAULT_PARAMS: WeakNetParams = {
  latencyMs: 0,
  jitterMs: 0,
  packetLossPercent: 0,
  uploadKbps: 0,
  downloadKbps: 0,
};

const STATUS_META: Record<WeakNetworkHelperStatus, { label: string; color: string }> = {
  'not-installed': { label: '未安装', color: '#9ca3af' },
  idle: { label: '已就绪', color: '#22c55e' },
  'need-vpn-permission': { label: '待授权', color: '#eab308' },
  running: { label: '运行中', color: '#4a90d9' },
  stopped: { label: '已停止', color: '#9ca3af' },
  error: { label: '异常', color: '#ef4444' },
};

const PARAM_FIELDS: { key: keyof WeakNetParams; label: string; min: number; max: number; step: number }[] = [
  { key: 'latencyMs', label: '延迟 (ms)', min: 0, max: 60000, step: 10 },
  { key: 'jitterMs', label: '抖动 (ms)', min: 0, max: 60000, step: 10 },
  { key: 'packetLossPercent', label: '丢包 (%)', min: 0, max: 100, step: 1 },
  { key: 'uploadKbps', label: '上行 (kbps，0=不限)', min: 0, max: 1000000, step: 64 },
  { key: 'downloadKbps', label: '下行 (kbps，0=不限)', min: 0, max: 1000000, step: 64 },
];

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
};

const panelBg = '#252540';
const border = '#353550';

const buttonStyle = (variant: 'primary' | 'danger' | 'ghost', disabled: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  backgroundColor: disabled ? '#33334d' : variant === 'primary' ? '#4a90d9' : variant === 'danger' ? '#b9433a' : '#353550',
  border: 'none',
  borderRadius: '6px',
  color: disabled ? '#6b7280' : 'white',
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: '14px',
});

export function WeakNetPanel({
  deviceConnected,
  status,
  installedPackages,
  loadingPackages,
  busy,
  errorMessage,
  onRefreshPackages,
  onRefreshStatus,
  onInstallHelper,
  onStart,
  onStop,
  onAuthorize,
}: WeakNetPanelProps) {
  const [selectedPackage, setSelectedPackage] = useState('');
  const [params, setParams] = useState<WeakNetParams>(DEFAULT_PARAMS);

  const statusMeta = STATUS_META[status];
  const isRunning = status === 'running';
  const installed = status !== 'not-installed';
  const canStart = deviceConnected && installed && !busy && !isRunning && selectedPackage.trim().length > 0;

  const setParam = (field: typeof PARAM_FIELDS[number], rawValue: string) => {
    const parsed = field.key === 'packetLossPercent' ? Number.parseFloat(rawValue) : Number.parseInt(rawValue, 10);
    setParams((prev) => ({ ...prev, [field.key]: clamp(Number.isNaN(parsed) ? 0 : parsed, field.min, field.max) }));
  };

  const applyPreset = (values: WeakNetParams) => setParams(values);

  const handleStart = () => {
    if (!canStart) return;
    onStart({ packageName: selectedPackage.trim(), ...params });
  };

  const packageOptions = useMemo(() => installedPackages.slice().sort((a, b) => a.localeCompare(b)), [installedPackages]);

  if (!deviceConnected) {
    return (
      <div style={{ color: '#94a3b8', padding: '24px', textAlign: 'center' }}>
        请先连接并选中一台设备，再使用弱网控制。
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* 状态栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span style={{ color: '#94a3b8' }}>助手状态</span>
        <span style={{
          padding: '4px 10px',
          borderRadius: '999px',
          backgroundColor: '#1d1d33',
          border: `1px solid ${statusMeta.color}`,
          color: statusMeta.color,
          fontSize: '13px',
        }}>
          {statusMeta.label}
        </span>
        <button onClick={onRefreshStatus} disabled={busy} style={buttonStyle('ghost', busy)}>刷新状态</button>
        {!installed && (
          <button onClick={onInstallHelper} disabled={busy} style={buttonStyle('primary', busy)}>
            {busy ? '安装中…' : '安装助手'}
          </button>
        )}
        <button onClick={onAuthorize} disabled={busy || !installed} style={buttonStyle('ghost', busy || !installed)}>
          在设备上授权 VPN
        </button>
      </div>

      {installed && (
        <div style={{ color: '#6b7280', fontSize: '12px' }}>
          首次使用需先点「在设备上授权 VPN」，并在头显内确认 VPN 连接请求；授权后再启动弱网。
        </div>
      )}

      {errorMessage && (
        <div style={{ color: '#ef4444', backgroundColor: '#2a1d1d', border: '1px solid #b9433a', borderRadius: '6px', padding: '8px 12px', fontSize: '13px' }}>
          {errorMessage}
        </div>
      )}

      {/* 目标应用 */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={{ color: '#94a3b8', minWidth: '64px' }}>目标应用</span>
        <select
          value={selectedPackage}
          onChange={(event) => setSelectedPackage(event.target.value)}
          disabled={busy}
          style={{ flex: 1, padding: '8px 12px', backgroundColor: panelBg, border: `1px solid ${border}`, borderRadius: '6px', color: 'white', fontSize: '14px', outline: 'none' }}
        >
          <option value="">{loadingPackages ? '加载中…' : packageOptions.length ? '请选择目标应用包名' : '未获取到已安装应用'}</option>
          {packageOptions.map((pkg) => (
            <option key={pkg} value={pkg}>{pkg}</option>
          ))}
        </select>
        <button onClick={onRefreshPackages} disabled={busy} style={buttonStyle('ghost', busy)}>刷新列表</button>
      </div>

      {/* 预设档位 */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: '#94a3b8', minWidth: '64px' }}>预设档位</span>
        {WEAK_NETWORK_PRESETS.map((preset) => (
          <button key={preset.id} onClick={() => applyPreset(preset.values)} disabled={busy} style={buttonStyle('ghost', busy)}>
            {preset.label}
          </button>
        ))}
        <button onClick={() => applyPreset(DEFAULT_PARAMS)} disabled={busy} style={buttonStyle('ghost', busy)}>清零</button>
      </div>

      {/* 参数 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', backgroundColor: panelBg, borderRadius: '8px', padding: '16px' }}>
        {PARAM_FIELDS.map((field) => (
          <label key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: '4px', color: '#94a3b8', fontSize: '13px' }}>
            {field.label}
            <input
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              value={params[field.key]}
              disabled={busy}
              onChange={(event) => setParam(field, event.target.value)}
              style={{ padding: '8px 10px', backgroundColor: '#1d1d33', border: `1px solid ${border}`, borderRadius: '6px', color: 'white', fontSize: '14px', outline: 'none' }}
            />
          </label>
        ))}
      </div>

      {/* 起停 */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        {isRunning ? (
          <button onClick={onStop} disabled={busy} style={buttonStyle('danger', busy)}>
            {busy ? '处理中…' : '停止弱网'}
          </button>
        ) : (
          <button onClick={handleStart} disabled={!canStart} style={buttonStyle('primary', !canStart)}>
            {busy ? '处理中…' : '启动弱网'}
          </button>
        )}
        <span style={{ color: '#6b7280', fontSize: '12px' }}>
          {isRunning ? '弱网生效中，修改参数后需先停止再重新启动。' : '弱网仅作用于所选目标应用，不影响整机网络与 ADB。'}
        </span>
      </div>
    </div>
  );
}
