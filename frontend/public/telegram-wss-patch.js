// Rewrites GramJS's MTProto socket URL from a raw Telegram DC IP to that DC's
// official wss:// domain, so the browser opens a TLS connection with a valid
// certificate straight to Telegram — no backend proxy involved.
//
// Load-bearing on HTTPS: without it GramJS asks for ws://149.154.x.x/apiws,
// the browser blocks it as mixed content, and every Telegram operation
// (upload, download, thumbnails, preview) fails while the metadata UI keeps
// rendering normally — so the app looks merely empty rather than broken.
//
// Must run synchronously before any ES module, so that GramJS's W3CWebSocket
// captures the patched constructor. A separate file rather than an inline
// <script> because the production CSP is `script-src 'self'` (see
// security-headers.conf), which refuses inline blocks outright.
(function () {
  if (window.location.protocol !== 'https:') return;

  // Maps Telegram DC IP prefixes to official wss:// domain endpoints.
  // These domains have valid TLS certs — same endpoints used by web.telegram.org.
  function getTelegramDomain(hostname) {
    if (hostname.startsWith('149.154.175.')) {
      var last = parseInt(hostname.split('.')[3], 10);
      return last >= 100 ? 'aurora.web.telegram.org' : 'pluto.web.telegram.org';
    }
    if (hostname.startsWith('149.154.167.') || hostname.startsWith('149.154.166.')) {
      var last = parseInt(hostname.split('.')[3], 10);
      return last >= 91 ? 'vesta.web.telegram.org' : 'venus.web.telegram.org';
    }
    if (hostname.startsWith('91.108.56.') || hostname.startsWith('91.108.4.')) {
      return 'flora.web.telegram.org';
    }
    return null;
  }

  var NativeWS = window.WebSocket;
  function PatchedWebSocket(url, protocols) {
    if (typeof url === 'string' && url.indexOf('/apiws') !== -1) {
      try {
        var p = new URL(url);
        // If it's a raw DC IP, map to named domain. Otherwise keep the hostname.
        // Always upgrade to wss:// — *.web.telegram.org supports WSS directly.
        var domain = getTelegramDomain(p.hostname) || p.hostname;
        url = 'wss://' + domain + '/apiws';
      } catch (e) {}
    }
    if (protocols !== undefined) {
      return new NativeWS(url, protocols);
    }
    return new NativeWS(url);
  }
  PatchedWebSocket.prototype = NativeWS.prototype;
  PatchedWebSocket.CONNECTING = NativeWS.CONNECTING;
  PatchedWebSocket.OPEN       = NativeWS.OPEN;
  PatchedWebSocket.CLOSING    = NativeWS.CLOSING;
  PatchedWebSocket.CLOSED     = NativeWS.CLOSED;
  window.WebSocket = PatchedWebSocket;
})();
