import { useState, useEffect } from 'react';
import './theme.css';
import { ChonkyDrive } from './components/ChonkyDrive';
import SessionConfig from './components/SessionConfig';
import LoginScreen from './components/LoginScreen';
import SettingsDialog from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { SearchBox } from './components/SearchBox';
import { useUrlState } from './hooks/useUrlState';
import { useTheme } from './hooks/useTheme';
import { api } from './api/client';
import {
  TelegramClientManager, adoptClient, getClientFor, resetAllClients,
  loadAccounts, saveAccount, loadJwt, saveJwt, clearCredentialsFromStorage,
} from './lib/gramjs';

type AuthState = 'loading' | 'unauthenticated' | 'authenticated';

const API_ID = parseInt(import.meta.env.VITE_TELEGRAM_API_ID || '0');
const API_HASH = import.meta.env.VITE_TELEGRAM_API_HASH || '';

function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [userName, setUserName] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const url = useUrlState();
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    const accounts = loadAccounts();
    if (accounts.length === 0 || !loadJwt()) {
      setAuthState('unauthenticated');
      return;
    }
    // Show the file browser immediately — the file list only needs the backend JWT.
    // The Telegram MTProto handshake runs in the background; GramJS-dependent actions
    // (thumbnails, upload, download, preview) await client.waitUntilReady() internally.
    setAuthState('authenticated');
    for (const account of accounts) {
      const client = getClientFor(account.id);
      client.initialize(API_ID, API_HASH, account.session)
        .then(() => {
          // Sessions migrated from the single-account era arrive with a
          // placeholder id; initialize() resolves the real one via getMe().
          if (client.accountId !== account.id) {
            adoptClient(client.accountId, client);
            saveAccount({ ...account, id: client.accountId });
          }
        })
        // One account failing must not log the whole drive out — the others
        // still work, and the settings dialog shows which one is offline.
        .catch((err) => {
          console.warn('[App] Account', account.id, 'failed to connect:', err);
          client.offline = true;
        });
    }
  }, []);

  // Prove our identity to the backend by DMing a one-time nonce to its bot —
  // Telegram reports who sent it, so the session string stays in this browser.
  const handleLogin = async (sessionString: string, client: TelegramClientManager) => {
    const { nonce, bot_username } = await api.requestChallenge();
    const messageId = await client.sendAuthChallenge(bot_username, nonce);

    let loginResp = null;
    for (let i = 0; i < 60 && !loginResp; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      loginResp = await api.verifyChallenge(nonce);
    }
    if (!loginResp) throw new Error('Telegram 驗證逾時，請重試');

    client.deleteAuthChallenge(bot_username, messageId);
    const label = loginResp.username || loginResp.first_name || String(loginResp.user_id);
    adoptClient(loginResp.user_id, client);
    saveAccount({ id: loginResp.user_id, label, session: sessionString });
    saveJwt(loginResp.token);
    setUserName(loginResp.first_name || loginResp.username || String(loginResp.user_id));
    setAuthState('authenticated');
  };

  const handleLogout = () => {
    clearCredentialsFromStorage();
    resetAllClients();
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
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--td-bg)', color: 'var(--td-text)' }}>
      <header style={{ padding: '12px 16px', borderBottom: '1px solid var(--td-border)', background: 'var(--td-surface)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 600, color: 'var(--td-text-strong)' }}>TeleDrive</h1>
          <p style={{ margin: '2px 0 0 0', fontSize: '11px', color: 'var(--td-text-muted)' }}>
            Cloud Storage powered by Telegram
          </p>
        </div>
        <SearchBox value={url.view.mode === 'search' ? url.view.query : ''} onChange={url.setSearch} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 'auto' }}>
          <button onClick={toggleTheme} title="切換深色/淺色" style={{
            padding: '6px 10px', border: '1px solid var(--td-border)', borderRadius: 6,
            background: 'var(--td-surface)', fontSize: 16, cursor: 'pointer', color: 'var(--td-text)',
          }}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button onClick={() => setShowSettings(true)} title="設定 / Telegram 帳號" style={{
            padding: '6px 10px', border: '1px solid var(--td-border)', borderRadius: 6,
            background: 'var(--td-surface)', fontSize: 16, cursor: 'pointer', color: 'var(--td-text)',
          }}>
            ⚙️
          </button>
          {userName && <span style={{ fontSize: 13, color: 'var(--td-text)' }}>{userName}</span>}
          <button onClick={handleLogout} style={{
            padding: '6px 14px', border: '1px solid var(--td-border)', borderRadius: 6,
            background: 'var(--td-surface)', fontSize: 13, cursor: 'pointer', color: 'var(--td-text)',
          }}>
            登出
          </button>
        </div>
      </header>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}

      <SessionConfig />

      <main style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        <Sidebar
          active={url.view.mode === 'trash' ? 'trash' : 'drive'}
          onSelectDrive={() => url.navigateFolder(null)}
          onSelectTrash={url.openTrash}
        />
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <ChonkyDrive
            view={url.view}
            sortBy={url.sortBy}
            sortOrder={url.sortOrder}
            onNavigateFolder={url.navigateFolder}
            onSortChange={url.setSort}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
