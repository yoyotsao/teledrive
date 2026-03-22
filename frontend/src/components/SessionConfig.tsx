import { useState, useEffect } from 'react';
import axios from 'axios';

interface SessionConfigProps {
  onConfigured?: () => void;
}

export default function SessionConfig({ onConfigured }: SessionConfigProps) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'connected' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [serverStatus, setServerStatus] = useState<string | null>(null);

  // Check backend health on mount
  useEffect(() => {
    checkBackend();
  }, []);

  const checkBackend = async () => {
    setStatus('checking');
    setErrorMessage('');
    try {
      // Try to hit the files endpoint - if it works, backend is configured
      const response = await axios.get('/api/v1/files', {
        params: { page: 1, page_size: 1 },
        timeout: 10000,
      });
      if (response.status === 200) {
        setStatus('connected');
        setServerStatus('Backend connected');
        onConfigured?.();
      }
    } catch (err: any) {
      // If 401/403 from auth, or 500 from missing config, backend might still work
      if (err.response?.status === 401 || err.response?.status === 403) {
        setStatus('connected');
        setServerStatus('Backend connected (auth required)');
        onConfigured?.();
      } else if (err.code === 'ERR_NETWORK' || err.code === 'ECONNREFUSED') {
        setStatus('error');
        setErrorMessage('Backend not reachable at http://localhost:8000');
      } else {
        // Other errors might just mean no files yet - backend is running
        setStatus('connected');
        setServerStatus('Backend connected');
        onConfigured?.();
      }
    }
  };

  if (status === 'connected') {
    return (
      <div style={{
        padding: '12px 16px',
        background: '#dcfce7',
        borderBottom: '1px solid #86efac',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ color: '#166534' }}>✓</span>
          <span style={{ color: '#166534', fontWeight: 500 }}>TeleDrive Ready</span>
          {serverStatus && (
            <span style={{ color: '#166534', fontSize: '12px' }}>— {serverStatus}</span>
          )}
        </div>
        <button
          onClick={checkBackend}
          style={{
            padding: '4px 12px',
            background: '#22c55e',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          Recheck
        </button>
      </div>
    );
  }

  return (
    <div style={{
      padding: '16px',
      background: '#fef3c7',
      borderBottom: '1px solid #fcd34d'
    }}>
      <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600, color: '#92400e' }}>
        Backend Connection
      </h3>
      <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: '#a16207' }}>
        Make sure the backend is running. Configure credentials in <code>backend/.env</code>
      </p>
      
      {status === 'checking' && (
        <p style={{ margin: 0, fontSize: '13px', color: '#a16207' }}>
          Checking backend connection...
        </p>
      )}

      {status === 'error' && (
        <div>
          <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: '#dc2626' }}>
            ✗ {errorMessage}
          </p>
          <button
            onClick={checkBackend}
            style={{
              padding: '8px 16px',
              background: '#d97706',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: '13px',
            }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
