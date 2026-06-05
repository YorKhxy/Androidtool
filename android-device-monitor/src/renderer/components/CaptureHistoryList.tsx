import { useState } from 'react';
import type { PerformanceCaptureSession } from '../../shared/types';
import { formatDuration, formatLocalDateTime } from './perfFormat';

type CaptureHistoryListProps = {
  sessions: PerformanceCaptureSession[];
  selectedSessionId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
};

const defaultTitle = (session: PerformanceCaptureSession) =>
  `${session.deviceSn} · ${formatLocalDateTime(session.startedAt)}`;

export function CaptureHistoryList({ sessions, selectedSessionId, onSelect, onRename, onDelete, onExport }: CaptureHistoryListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const beginEdit = (session: PerformanceCaptureSession) => {
    setEditingId(session.id);
    setEditValue(session.title || defaultTitle(session));
  };

  const commitEdit = (id: string) => {
    onRename(id, editValue);
    setEditingId(null);
  };

  if (sessions.length === 0) {
    return (
      <div style={{ color: '#6b7280', fontSize: '13px', padding: '18px', textAlign: 'center', border: '1px dashed #353550', borderRadius: '8px' }}>
        还没有采集记录。点上方「开始采集」录一段，关闭后会归档到这里，随时回看。
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {sessions.map((session) => {
        const selected = session.id === selectedSessionId;
        const isEditing = session.id === editingId;
        const confirming = session.id === confirmingDeleteId;
        return (
          <div
            key={session.id}
            onClick={() => !isEditing && onSelect(session.id)}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
              padding: '10px 12px',
              borderRadius: '8px',
              border: `1px solid ${selected ? '#6d28d9' : '#353550'}`,
              backgroundColor: selected ? '#2a2150' : '#202038',
              cursor: 'pointer',
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              {isEditing ? (
                <input
                  autoFocus
                  value={editValue}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => commitEdit(session.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit(session.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  style={{ width: '100%', backgroundColor: '#0f172a', border: '1px solid #6d28d9', borderRadius: '6px', color: '#e5e7eb', padding: '4px 8px', fontSize: '13px' }}
                />
              ) : (
                <div
                  onDoubleClick={(e) => { e.stopPropagation(); beginEdit(session); }}
                  title="双击改名"
                  style={{ color: '#fff', fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {session.title || defaultTitle(session)}
                </div>
              )}
              <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '3px' }}>
                {`${session.deviceSn} · ${formatLocalDateTime(session.startedAt)} · ${formatDuration(session.durationMs)}`}
                {session.status === 'failed' && <span style={{ color: '#fca5a5', marginLeft: '8px' }}>失败</span>}
              </div>
            </div>

            {confirming ? (
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => { onDelete(session.id); setConfirmingDeleteId(null); }}
                  style={{ border: 'none', borderRadius: '6px', backgroundColor: '#7f1d1d', color: '#fff', cursor: 'pointer', padding: '5px 10px', fontSize: '12px' }}
                >确认删除</button>
                <button
                  onClick={() => setConfirmingDeleteId(null)}
                  style={{ border: '1px solid #475569', borderRadius: '6px', backgroundColor: 'transparent', color: '#cbd5e1', cursor: 'pointer', padding: '5px 10px', fontSize: '12px' }}
                >取消</button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => onExport(session.id)}
                  title="导出为 zip（可拷到另一台 PC 导入查看）"
                  style={{ border: '1px solid #475569', borderRadius: '6px', backgroundColor: 'transparent', color: '#94a3b8', cursor: 'pointer', padding: '5px 10px', fontSize: '12px' }}
                >导出</button>
                <button
                  onClick={() => setConfirmingDeleteId(session.id)}
                  title="删除该采集记录"
                  style={{ border: '1px solid #475569', borderRadius: '6px', backgroundColor: 'transparent', color: '#94a3b8', cursor: 'pointer', padding: '5px 10px', fontSize: '12px' }}
                >删除</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
