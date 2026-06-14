import { useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { getTelegramClient } from '../lib/gramjs';

type Props = {
  onLogin: (sessionString: string) => Promise<void>;
};

type Tab = 'qr' | 'phone';
type PhoneStep = 'phone' | 'code' | 'password';

const API_ID = parseInt(import.meta.env.VITE_TELEGRAM_API_ID || '0');
const API_HASH = import.meta.env.VITE_TELEGRAM_API_HASH || '';

export default function LoginScreen({ onLogin }: Props) {
  const [tab, setTab] = useState<Tab>('qr');

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: '#f9fafb',
    }}>
      <div style={{
        background: '#fff', borderRadius: 12, boxShadow: '0 4px 24px rgba(0,0,0,0.10)',
        padding: '40px 48px', minWidth: 360, maxWidth: 420,
      }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 700 }}>TeleDrive</h1>
        <p style={{ margin: '0 0 28px', color: '#6b7280', fontSize: 13 }}>
          使用 Telegram 帳號登入
        </p>

        <div style={{ display: 'flex', gap: 0, marginBottom: 28, borderBottom: '1px solid #e5e7eb' }}>
          {(['qr', 'phone'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: '8px 0', border: 'none', background: 'none',
              fontWeight: tab === t ? 600 : 400,
              color: tab === t ? '#2563eb' : '#6b7280',
              borderBottom: tab === t ? '2px solid #2563eb' : '2px solid transparent',
              cursor: 'pointer', fontSize: 14,
            }}>
              {t === 'qr' ? '掃描 QR Code' : '手機號碼'}
            </button>
          ))}
        </div>

        {tab === 'qr'
          ? <QRTab onLogin={onLogin} apiId={API_ID} apiHash={API_HASH} />
          : <PhoneTab onLogin={onLogin} apiId={API_ID} apiHash={API_HASH} />}
      </div>
    </div>
  );
}

function QRTab({ onLogin, apiId, apiHash }: { onLogin: (s: string) => Promise<void>; apiId: number; apiHash: string }) {
  const [qrUrl, setQrUrl] = useState<string>('');
  const [status, setStatus] = useState<string>('正在生成 QR Code...');
  const [passwordHint, setPasswordHint] = useState('');
  const [password, setPassword] = useState('');
  const [awaitingPassword, setAwaitingPassword] = useState(false);
  const [resolvePassword, setResolvePassword] = useState<((p: string) => void) | null>(null);
  const [error, setError] = useState('');

  const startQR = useCallback(() => {
    setQrUrl('');
    setStatus('正在連線...');
    setError('');
    setAwaitingPassword(false);

    const client = getTelegramClient();
    client.startQRLogin(
      apiId,
      apiHash,
      (url) => { setQrUrl(url); setStatus('請用 Telegram 手機 App 掃描'); },
      (hint) => {
        setPasswordHint(hint || '');
        setAwaitingPassword(true);
        return new Promise<string>((resolve) => {
          setResolvePassword(() => resolve);
        });
      },
    ).then(async (sessionString) => {
      setStatus('後端驗證中...');
      await onLogin(sessionString);
      setStatus('登入成功！');
    }).catch((err) => {
      setError('QR 登入失敗：' + (err?.message ?? err));
      setStatus('');
    });
  }, [apiId, apiHash, onLogin]);

  useEffect(() => { startQR(); }, [startQR]);

  const submitPassword = () => {
    resolvePassword?.(password);
    setPassword('');
    setAwaitingPassword(false);
    setStatus('驗證中...');
  };

  if (awaitingPassword) {
    return (
      <div>
        <p style={{ marginBottom: 12, fontSize: 14, color: '#374151' }}>
          請輸入兩步驟驗證密碼{passwordHint ? `（提示：${passwordHint}）` : ''}
        </p>
        <input
          type="password" placeholder="密碼" value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitPassword(); }}
          style={inputStyle}
          autoFocus
        />
        <button onClick={submitPassword} style={btnStyle}>確認</button>
        {error && <p style={errorStyle}>{error}</p>}
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center' }}>
      {qrUrl
        ? <QRCodeSVG value={qrUrl} size={200} style={{ margin: '0 auto 16px', display: 'block' }} />
        : <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
            載入中...
          </div>}
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>{status}</p>
      {error && <p style={errorStyle}>{error}</p>}
      <button onClick={startQR} style={{ ...btnStyle, background: '#f3f4f6', color: '#374151', marginTop: 8 }}>
        重新生成
      </button>
    </div>
  );
}

function PhoneTab({ onLogin, apiId, apiHash }: { onLogin: (s: string) => Promise<void>; apiId: number; apiHash: string }) {
  const [step, setStep] = useState<PhoneStep>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [passwordHint, setPasswordHint] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loginControls, setLoginControls] = useState<{
    submitCode: (c: string) => void;
    submitPassword: (p: string) => void;
    waitForLogin: Promise<string>;
  } | null>(null);

  const startPhoneLogin = () => {
    setError('');
    setLoading(true);
    const client = getTelegramClient();
    const controls = client.startPhoneLogin(
      apiId, apiHash, phone,
      () => { setStep('code'); setLoading(false); },
      (hint) => { setPasswordHint(hint); setStep('password'); setLoading(false); },
    );
    setLoginControls(controls);
    controls.waitForLogin
      .then((sessionString) => onLogin(sessionString))
      .catch((err) => { setError('登入失敗：' + (err?.message ?? err)); setLoading(false); });
  };

  const submitCode = () => {
    if (!loginControls) return;
    setLoading(true);
    loginControls.submitCode(code);
  };

  const submitPassword = () => {
    if (!loginControls) return;
    setLoading(true);
    loginControls.submitPassword(password);
  };

  if (step === 'phone') {
    return (
      <div>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
          輸入含國碼的手機號碼（例：+886912345678）
        </p>
        <input
          type="tel" placeholder="+886..." value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') startPhoneLogin(); }}
          style={inputStyle} autoFocus
        />
        <button onClick={startPhoneLogin} disabled={!phone || loading} style={btnStyle}>
          {loading ? '發送中...' : '發送驗證碼'}
        </button>
        {error && <p style={errorStyle}>{error}</p>}
      </div>
    );
  }

  if (step === 'code') {
    return (
      <div>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
          Telegram 已發送驗證碼到 {phone}
        </p>
        <input
          type="text" placeholder="驗證碼" value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitCode(); }}
          style={inputStyle} autoFocus
        />
        <button onClick={submitCode} disabled={!code || loading} style={btnStyle}>
          {loading ? '驗證中...' : '確認'}
        </button>
        {error && <p style={errorStyle}>{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
        請輸入兩步驟驗證密碼{passwordHint ? `（提示：${passwordHint}）` : ''}
      </p>
      <input
        type="password" placeholder="密碼" value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submitPassword(); }}
        style={inputStyle} autoFocus
      />
      <button onClick={submitPassword} disabled={!password || loading} style={btnStyle}>
        {loading ? '驗證中...' : '確認'}
      </button>
      {error && <p style={errorStyle}>{error}</p>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', border: '1px solid #d1d5db',
  borderRadius: 8, fontSize: 14, marginBottom: 12,
  boxSizing: 'border-box', outline: 'none',
};

const btnStyle: React.CSSProperties = {
  width: '100%', padding: '10px 0', background: '#2563eb', color: '#fff',
  border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600,
  cursor: 'pointer',
};

const errorStyle: React.CSSProperties = {
  marginTop: 8, fontSize: 13, color: '#dc2626',
};
