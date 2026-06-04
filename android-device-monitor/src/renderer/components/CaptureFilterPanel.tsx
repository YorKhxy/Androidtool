import type { CSSProperties } from 'react';
import {
  METRIC_LABELS,
  type CaptureFilterOp,
  type CaptureMetricKey,
  type FilterCondition,
} from './perfFormat';

type CaptureFilterPanelProps = {
  conditions: FilterCondition[];
  onChange: (conditions: FilterCondition[]) => void;
  onApply: () => void;
  onClear: () => void;
  /** 非 Pico 设备无 GPU 指标，隐藏该选项。 */
  isPico: boolean;
  /** 已应用过滤时命中的时间点数量。 */
  hitCount: number;
  /** 是否已应用过滤（控制命中提示与「清除」可用）。 */
  applied: boolean;
};

const OPS: CaptureFilterOp[] = ['>', '=', '<'];

const selectStyle: CSSProperties = {
  backgroundColor: '#0f172a',
  border: '1px solid #334155',
  borderRadius: '6px',
  color: '#e5e7eb',
  padding: '5px 8px',
  fontSize: '12px',
};

const makeConditionId = () => `c-${Math.round(performance.now() * 1000)}-${Math.floor(Math.random() * 1e6)}`;

export function CaptureFilterPanel({ conditions, onChange, onApply, onClear, isPico, hitCount, applied }: CaptureFilterPanelProps) {
  const metricKeys: CaptureMetricKey[] = isPico ? ['fps', 'cpu', 'mem', 'gpu'] : ['fps', 'cpu', 'mem'];

  const updateCondition = (id: string, patch: Partial<FilterCondition>) =>
    onChange(conditions.map((condition) => (condition.id === id ? { ...condition, ...patch } : condition)));

  const removeCondition = (id: string) => onChange(conditions.filter((condition) => condition.id !== id));

  // 新条件阈值留空（NaN）而非 0：避免受控 number 输入里那个删不掉、老挡在前面的默认 0。
  const addCondition = () =>
    onChange([...conditions, { id: makeConditionId(), metricKey: 'fps', op: '>', threshold: NaN }]);

  // 至少有一条「填了有效阈值」的条件才可过滤。
  const canApply = conditions.some((c) => Number.isFinite(c.threshold));

  return (
    <div style={{ backgroundColor: '#202038', border: '1px solid #353550', borderRadius: '8px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
        <div style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>参数过滤</div>
        <div style={{ color: '#94a3b8', fontSize: '12px' }}>多条件按 AND 组合（全部满足才命中）</div>
      </div>

      {conditions.length === 0 ? (
        <div style={{ color: '#6b7280', fontSize: '12px' }}>添加条件后点「过滤」，在曲线上标出命中时间点。</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {conditions.map((condition) => (
            <div key={condition.id} style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                value={condition.metricKey}
                onChange={(e) => updateCondition(condition.id, { metricKey: e.target.value as CaptureMetricKey })}
                style={selectStyle}
                aria-label="指标"
              >
                {metricKeys.map((key) => (
                  <option key={key} value={key}>{METRIC_LABELS[key]}</option>
                ))}
              </select>
              <select
                value={condition.op}
                onChange={(e) => updateCondition(condition.id, { op: e.target.value as CaptureFilterOp })}
                style={selectStyle}
                aria-label="运算符"
              >
                {OPS.map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>
              <input
                type="number"
                inputMode="decimal"
                placeholder="阈值"
                value={Number.isFinite(condition.threshold) ? condition.threshold : ''}
                onChange={(e) => updateCondition(condition.id, { threshold: e.target.value === '' ? NaN : Number(e.target.value) })}
                style={{ ...selectStyle, width: '88px' }}
                aria-label="阈值"
              />
              <button
                type="button"
                onClick={() => removeCondition(condition.id)}
                style={{ border: '1px solid #475569', borderRadius: '6px', backgroundColor: 'transparent', color: '#94a3b8', cursor: 'pointer', width: '28px', height: '28px', fontSize: '14px' }}
                aria-label="删除条件"
              >×</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={addCondition}
          style={{ border: '1px dashed #475569', borderRadius: '6px', backgroundColor: 'transparent', color: '#cbd5e1', cursor: 'pointer', padding: '6px 12px', fontSize: '12px' }}
        >+ 添加条件</button>
        <button
          type="button"
          onClick={onApply}
          disabled={!canApply}
          style={{ border: 'none', borderRadius: '6px', backgroundColor: canApply ? '#6d28d9' : '#4b5563', color: '#fff', cursor: canApply ? 'pointer' : 'not-allowed', padding: '6px 14px', fontSize: '12px' }}
        >过滤</button>
        <button
          type="button"
          onClick={onClear}
          disabled={!applied && conditions.length === 0}
          style={{ border: '1px solid #475569', borderRadius: '6px', backgroundColor: 'transparent', color: '#cbd5e1', cursor: !applied && conditions.length === 0 ? 'not-allowed' : 'pointer', padding: '6px 14px', fontSize: '12px' }}
        >清除</button>
        {applied && (
          <span style={{ color: hitCount > 0 ? '#fbbf24' : '#94a3b8', fontSize: '12px' }}>
            {hitCount > 0 ? `命中 ${hitCount} 处（点标记跳转）` : '无命中'}
          </span>
        )}
      </div>
    </div>
  );
}
