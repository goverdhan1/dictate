const http = require('http');

const PORT = 38473;
const HOST = '127.0.0.1';

class BridgeServer {
  constructor(bridgeRouter) {
    this.bridgeRouter = bridgeRouter;
    this.server = null;
    this.pendingActions = [];
  }

  enqueueAction(action) {
    if (!action || this.pendingActions.includes(action)) return;
    this.pendingActions.push(action);
  }

  dequeueActions() {
    const actions = this.pendingActions.slice();
    this.pendingActions = [];
    return actions;
  }

  start() {
    if (this.server) return;

    this.server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, app: 'dictate-desktop' }));
        return;
      }

      if (req.method === 'GET' && req.url === '/pending') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ actions: this.dequeueActions() }));
        return;
      }

      if (req.method === 'POST' && req.url === '/bridge') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const message = JSON.parse(body || '{}');
            const result = await this.bridgeRouter.handleRuntimeMessage(message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result || { success: true }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    this.server.listen(PORT, HOST, () => {
      console.log(`[Dictate] Bridge server listening on http://${HOST}:${PORT}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  static get url() {
    return `http://${HOST}:${PORT}`;
  }
}

module.exports = { BridgeServer, DESKTOP_BRIDGE_URL: `http://${HOST}:${PORT}` };
