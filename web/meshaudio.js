(() => {
  const DEFAULT_ENDPOINT = '/meshaudio';

  function buildOpusHead(sampleRate, channels) {
    const buffer = new ArrayBuffer(19);
    const view = new DataView(buffer);
    const magic = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"
    magic.forEach((b, idx) => view.setUint8(idx, b));
    view.setUint8(8, 1); // version
    view.setUint8(9, channels);
    view.setUint16(10, 312, true); // pre-skip
    view.setUint32(12, sampleRate, true);
    view.setUint16(16, 0, true); // output gain
    view.setUint8(18, 0); // channel mapping family (RTP)
    return buffer;
  }

  class MeshAudioPlayer {
    constructor({ volume = 1.0 } = {}) {
      this.volume = volume;
      this.ctx = null;
      this.gain = null;
      this.decoder = null;
      this.playHead = 0;
      this.baseTimestampUs = null;
      this.playStart = 0;
      this.jitterSec = 0.08; // 80ms buffer
    }

    async init() {
      if (!('AudioContext' in window)) {
        throw new Error('Web Audio not supported');
      }

      this.ctx = new AudioContext({ sampleRate: 48000 });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);

      if (!('AudioDecoder' in window)) {
        throw new Error('WebCodecs AudioDecoder not supported in this browser');
      }

      this.decoder = new AudioDecoder({
        output: (audioData) => this.handleDecoded(audioData),
        error: (err) => console.error('Decoder error', err)
      });

      const opusHead = buildOpusHead(48000, 2);

      this.decoder.configure({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
        description: opusHead
      });
    }

    async resume() {
      if (this.ctx && this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
    }

    setVolume(value) {
      this.volume = value;
      if (this.gain) {
        this.gain.gain.value = value;
      }
    }

    enqueue(opusPayload, timestampMs) {
      if (!this.decoder) {
        return;
      }
      // EncodedAudioChunk expects microseconds
      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp: BigInt(timestampMs) * 1000n,
        data: opusPayload
      });
      this.decoder.decode(chunk);
    }

    handleDecoded(audioData) {
      if (!this.ctx || !this.gain) {
        audioData.close();
        return;
      }

      // timestamp from AudioData is in microseconds
      const timestampUs = Number(audioData.timestamp || 0);
      if (this.baseTimestampUs === null) {
        this.baseTimestampUs = timestampUs;
        this.playStart = this.ctx.currentTime + this.jitterSec;
        this.playHead = this.playStart;
      }

      const { numberOfChannels, numberOfFrames, sampleRate } = audioData;
      const audioBuffer = this.ctx.createBuffer(numberOfChannels, numberOfFrames, sampleRate);

      for (let ch = 0; ch < numberOfChannels; ch += 1) {
        const channelData = new Float32Array(numberOfFrames);
        audioData.copyTo(channelData, { planeIndex: ch });
        audioBuffer.copyToChannel(channelData, ch, 0);
      }

      const src = this.ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(this.gain);

      const relSeconds = (timestampUs - this.baseTimestampUs) / 1_000_000;
      const targetTime = this.playStart + relSeconds;
      const startAt = Math.max(this.ctx.currentTime, this.playHead, targetTime);
      src.start(startAt);
      this.playHead = startAt + audioBuffer.duration;

      audioData.close();
    }

    reset() {
      if (this.decoder) {
        try {
          this.decoder.flush();
        } catch (_) {
          // ignore
        }
      }
      this.playHead = this.ctx ? this.ctx.currentTime : 0;
      this.baseTimestampUs = null;
      this.playStart = 0;
    }
  }

  class MeshAudioClient {
    constructor({ deviceId, endpoint = DEFAULT_ENDPOINT, volume = 1.0, onStatus, onError }) {
      this.deviceId = deviceId;
      this.endpoint = endpoint;
      this.onStatus = onStatus;
      this.onError = onError;
      this.player = new MeshAudioPlayer({ volume });
      this.ws = null;
      this.session = null;
      this.state = 'idle';
    }

    async init() {
      await this.player.init();
    }

    async start() {
      if (!this.deviceId) {
        throw new Error('deviceId required');
      }
      await this.player.resume();

      const tokenResp = await fetch(`${this.endpoint}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ deviceId: this.deviceId })
      });

      if (!tokenResp.ok) {
        const body = await tokenResp.text();
        const msg = body || `Token request failed: ${tokenResp.status}`;
        this.onError && this.onError(msg);
        throw new Error(msg);
      }

      const tokenPayload = await tokenResp.json();
      this.session = tokenPayload;
      await this.openWebSocket(tokenPayload);
      this.setState('starting');
    }

    async openWebSocket(tokenPayload) {
      const { sessionId, token } = tokenPayload;
      const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsScheme}//${location.host}${this.endpoint.replace(/\\/$/, '')}/view?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.ws?.send(JSON.stringify({ action: 'start', mode: 'wss' }));
      };

      this.ws.onclose = () => {
        this.setState('idle');
        this.onError && this.onError('Disconnected from audio stream');
      };

      this.ws.onerror = (err) => {
        console.error('MeshAudio socket error', err);
        this.setState('error');
        this.onError && this.onError('Socket error');
      };

      this.ws.onmessage = (evt) => {
        if (typeof evt.data === 'string') {
          this.handleText(evt.data);
        } else {
          this.handleBinary(evt.data);
        }
      };
    }

    stop() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ action: 'stop' }));
      }
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.player.reset();
      this.setState('idle');
    }

    setVolume(value) {
      this.player.setVolume(value);
    }

    handleText(text) {
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'status') {
          this.setState(msg.state || 'unknown');
          if (msg.state === 'error' && this.onError) {
            this.onError(msg.reason || 'Agent error');
          }
        } else if (msg.type === 'error' && this.onError) {
          this.onError(msg.reason || 'Stream error');
          this.setState('error');
        }
      } catch (err) {
        console.warn('Bad message', text, err);
      }
    }

    handleBinary(buffer) {
      if (!buffer || buffer.byteLength < 13) {
        return;
      }
      const view = new DataView(buffer);
      const type = view.getUint8(0);
      if (type !== 0x1) {
        return;
      }
      const seq = view.getUint32(1, true); // reserved for future reordering
      let timestampMs;
      if (typeof view.getBigInt64 === 'function') {
        timestampMs = Number(view.getBigInt64(1 + 4, true));
      } else {
        const lo = view.getUint32(1 + 4, true);
        const hi = view.getUint32(1 + 4 + 4, true);
        timestampMs = hi * 4294967296 + lo;
      }
      if (Number.isNaN(timestampMs)) {
        return;
      }
      const payload = buffer.slice(1 + 4 + 8);
      this.player.enqueue(payload, timestampMs);
      if (this.state !== 'streaming') {
        this.setState('streaming');
      }
    }

    setState(state) {
      this.state = state;
      if (typeof this.onStatus === 'function') {
        this.onStatus(state);
      }
    }
  }

  function mountMeshAudioUI({ root, deviceId, endpoint }) {
    if (!root) {
      throw new Error('root element required');
    }

    const container = document.createElement('div');
    container.className = 'meshaudio';
    container.innerHTML = `
      <div class="meshaudio__header">
        <span class="meshaudio__status meshaudio__status--idle" id="meshaudio-status"></span>
        <span class="meshaudio__title">Audio</span>
      </div>
      <div class="meshaudio__controls">
        <button class="meshaudio__toggle" id="meshaudio-toggle">Start Audio</button>
        <label class="meshaudio__volume">
          <span>Volume</span>
          <input type="range" min="0" max="1" step="0.01" value="1" id="meshaudio-volume" />
        </label>
      </div>
      <div class="meshaudio__note" id="meshaudio-note"></div>
    `;

    root.appendChild(container);

    const statusEl = container.querySelector('#meshaudio-status');
    const toggleBtn = container.querySelector('#meshaudio-toggle');
    const volumeSlider = container.querySelector('#meshaudio-volume');
    const noteEl = container.querySelector('#meshaudio-note');

    const client = new MeshAudioClient({
      deviceId,
      endpoint,
      onStatus: (state) => updateStatus(state),
      onError: (message) => {
        noteEl.textContent = message || 'Audio error';
      }
    });

    client.init().catch((err) => {
      noteEl.textContent = `Audio init failed: ${err.message}`;
      toggleBtn.disabled = true;
    });

    toggleBtn.addEventListener('click', async () => {
      if (client.state === 'idle' || client.state === 'error') {
        toggleBtn.disabled = true;
        noteEl.textContent = 'Connecting...';
        try {
          await client.start();
        } catch (err) {
          noteEl.textContent = `Start failed: ${err.message}`;
          toggleBtn.disabled = false;
        }
      } else {
        client.stop();
      }
    });

    volumeSlider.addEventListener('input', (e) => {
      const value = Number(e.target.value);
      client.setVolume(value);
    });

    function updateStatus(state) {
      statusEl.className = `meshaudio__status meshaudio__status--${state}`;
      if (state === 'streaming') {
        toggleBtn.textContent = 'Stop Audio';
        toggleBtn.disabled = false;
        noteEl.textContent = 'Streaming system audio';
      } else if (state === 'starting') {
        toggleBtn.textContent = 'Starting...';
        toggleBtn.disabled = true;
        noteEl.textContent = 'Starting stream';
      } else if (state === 'agent_disconnected') {
        toggleBtn.textContent = 'Start Audio';
        toggleBtn.disabled = false;
        noteEl.textContent = 'Agent disconnected';
      } else if (state === 'error') {
        toggleBtn.textContent = 'Start Audio';
        toggleBtn.disabled = false;
        noteEl.textContent = 'Error starting audio';
      } else {
        toggleBtn.textContent = 'Start Audio';
        toggleBtn.disabled = false;
        noteEl.textContent = '';
      }
    }

    return client;
  }

  window.MeshAudio = {
    mount: mountMeshAudioUI,
    Client: MeshAudioClient
  };
})();
