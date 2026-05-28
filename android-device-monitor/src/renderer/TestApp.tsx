function TestApp() {
  return (
    <div style={{
      width: '100%',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#1a1a2e',
      color: 'white'
    }}>
      <h1 style={{ fontSize: '32px', marginBottom: '20px' }}>{'\u5b89\u5353\u8bbe\u5907\u76d1\u63a7'}</h1>
      <p style={{ color: '#888' }}>{'\u6d4b\u8bd5\u9875\u9762 - \u5e94\u7528\u6b63\u5728\u8fd0\u884c'}</p>
      <button
        onClick={() => alert('\u6309\u94ae\u70b9\u51fb\u6210\u529f')}
        style={{
          marginTop: '20px',
          padding: '10px 20px',
          fontSize: '16px',
          backgroundColor: '#4a90d9',
          color: 'white',
          border: 'none',
          borderRadius: '5px',
          cursor: 'pointer'
        }}
      >
        {'\u70b9\u51fb\u6d4b\u8bd5'}
      </button>
    </div>
  );
}

export default TestApp;
