import { useMemo } from 'react';
import type { NetworkRequest } from '../../shared/types';

type NetworkPanelProps = {
  packageFilter: string;
  onPackageFilterChange: (value: string) => void;
  networkRequests: NetworkRequest[];
  selectedNetworkRequestId: string | null;
  onSelectNetworkRequest: (requestId: string) => void;
  onCaptureRequests: () => void;
};

const getNetworkStatusColor = (statusCode: number) => {
  if (statusCode >= 500) return '#ef4444';
  if (statusCode >= 400) return '#f97316';
  if (statusCode >= 300) return '#eab308';
  if (statusCode >= 200) return '#22c55e';
  return '#9ca3af';
};

const formatNetworkDuration = (duration: number) => {
  if (!duration) return '--';
  if (duration < 1000) return `${duration} ms`;
  return `${(duration / 1000).toFixed(2)} s`;
};

const renderHeaderMap = (headers?: Record<string, string>) => {
  if (!headers || Object.keys(headers).length === 0) {
    return <div style={{ color: '#6b7280' }}>--</div>;
  }

  return Object.entries(headers).map(([key, value]) => (
    <div
      key={key}
      style={{
        display: 'grid',
        gridTemplateColumns: '120px 1fr',
        gap: '8px',
        padding: '4px 0',
        borderBottom: '1px solid #2b2b45',
      }}
    >
      <div style={{ color: '#94a3b8' }}>{key}</div>
      <div style={{ color: '#e5e7eb', wordBreak: 'break-all' }}>{value}</div>
    </div>
  ));
};

