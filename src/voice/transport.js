import { WebSocketServer, WebSocket } from 'ws';
import { AppError, objectArgs } from '../errors.js';
import { VoiceSession } from './session.js';

export function attachVoiceSocket({ server, listener, meta, tts, isBusy = () => false }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16_000, perMessageDeflate: false });
  const sessions = new Map();
  const reject = (socket, code) => { socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  server.on('upgrade', (request, socket, head) => {
    const port = server.address()?.port;
    const host = request.headers.host;
    if (request.url !== '/api/voice/session' || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) ||
        request.headers.origin !== `http://${host}` || request.headers['sec-fetch-site'] === 'cross-site') {
      reject(socket, '403 Forbidden'); return;
    }
    if (sessions.size || isBusy()) { reject(socket, '409 Conflict'); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', socket => {
    let started = false;
    let ready = false;
    let receivedAudio = false;
    let queuedBytes = 0;
    let audioEpoch = 0;
    let acceptedSamples = 0;
    let streamStartedAt;
    let chain = Promise.resolve();
    let controlWindow = performance.now();
    let controlCount = 0;
    const connectedAt = performance.now();
    const send = value => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    };
    const session = new VoiceSession({ listener, meta, tts, send,
      sendAudio: audio => {
        if (socket.readyState === WebSocket.OPEN) socket.send(audio, { binary: true });
      },
    });
    sessions.set(socket, session);
    const cleanup = () => { clearInterval(timer); session.close(); sessions.delete(socket); };
    const fail = error => {
      send({ type: 'error', revision: session.revision + 1, fatal: true,
        message: error instanceof AppError ? error.message : 'Local listening stopped. Enable it again to retry.' });
      cleanup(); socket.close(1008, 'Voice session stopped');
    };
    const timer = setInterval(() => {
      session.tick();
      if ((!started && performance.now() - connectedAt > 10_000) ||
          (ready && performance.now() - session.lastFrameAt > (receivedAudio ? 5000 : 60_000))) {
        fail(new AppError('Microphone audio stopped arriving. Enable local wake again.'));
      }
    }, 250);
    timer.unref();
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('message', (data, binary) => {
      if (session.closed) return;
      if (binary) {
        if (!ready || data.length !== 2560) { fail(new AppError('Send 80 ms mono PCM16 frames at 16 kHz after listener readiness.')); return; }
        receivedAudio = true;
        streamStartedAt ??= performance.now();
        acceptedSamples += data.length / 2;
        if (acceptedSamples / 16000 * 1000 > performance.now() - streamStartedAt + 2000) {
          fail(new AppError('Microphone audio must arrive in real time.')); return;
        }
        queuedBytes += data.length;
        if (queuedBytes > 64_000) { fail(new AppError('Local listening fell behind. Enable it again to retry.')); return; }
        const pcm = Buffer.from(data);
        const frameEpoch = audioEpoch;
        chain = chain.then(async () => {
          // A deliberate end-conversation control discards older queued audio.
          // Skipped frames never enter the detector, preserving sample alignment.
          if (!session.closed && frameEpoch === audioEpoch) await session.process(pcm);
        }).catch(fail).finally(() => { queuedBytes -= pcm.length; });
        return;
      }
      try {
        if (performance.now() - controlWindow > 1000) { controlWindow = performance.now(); controlCount = 0; }
        if (++controlCount > 32) throw new AppError('Too many voice controls. Enable local wake again.');
        let message;
        try { message = JSON.parse(data.toString('utf8')); } catch { throw new AppError('Invalid voice control.'); }
        if (!message || typeof message.type !== 'string') throw new AppError('Invalid voice control.');
        if (message.type === 'start') {
          objectArgs(message, ['type', 'delivery', 'speed']);
          if (started) throw new AppError('Voice session was already started.');
          started = true;
          void session.start(message).then(() => { if (!session.closed) ready = true; }).catch(fail);
        } else if (message.type === 'stop') {
          objectArgs(message, ['type']); cleanup(); socket.close(1000, 'Microphone off');
        } else if (message.type === 'sleep') {
          objectArgs(message, ['type']); audioEpoch += 1; session.sleep();
        } else if (message.type === 'configure') {
          objectArgs(message, ['type', 'delivery', 'speed']); session.configure(message);
        } else if (message.type === 'playback') {
          objectArgs(message, ['type', 'playing', 'revision', 'utteranceId']); session.playback(message);
        } else throw new AppError('Unknown voice control.');
      } catch (error) { fail(error); }
    });
  });
  return {
    get active() { return sessions.size > 0; },
    close() {
      for (const [socket, session] of sessions) { session.close(); socket.terminate(); }
      wss.close();
    },
  };
}
