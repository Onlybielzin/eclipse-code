import { IPC_EVENT_CHANNELS } from '@shared/ipc'
import { REMOTE_BLOCKED_EVENT_PREFIX } from '@shared/remote'

/**
 * Texto de /remote-bridge.js: define window.eclipse igual ao preload, falando com o servidor
 * remoto (POST /api/invoke e SSE em /api/events). Roda no navegador do celular, em JS puro.
 */
export function buildBridgeScript(): string {
  const channels = IPC_EVENT_CHANNELS.filter((c) => !c.startsWith(REMOTE_BLOCKED_EVENT_PREFIX))
  return `(function () {
  var allowed = ${JSON.stringify(channels)};
  var listeners = {};
  var source = null;
  function ensureSource() {
    if (source) return;
    source = new EventSource('/api/events'); // reconecta sozinho
    source.onerror = function () {
      // Sem cookie valido o EventSource reconectaria sem parar: confira com um invoke de teste.
      fetch('/api/invoke', { method: 'POST', headers: { 'X-Eclipse-Remote': '1' }, body: '{}' })
        .then(function (res) {
          if (res.status !== 401) return;
          source.close();
          source = null;
          console.warn('Pareie de novo: abra o link de pareamento em Configurações > Celular no PC.');
        }).catch(function () {});
    };
    source.onmessage = function (event) {
      var message;
      try { message = JSON.parse(event.data); } catch (e) { return; }
      var set = message && listeners[message.channel];
      if (!set) return;
      set.forEach(function (fn) { try { fn(message.payload); } catch (e) { console.error(e); } });
    };
  }
  window.eclipseRemote = true;
  window.eclipse = {
    invoke: function (channel, input) {
      return fetch('/api/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Eclipse-Remote': '1' },
        body: JSON.stringify({ channel: channel, input: input })
      }).then(function (res) { return res.json(); }).catch(function (error) {
        return { ok: false, error: { code: 'unavailable', message: 'Sem conexão com o PC: ' + String(error) } };
      });
    },
    on: function (channel, listener) {
      if (allowed.indexOf(channel) < 0) throw new Error('evento IPC desconhecido: ' + channel);
      (listeners[channel] = listeners[channel] || new Set()).add(listener);
      ensureSource();
      return function () { listeners[channel].delete(listener); };
    },
    pathForFile: function () { return ''; }
  };
})();
`
}
