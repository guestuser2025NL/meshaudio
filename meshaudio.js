const express = require('express');
const cookieParser = require('cookie-parser');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const path = require('path');

function createMeshAudioPlugin(options = {}) {
  const {
    app,
    httpServer,
    agentSecret = process.env.MESHAUDIO_AGENT_SECRET || 'CHANGE_ME',
    tokenTtlMs = Number(process.env.MESHAUDIO_TOKEN_TTL_MS || 5 * 60 * 1000),
    allowUnauthenticated = process.env.MESHAUDIO_ALLOW_UNAUTHENTICATED === 'true' || false,
    staticDir = path.join(__dirname, 'web'),
    maxListenersPerDevice = 1,
    logger = console
  } = options;

  if (!app || !httpServer) {
    throw new Error('app and httpServer are required');
  }

  const router = express.Router();
  router.use(express.json());
  router.use(cookieParser());
  router.use('/client', express.static(staticDir));

  const agents = new Map(); // deviceId -> ws
  const sessions = new Map(); // sessionId -> { deviceId, token, userId, expiresAt }
  const viewers = new Map(); // sessionId -> ws
  const activeSessionByDevice = new Map(); // deviceId -> sessionId
  const heartbeats = new Set();

  if (agentSecret === 'CHANGE_ME') {
    logger.warn ? logger.warn('MeshAudio agent secret is default; set MESHAUDIO_AGENT_SECRET') : logger.log('MeshAudio agent secret is default; set MESHAUDIO_AGENT_SECRET');
  }

  router.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  router.post('/token', requireAuth, (req, res) => {
    const { deviceId } = req.body || {};
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId required' });
    }

    const sessionId = uuidv4();
    const token = uuidv4();
    const userId = (req.user && req.user._id) || 'anonymous';
    const expiresAt = Date.now() + tokenTtlMs;

    sessions.set(sessionId, { deviceId, token, userId, expiresAt });

    res.json({ sessionId, token, expiresAt });
  });

  app.use('/meshaudio', router);

  const agentWss = new WebSocketServer({ noServer: true });
  const viewerWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/meshaudio/agent') {
      agentWss.handleUpgrade(req, socket, head, (ws) => {
        agentWss.emit('connection', ws, req);
      });
    } else if (url.pathname === '/meshaudio/view') {
      viewerWss.handleUpgrade(req, socket, head, (ws) => {
        viewerWss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  agentWss.on('connection', (ws, req) => onAgentConnected(ws, req));
  viewerWss.on('connection', (ws, req) => onViewerConnected(ws, req));

  setInterval(() => cleanupExpiredSessions(), 60 * 1000);
  setInterval(() => pingAll(), 30 * 1000);

  function pingAll() {
    for (const ws of heartbeats) {
      if (ws.isAlive === false) {
        ws.terminate();
        heartbeats.delete(ws);
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }

  function requireAuth(req, res, next) {
    if (allowUnauthenticated) {
      return next();
    }

    if (!req.user && !(req.session && req.session.userid)) {
      return res.status(401).json({ error: 'auth required' });
    }
    return next();
  }

  function attachHeartbeat(ws) {
    ws.isAlive = true;
    heartbeats.add(ws);
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('close', () => {
      heartbeats.delete(ws);
    });
  }

  function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt < now) {
        const viewer = viewers.get(sessionId);
        if (viewer) {
          viewer.close(4000, 'session expired');
        }
        if (activeSessionByDevice.get(session.deviceId) === sessionId) {
          activeSessionByDevice.delete(session.deviceId);
          sendToAgent(session.deviceId, { action: 'stop' });
        }
        sessions.delete(sessionId);
      }
    }
  }

  function onAgentConnected(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token') || req.headers['x-meshaudio-token'];
    const deviceId = url.searchParams.get('deviceId') || req.headers['x-meshaudio-device'];

    if (!deviceId || (agentSecret && token !== agentSecret)) {
      ws.close(1008, 'unauthorized');
      return;
    }

    const existing = agents.get(deviceId);
    if (existing) {
      existing.terminate();
    }

    agents.set(deviceId, ws);
    attachHeartbeat(ws);
    logger.info ? logger.info(`Agent connected: ${deviceId}`) : logger.log(`Agent connected: ${deviceId}`);
    ws.on('close', () => {
      agents.delete(deviceId);
      const activeSession = activeSessionByDevice.get(deviceId);
      if (activeSession) {
        activeSessionByDevice.delete(deviceId);
        const viewer = viewers.get(activeSession);
        if (viewer) {
          viewer.send(JSON.stringify({ type: 'status', state: 'agent_disconnected' }));
        }
      }
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        forwardAudio(deviceId, data);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch (err) {
        return;
      }

      const sessionId = activeSessionByDevice.get(deviceId);
      if (sessionId && viewers.has(sessionId)) {
        viewers.get(sessionId).send(JSON.stringify(msg));
      }
    });
  }

  function onViewerConnected(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');
    const token = url.searchParams.get('token');

    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session || session.token !== token || session.expiresAt < Date.now()) {
      ws.close(1008, 'invalid session');
      return;
    }

    const deviceId = session.deviceId;
    viewers.set(sessionId, ws);
    attachHeartbeat(ws);

    ws.on('close', () => {
      viewers.delete(sessionId);
      const activeSession = activeSessionByDevice.get(deviceId);
      if (activeSession === sessionId) {
        activeSessionByDevice.delete(deviceId);
        sendToAgent(deviceId, { action: 'stop' });
      }
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch (err) {
        return;
      }

      if (msg.action === 'start') {
        const current = activeSessionByDevice.get(deviceId);
        if (current && current !== sessionId) {
          if (maxListenersPerDevice <= 1) {
            ws.send(JSON.stringify({ type: 'error', reason: 'another listener is active' }));
            return;
          }
        }

        activeSessionByDevice.set(deviceId, sessionId);
        const sent = sendToAgent(deviceId, { action: 'start', sessionId, mode: msg.mode || 'wss' });
        if (!sent) {
          ws.send(JSON.stringify({ type: 'error', reason: 'agent not connected' }));
        }
      } else if (msg.action === 'stop') {
        activeSessionByDevice.delete(deviceId);
        sendToAgent(deviceId, { action: 'stop' });
      } else if (msg.action === 'status') {
        sendToAgent(deviceId, { action: 'status' });
      }
    });

    ws.send(JSON.stringify({
      type: 'viewer_connected',
      deviceId,
      sessionId,
      agent: agents.has(deviceId) ? 'online' : 'offline'
    }));
  }

  function sendToAgent(deviceId, payload) {
    const ws = agents.get(deviceId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    ws.send(JSON.stringify(payload));
    return true;
  }

  function forwardAudio(deviceId, data) {
    if (!data || data.length < 1 || data[0] !== 0x1) {
      return;
    }

    const sessionId = activeSessionByDevice.get(deviceId);
    if (!sessionId) {
      return;
    }
    const viewer = viewers.get(sessionId);
    if (!viewer || viewer.readyState !== WebSocket.OPEN) {
      return;
    }
    viewer.send(data, { binary: true });
  }

  return {
    agents,
    sessions,
    viewers,
    activeSessionByDevice
  };
}

if (require.main === module) {
  const app = express();
  const server = http.createServer(app);
  createMeshAudioPlugin({ app, httpServer: server, allowUnauthenticated: true });
  const port = process.env.PORT || 4050;
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`MeshAudio dev server listening on http://localhost:${port}`);
  });
}

