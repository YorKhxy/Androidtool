import { useMemo, useState } from 'react';
import type { WeakNetworkHelperStatus, WeakNetworkProfile } from '../../shared/types';
import { WEAK_NETWORK_PRESETS } from '../../shared/types';
import { Icon, Badge, type BadgeTone } from './ui';

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

const STATUS_META: Record<WeakNetworkHelperStatus, { label: string; tone: BadgeTone }> = {
  'not-installed': { label: '未安装', tone: 'neutral' },
  idle: { label: '已就绪', tone: 'success' },
  'need-vpn-permission': { label: '待授权', tone: 'warning' },
  running: { label: '运行中', tone: 'info' },
  stopped: { label: '已停止', tone: 'neutral' },
  error: { label: '异常', tone: 'danger' },
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

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: 'var(--bg-input)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r-sm)',
  color: 'var(--fg-primary)',
  fontSize: '13px',
  outline: 'none',
  fontFamily: 'var(--font-mono)',
};

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

  const labelStyle: React.CSSProperties = { color: 'var(--fg-tertiary)', minWidth: '64px', fontSize: '13px' };

  if (!deviceConnected) {
    return (
      <div style={{ color: 'var(--fg-tertiary)', padding: '24px', textAlign: 'center' }}>
        请先连接并选中一台设备，再使用弱网控制。
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px' }}>
      {/* 状态栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span style={labelStyle}>助手状态</span>
        <Badge tone={statusMeta.tone} dot>{statusMeta.label}</Badge>
        <button className="btn secondary sm" onClick={onRefreshStatus} disabled={busy}>
          <Icon name="refresh-cw" />刷新状态
        </button>
        {!installed && (
          <button className="btn primary sm" onClick={onInstallHelper} disabled={busy}>
            <Icon name="download" />{busy ? '安装中…' : '安装助手'}
          </button>
        )}
        <button className="btn secondary sm" onClick={onAuthorize} disabled={busy || !installed}>
          <Icon name="shield-check" />在设备上授权 VPN
        </button>
      </div>

      {installed && (
        <div style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>
          首次使用需先点「在设备上授权 VPN」，并在头显内确认 VPN 连接请求；授权后再启动弱网。
        </div>
      )}

      {errorMessage && (
        <div style={{ color: 'var(--danger)', background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 'var(--r-sm)', padding: '8px 12px', fontSize: '13px' }}>
          {errorMessage}
        </div>
      )}

      {/* 目标应用 */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={labelStyle}>目标应用</span>
        <select
          className="nat"
          value={selectedPackage}
          onChange={(event) => setSelectedPackage(event.target.value)}
          disabled={busy}
          style={{ flex: 1, minWidth: 0 }}
        >
          <option value="">{loadingPackages ? '加载中…' : packageOptions.length ? '请选择目标应用包名' : '未获取到已安装应用'}</option>
          {packageOptions.map((pkg) => (
            <option key={pkg} value={pkg}>{pkg}</option>
          ))}
        </select>
        <button className="btn secondary sm" onClick={onRefreshPackages} disabled={busy}>
          <Icon name="refresh-cw" />刷新列表
        </button>
      </div>

      {/* 预设档位 */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={labelStyle}>预设档位</span>
        {WEAK_NETWORK_PRESETS.map((preset) => (
          <button key={preset.id} className="btn outline o-blue sm" onClick={() => applyPreset(preset.values)} disabled={busy}>
            {preset.label}
          </button>
        ))}
        <button className="btn ghost sm" onClick={() => applyPreset(DEFAULT_PARAMS)} disabled={busy}>清零</button>
      </div>

      {/* 参数 */}
      <div className="subpanel" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', padding: '16px' }}>
        {PARAM_FIELDS.map((field) => (
          <label key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: '4px', color: 'var(--fg-tertiary)', fontSize: '12px' }}>
            {field.label}
            <input
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              value={params[field.key]}
              disabled={busy}
              onChange={(event) => setParam(field, event.target.value)}
              style={inputStyle}
            />
          </label>
        ))}
      </div>

      {/* 起停 */}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        {isRunning ? (
          <button className="btn o-red outline" onClick={onStop} disabled={busy} style={{ height: 40 }}>
            <Icon name="square" />{busy ? '处理中…' : '停止弱网'}
          </button>
        ) : (
          <button className="btn primary" onClick={handleStart} disabled={!canStart} style={{ height: 40 }}>
            <Icon name="play" />{busy ? '处理中…' : '启动弱网'}
          </button>
        )}
        <span style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>
          {isRunning ? '弱网生效中，修改参数后需先停止再重新启动。' : '弱网仅作用于所选目标应用，不影响整机网络与 ADB。'}
        </span>
      </div>
    </div>
  );
}
