import { useState, useEffect } from 'react';
import { FileBrowser } from './components/FileBrowser';
import FileUploader from './components/FileUploader';
import SessionConfig from './components/SessionConfig';
import axios from 'axios';

function App() {
  const [isReady, setIsReady] = useState(false);

  // Check if backend is reachable
  useEffect(() => {
    const checkBackend = async () => {
      try {
        await axios.get('/api/v1/files', {
          params: { page: 1, page_size: 1 },
          timeout: 5000,
        });
        setIsReady(true);
      } catch {
        // Backend might not have Telegram configured yet, but is running
        setIsReady(true);
      }
    };
    checkBackend();
  }, []);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ padding: '16px', borderBottom: '1px solid #e5e7eb', background: '#fff' }}>
        <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 600 }}>TeleDrive</h1>
        <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: '#6b7280' }}>
          Cloud Storage powered by Telegram
        </p>
      </header>
      
      {/* Backend / Telegram Connection Status */}
      <SessionConfig onConfigured={() => setIsReady(true)} />
      
      {/* File Uploader */}
      <FileUploader isConfigured={isReady} />
      
      {/* File Browser */}
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <FileBrowser />
        </div>
      </main>
    </div>
  );
}

export default App;
