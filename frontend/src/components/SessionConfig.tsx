import { useState, useEffect } from 'react';
import axios from 'axios';

export default function SessionConfig() {
  const [status, setStatus] = useState<'checking' | 'connected' | 'error'>('checking');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => { checkBackend(); }, []);

  const checkBackend = async () => {
    setStatus('checking');
    setErrorMessage('');
    try {
      const token = localStorage.getItem('tg_jwt');
      await axios.get('/api/v1/files', {
        params: { page: 1, page_size: 1 },
        timeout: 10000,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      setStatus('connected');
    } catch (err: any) {
      if (err.response?.status === 401) {
        setStatus('connected');
      } else if (err.code === 'ERR_NETWORK' || err.code === 'ECONNREFUSED') {
        setStatus('error');
        setErrorMessage('無法連線到後端伺服器');
      } else {
        setStatus('connected');
      }
    }
  };

  if (status === 'connected') {
    return (
      <div style={{
        padding: '8px 16px',
        background: '#dcfce7',
        borderBottom: '1px solid #86efac',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ color: '#166534', fontWeight: 500, fontSize: 13 }}>
          ✓ 後端已連線
        </span>
        <button onClick={checkBackend} style={{
          padding: '3px 10px', background: '#22c55e', color: '#fff',
          border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12,
        }}>
          重新確認
        </button>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div style={{
        padding: '8px 16px',
        background: '#fee2e2',
        borderBottom: '1px solid #fca5a5',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ color: '#dc2626', fontSize: 13 }}>✗ {errorMessage}</span>
        <button onClick={checkBackend} style={{
          padding: '3px 10px', background: '#ef4444', color: '#fff',
          border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12,
        }}>
          重試
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 16px', background: '#f3f4f6', borderBottom: '1px solid #e5e7eb', fontSize: 13, color: '#6b7280' }}>
      正在連線...
    </div>
  );
}
