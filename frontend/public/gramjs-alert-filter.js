// GramJS calls alert() when it receives a Telegram update type it doesn't know.
// These are non-fatal (new API objects the installed GramJS version lacks TL
// definitions for). Intercept and log as console.warn instead of blocking the
// user with a dialog.
//
// A separate file rather than an inline <script> because the production CSP is
// `script-src 'self'` (see security-headers.conf): an inline block is refused
// by the browser, silently, with only a console entry to show for it.
(function () {
  var _nativeAlert = window.alert;
  window.alert = function (msg) {
    if (typeof msg === 'string' && (
      msg.indexOf('Missing MTProto Entity') !== -1 ||
      msg.indexOf('Could not find a matching Constructor ID') !== -1
    )) {
      console.warn('[GramJS unknown TL] ' + msg);
      return;
    }
    return _nativeAlert.call(window, msg);
  };
})();
