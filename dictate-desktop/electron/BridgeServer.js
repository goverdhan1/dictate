const http = require('http');

const PORT = 38473;
const HOST = '127.0.0.1';

class BridgeServer {
  constructor(bridgeRouter) {
    this.bridgeRouter = bridgeRouter;
    this.server = null;
    this.pendingActions = [];
    this.sendQueueProcessing = false;
    this.sendQueueClaimedAt = 0;
  }

  enqueueAction(action) {
    if (!action) return;
    if (this.pendingActions.includes(action)) return;
    this.pendingActions.push(action);
  }

  getPendingActions() {
    return [...this.pendingActions];
  }

  resetStaleSendQueueClaim(maxAgeMs = 35000) {
    if (!this.sendQueueProcessing) return;
    if (Date.now() - this.sendQueueClaimedAt > maxAgeMs) {
      this.sendQueueProcessing = false;
      this.sendQueueClaimedAt = 0;
    }
  }

  tryClaimSendQueue() {
    this.resetStaleSendQueueClaim();
    const hasQueue = this.pendingActions.includes('sendMeetingQueue')
      || this.pendingActions.includes('sendTeamsQueue');
    if (!hasQueue || this.sendQueueProcessing) return false;
    this.sendQueueProcessing = true;
    this.sendQueueClaimedAt = Date.now();
    return true;
  }

  completeSendQueue() {
    this.pendingActions = this.pendingActions.filter(
      (a) => a !== 'sendMeetingQueue' && a !== 'sendTeamsQueue'
    );
    this.sendQueueProcessing = false;
    this.sendQueueClaimedAt = 0;
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
        this.resetStaleSendQueueClaim();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ actions: this.getPendingActions() }));
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