export function NetworkPanel({
  packageFilter,
  onPackageFilterChange,
  networkRequests,
  selectedNetworkRequestId,
  onSelectNetworkRequest,
  onCaptureRequests,
}: NetworkPanelProps) {
  const selectedNetworkRequest = useMemo(
    () => networkRequests.find((request) => request.id === selectedNetworkRequestId) || networkRequests[0] || null,
    [networkRequests, selectedNetworkRequestId]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', gap: '8px' }}>
        <input
          type="text"
          placeholder="包名备注，可选"
          value={packageFilter}
          onChange={(event) => onPackageFilterChange(event.target.value)}
          style={{
            flex: 1,
            padding: '8px 12px',
            backgroundColor: '#252540',
            border: '1px solid #353550',
            borderRadius: '6px',
            color: 'white',
            fontSize: '14px',
            outline: 'none',
          }}
        />
        <button
          onClick={onCaptureRequests}
          style={{
            padding: '8px 16px',
            backgroundColor: '#4a90d9',
            border: 'none',
            borderRadius: '6px',
            color: 'white',
            cursor: 'pointer',
          }}
        >
          {'抓取 HTTP'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(480px, 1.25fr) minmax(320px, 0.95fr)', gap: '12px', minHeight: '420px' }}>
        <div style={{ backgroundColor: '#252540', borderRadius: '8px', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ backgroundColor: '#353550' }}>
              <tr>
                <th style={{ padding: '12px', textAlign: 'left', color: '#888' }}>{'方法'}</th>
                <th style={{ padding: '12px', textAlign: 'left', color: '#888' }}>{'URL'}</th>
                <th style={{ padding: '12px', textAlign: 'left', color: '#888' }}>{'状态'}</th>
                <th style={{ padding: '12px', textAlign: 'left', color: '#888' }}>{'耗时'}</th>
                <th style={{ padding: '12px', textAlign: 'left', color: '#888' }}>{'时间'}</th>
              </tr>
            </thead>
            <tbody>
              {networkRequests.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: '32px', textAlign: 'center', color: '#666' }}>
                    {'暂无网络请求数据'}
                  </td>
                </tr>
              ) : (
                networkRequests.map((request) => (
                  <tr
                    key={request.id}
                    onClick={() => onSelectNetworkRequest(request.id)}
                    style={{
                      borderBottom: '1px solid #353550',
                      cursor: 'pointer',
                      backgroundColor: selectedNetworkRequest?.id === request.id ? '#1e3a5f' : 'transparent',
                    }}
                  >
                    <td style={{ padding: '10px 12px', color: '#22c55e', fontWeight: 600, whiteSpace: 'nowrap' }}>{request.method}</td>
                    <td style={{ padding: '10px 12px', color: '#fff', maxWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={request.url}>
                      {request.url}
                    </td>
                    <td style={{ padding: '10px 12px', color: getNetworkStatusColor(request.statusCode), whiteSpace: 'nowrap' }}>
                      {request.statusCode ? `${request.statusCode}${request.statusText ? ` ${request.statusText}` : ''}` : '--'}
                    </td>
                    <td style={{ padding: '10px 12px', color: '#cbd5e1', whiteSpace: 'nowrap' }}>{formatNetworkDuration(request.duration)}</td>
                    <td style={{ padding: '10px 12px', color: '#888', whiteSpace: 'nowrap' }}>{new Date(request.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div style={{ backgroundColor: '#252540', borderRadius: '8px', padding: '14px', overflow: 'auto' }}>
          {selectedNetworkRequest ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <div style={{ fontSize: '18px', fontWeight: 600, color: '#fff', marginBottom: '6px' }}>
                  {selectedNetworkRequest.method} {selectedNetworkRequest.path || selectedNetworkRequest.url}
                </div>
                <div style={{ fontSize: '12px', color: '#94a3b8', wordBreak: 'break-all' }}>{selectedNetworkRequest.url}</div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
                <div style={{ backgroundColor: '#202038', borderRadius: '6px', padding: '10px' }}>
                  <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>{'状态'}</div>
                  <div style={{ color: getNetworkStatusColor(selectedNetworkRequest.statusCode), fontWeight: 600 }}>
                    {selectedNetworkRequest.statusCode
                      ? `${selectedNetworkRequest.statusCode}${selectedNetworkRequest.statusText ? ` ${selectedNetworkRequest.statusText}` : ''}`
                      : '--'}
                  </div>
                </div>
                <div style={{ backgroundColor: '#202038', borderRadius: '6px', padding: '10px' }}>
                  <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>{'耗时'}</div>
                  <div style={{ color: '#e5e7eb', fontWeight: 600 }}>{formatNetworkDuration(selectedNetworkRequest.duration)}</div>
                </div>
                <div style={{ backgroundColor: '#202038', borderRadius: '6px', padding: '10px' }}>
                  <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>{'主机'}</div>
                  <div style={{ color: '#60a5fa', wordBreak: 'break-all' }}>{selectedNetworkRequest.host || selectedNetworkRequest.headers.Host || '--'}</div>
                </div>
                <div style={{ backgroundColor: '#202038', borderRadius: '6px', padding: '10px' }}>
                  <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>{'时间'}</div>
                  <div style={{ color: '#e5e7eb' }}>{new Date(selectedNetworkRequest.timestamp).toLocaleString('zh-CN', { hour12: false })}</div>
                </div>
              </div>

              <div style={{ fontSize: '12px', color: '#94a3b8' }}>{'状态码和耗时基于短时 tcpdump 文本推断，用于快速排查。'}</div>

              <div>
                <div style={{ fontSize: '13px', color: '#888', marginBottom: '8px' }}>{'请求头'}</div>
                <div style={{ backgroundColor: '#202038', borderRadius: '6px', padding: '10px' }}>{renderHeaderMap(selectedNetworkRequest.headers)}</div>
              </div>
              <div>
                <div style={{ fontSize: '13px', color: '#888', marginBottom: '8px' }}>{'响应头'}</div>
                <div style={{ backgroundColor: '#202038', borderRadius: '6px', padding: '10px' }}>
                  {renderHeaderMap(selectedNetworkRequest.responseHeaders)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '13px', color: '#888', marginBottom: '8px' }}>{'请求体'}</div>
                <div
                  style={{
                    backgroundColor: '#202038',
                    borderRadius: '6px',
                    padding: '10px',
                    color: '#e5e7eb',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    minHeight: '72px',
                  }}
                >
                  {selectedNetworkRequest.requestBody || '--'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '13px', color: '#888', marginBottom: '8px' }}>{'响应体'}</div>
                <div
                  style={{
                    backgroundColor: '#202038',
                    borderRadius: '6px',
                    padding: '10px',
                    color: '#e5e7eb',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    minHeight: '72px',
                  }}
                >
                  {selectedNetworkRequest.responseBody || '--'}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6b7280' }}>
              {'选中一条请求查看详情'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