module.exports = createMeshAudioPlugin;
module.exports.createMeshAudioPlugin = createMeshAudioPlugin;
module.exports.plugin = function meshAudioMeshCentralPlugin(parent, options = {}) {
  const plugin = {};
  const app = parent?.app || parent?.expressApp || parent?.parent?.app || (parent?.parent && parent.parent.expressApp);
  const httpServer =
    parent?.parent?.server ||
    parent?.parent?.httpserver ||
    parent?.parent?.httpServer ||
    parent?.parent?.server2 ||
    (parent?.parent && parent.parent.server && parent.parent.server.http);

  if (!app || !httpServer) {
    throw new Error('MeshCentral plugin: unable to resolve app/httpServer');
  }

  const meshaudio = createMeshAudioPlugin({
    app,
    httpServer,
    agentSecret: options.agentSecret || process.env.MESHAUDIO_AGENT_SECRET,
    tokenTtlMs: options.tokenTtlMs || Number(process.env.MESHAUDIO_TOKEN_TTL_MS || 5 * 60 * 1000),
    allowUnauthenticated: options.allowUnauthenticated ?? false,
    staticDir: options.staticDir,
    logger: parent?.parent?.debug || console
  });

  plugin.server_startup = () => {
    const log = parent?.parent?.debug || console;
    log.info ? log.info('MeshAudio plugin initialized') : log.log('MeshAudio plugin initialized');
  };

  plugin.meshaudio = meshaudio;
  return plugin;
};
