import { ChonkyDrive } from './components/ChonkyDrive';
import SessionConfig from './components/SessionConfig';

function App() {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '16px', borderBottom: '1px solid #e5e7eb', background: '#fff' }}>
        <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 600 }}>TeleDrive</h1>
        <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: '#6b7280' }}>
          Cloud Storage powered by Telegram
        </p>
      </header>
      
      {/* Backend / Telegram Connection Status */}
      <SessionConfig />
      
      {/* File Browser */}
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <ChonkyDrive />
        </div>
      </main>
    </div>
  );
}

export default App;
