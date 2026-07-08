import { useState, useEffect } from 'react';
import { ChonkyDrive } from './components/ChonkyDrive';
import SessionConfig from './components/SessionConfig';
import LoginScreen from './components/LoginScreen';
import { api } from './api/client';
import { getTelegramClient, resetTelegramClient, saveCredentialsToStorage, loadCredentialsFromStorage, clearCredentialsFromStorage } from './lib/gramjs';

type AuthState = 'loading' | 'unauthenticated' | 'authenticated';

const API_ID = parseInt(import.meta.env.VITE_TELEGRAM_API_ID || '0');
const API_HASH = import.meta.env.VITE_TELEGRAM_API_HASH || '';

function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [userName, setUserName] = useState('');

  useEffect(() => {
    const { sessionString, jwt } = loadCredentialsFromStorage();
    if (!sessionString || !jwt) {
      setAuthState('unauthenticated');
      return;
    }
    // Show the file browser immediately — the file list only needs the backend JWT.
    // The Telegram MTProto handshake runs in the background; GramJS-dependent actions
    // (thumbnails, upload, download, preview) await client.waitUntilReady() internally.
    setAuthState('authenticated');
    getTelegramClient().initialize(API_ID, API_HASH, sessionString)
      .catch(() => {
        clearCredentialsFromStorage();
        setAuthState('unauthenticated');
      });
  }, []);

  const handleLogin = async (sessionString: string) => {
    const loginResp = await api.loginToBackend(sessionString);
    saveCredentialsToStorage(sessionString, loginResp.token);
    setUserName(loginResp.first_name || loginResp.username || String(loginResp.user_id));
    setAuthState('authenticated');
  };

  const handleLogout = () => {
    clearCredentialsFromStorage();
    resetTelegramClient();
    setUserName('');
    setAuthState('unauthenticated');
  };

  if (authState === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#6b7280' }}>
        載入中...
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 600 }}>TeleDrive</h1>
          <p style={{ margin: '2px 0 0 0', fontSize: '11px', color: '#6b7280' }}>
            Cloud Storage powered by Telegram
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {userName && <span style={{ fontSize: 13, color: '#374151' }}>{userName}</span>}
          <button onClick={handleLogout} style={{
            padding: '6px 14px', border: '1px solid #d1d5db', borderRadius: 6,
            background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151',
          }}>
            登出
          </button>
        </div>
      </header>

      <SessionConfig />

      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <ChonkyDrive />
        </div>
      </main>
    </div>
  );
}

export default App;
