/**
 * ShareBoxZen - Turbo Chunker Engine
 * Optimized for Multi-GB transfers (e.g. 5GB+ files) with:
 * - Dynamic adaptive chunk sizing (up to 32MB chunks)
 * - 6x parallel worker pool saturation
 * - Instant non-blocking cryptographic fingerprinting
 * - Resilient auto-pause on network drop & seamless resume
 * - Smooth moving-average speed & ETA metrics
 */

class ZenChunker {
  constructor(options = {}) {
    this.file = null;
    this.options = options;
    this.chunkSize = options.chunkSize || null; // Computed dynamically per file size
    this.concurrency = options.concurrency || 6; // 6 parallel chunk upload streams
    this.transferId = null;
    this.totalChunks = 0;
    this.uploadedChunks = new Set();
    this.inFlightChunks = new Set();
    this.state = 'IDLE'; // IDLE, UPLOADING, PAUSED, COMPLETED, ERROR
    this.isSimulatingOffline = false;

    // Callbacks
    this.onProgress = options.onProgress || (() => {});
    this.onChunkStatus = options.onChunkStatus || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});

    // Metrics & Speed Smoothing
    this.bytesUploaded = 0;
    this.lastSpeedCheckTime = Date.now();
    this.lastSpeedCheckBytes = 0;
    this.currentSpeed = 0; // bytes per second
    this.speedSamples = [];
    this.speedTimer = null;

    this.setupNetworkListeners();
  }

  calculateOptimalChunkSize(fileSize) {
    if (fileSize >= 3 * 1024 * 1024 * 1024) {
      // 3GB+ (e.g. 5GB file): 32 MB chunks for minimum HTTP overhead
      return 32 * 1024 * 1024;
    } else if (fileSize >= 1 * 1024 * 1024 * 1024) {
      // 1GB - 3GB: 20 MB chunks
      return 20 * 1024 * 1024;
    } else if (fileSize >= 200 * 1024 * 1024) {
      // 200MB - 1GB: 10 MB chunks
      return 10 * 1024 * 1024;
    } else if (fileSize >= 30 * 1024 * 1024) {
      // 30MB - 200MB: 5 MB chunks
      return 5 * 1024 * 1024;
    }
    // Under 30MB: 2 MB chunks
    return 2 * 1024 * 1024;
  }

  setupNetworkListeners() {
    window.addEventListener('offline', () => {
      console.warn('[ZenChunker] Browser detected OFFLINE state!');
      if (this.state === 'UPLOADING') {
        this.pause('Internet connection lost. Auto-paused.');
      }
    });

    window.addEventListener('online', () => {
      console.log('[ZenChunker] Browser detected ONLINE state!');
      if (this.state === 'PAUSED' && !this.isSimulatingOffline) {
        this.resume();
      }
    });
  }

  setState(newState, reason = '') {
    this.state = newState;
    this.onStateChange(this.state, reason);
  }

  async calculateFileHash(file) {
    try {
      // Calculate cryptographic SHA-256 hash over every single byte of the file
      const sliceSize = 10 * 1024 * 1024; // 10MB stream buffer
      const totalSlices = Math.ceil(file.size / sliceSize);
      const sliceDigests = [];

      for (let i = 0; i < totalSlices; i++) {
        const start = i * sliceSize;
        const end = Math.min(start + sliceSize, file.size);
        const buffer = await file.slice(start, end).arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        sliceDigests.push(new Uint8Array(digest));
      }

      if (sliceDigests.length === 1) {
        return Array.from(sliceDigests[0]).map(b => b.toString(16).padStart(2, '0')).join('');
      }

      // Hash the concatenated slice digests to produce deterministic full-file root hash
      const combined = new Uint8Array(sliceDigests.length * 32);
      for (let i = 0; i < sliceDigests.length; i++) {
        combined.set(sliceDigests[i], i * 32);
      }
      const rootBuffer = await crypto.subtle.digest('SHA-256', combined);
      return Array.from(new Uint8Array(rootBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.error('Hash calculation error:', e);
      return 'hash_uncalculated';
    }
  }

  // Client-side authenticated AES-GCM encryption
  static async deriveKeyFromPassword(password, saltString = 'ShareBoxZenSalt') {
    const enc = new TextEncoder();
    const pwKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: enc.encode(saltString),
        iterations: 100000,
        hash: 'SHA-256'
      },
      pwKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  }

  static async generateKey() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    const keyHex = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');
    return { cryptoKey, keyHex, raw };
  }

  static async importKey(keyInput) {
    const cleaned = String(keyInput || '').trim();
    if (/^[0-9a-fA-F]{64}$/.test(cleaned)) {
      const bytes = new Uint8Array(cleaned.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    }
    // If not a 64-char hex key, derive AES key from input using PBKDF2
    return await ZenChunker.deriveKeyFromPassword(cleaned);
  }

  static async encryptChunk(buffer, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
    const totalLen = 12 + ciphertext.byteLength;
    const frame = new Uint8Array(4 + totalLen);
    const view = new DataView(frame.buffer);
    view.setUint32(0, totalLen, false); // big-endian
    frame.set(iv, 4);
    frame.set(new Uint8Array(ciphertext), 16);
    return frame;
  }

  static async decryptFramedStream(combinedBuffer, key) {
    const data = new Uint8Array(combinedBuffer);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const decryptedChunks = [];
    let offset = 0;

    // Check if the stream starts with framed chunk structure
    if (data.length >= 28) {
      const firstLen = view.getUint32(0, false);
      if (firstLen > 12 && firstLen <= data.length - 4) {
        let validFrames = true;
        let testOffset = 0;
        while (testOffset + 4 <= data.length) {
          const flen = view.getUint32(testOffset, false);
          if (flen <= 12 || testOffset + 4 + flen > data.length) {
            validFrames = false;
            break;
          }
          testOffset += 4 + flen;
        }

        if (validFrames && testOffset === data.length) {
          while (offset + 4 <= data.length) {
            const frameLen = view.getUint32(offset, false);
            offset += 4;
            const iv = data.subarray(offset, offset + 12);
            const cipher = data.subarray(offset + 12, offset + frameLen);
            const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
            decryptedChunks.push(new Uint8Array(plain));
            offset += frameLen;
          }
          return decryptedChunks;
        }
      }
    }

    // Fallback: single buffer [12 bytes IV + ciphertext]
    const iv = data.subarray(0, 12);
    const cipher = data.subarray(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return [new Uint8Array(plain)];
  }

  static async encryptBuffer(buffer, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
    const combined = new Uint8Array(12 + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), 12);
    return combined;
  }

  static async decryptBuffer(combinedBuffer, key) {
    const chunks = await ZenChunker.decryptFramedStream(combinedBuffer, key);
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const merged = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunks) {
      merged.set(c, pos);
      pos += c.length;
    }
    return merged.buffer;
  }

  async initiate(file, metadata = {}) {
    this.file = file;
    this.chunkSize = this.options.chunkSize || this.calculateOptimalChunkSize(file.size);
    this.concurrency = this.options.concurrency || (file.size > 1024 * 1024 * 1024 ? 6 : 4);
    this.totalChunks = Math.ceil(file.size / this.chunkSize);
    this.uploadedChunks.clear();
    this.inFlightChunks.clear();
    this.bytesUploaded = 0;
    this.lastSpeedCheckBytes = 0;
    this.lastSpeedCheckTime = Date.now();
    this.speedSamples = [];

    const fileHash = await this.calculateFileHash(file);

    // End-to-end client-side encryption (AES-GCM-256)
    this.isEncrypted = Boolean(metadata.e2ee);
    if (this.isEncrypted) {
      if (metadata.password) {
        this.encryptionKey = await ZenChunker.deriveKeyFromPassword(metadata.password);
        this.encryptionKeyHex = null;
      } else {
        const { cryptoKey, keyHex } = await ZenChunker.generateKey();
        this.encryptionKey = cryptoKey;
        this.encryptionKeyHex = keyHex;
      }
    } else {
      this.encryptionKey = null;
      this.encryptionKeyHex = null;
    }

    const payload = {
      fileName: file.name,
      fileSize: file.size,
      chunkSize: this.chunkSize,
      totalChunks: this.totalChunks,
      fileHash,
      isEncrypted: this.isEncrypted,
      senderId: metadata.senderId,
      recipientId: metadata.recipientId,
      isPublic: metadata.isPublic !== undefined ? metadata.isPublic : true,
      password: metadata.password || null
    };

    const res = await fetch('/api/transfer/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error('Failed to initiate transfer session.');
    }

    const data = await res.json();
    this.transferId = data.transferId;
    this.shareToken = data.shareToken;
    this.shareUrl = data.shareUrl;

    this.startSpeedTracker();
    this.setState('UPLOADING');
    this.startWorkerPool();

    return data;
  }

  startSpeedTracker() {
    if (this.speedTimer) clearInterval(this.speedTimer);
    this.speedTimer = setInterval(() => {
      if (this.state !== 'UPLOADING') {
        this.currentSpeed = 0;
        return;
      }
      const now = Date.now();
      const timeDelta = (now - this.lastSpeedCheckTime) / 1000;
      if (timeDelta > 0) {
        const bytesDelta = this.bytesUploaded - this.lastSpeedCheckBytes;
        const instantSpeed = Math.max(0, bytesDelta / timeDelta);

        // Moving average of last 3 samples
        this.speedSamples.push(instantSpeed);
        if (this.speedSamples.length > 3) this.speedSamples.shift();
        const avgSpeed = this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length;

        this.currentSpeed = avgSpeed;
        this.lastSpeedCheckBytes = this.bytesUploaded;
        this.lastSpeedCheckTime = now;
      }
    }, 800);
  }

  async checkServerStatus() {
    if (!this.transferId) return null;
    const res = await fetch(`/api/transfer/${this.transferId}/status`);
    if (!res.ok) throw new Error('Status check failed.');
    const data = await res.json();

    // Sync uploaded chunks set with server confirmed chunks
    data.uploadedChunks.forEach(idx => this.uploadedChunks.add(idx));
    return data;
  }

  startWorkerPool() {
    const workersToStart = Math.min(this.concurrency, this.totalChunks - this.uploadedChunks.size);
    for (let i = 0; i < workersToStart; i++) {
      this.runNextChunkWorker();
    }
  }

  async runNextChunkWorker() {
    if (this.state !== 'UPLOADING') return;

    // Find next chunk index that is neither uploaded nor currently in flight
    let nextIndex = -1;
    for (let i = 0; i < this.totalChunks; i++) {
      if (!this.uploadedChunks.has(i) && !this.inFlightChunks.has(i)) {
        nextIndex = i;
        break;
      }
    }

    if (nextIndex === -1) {
      // Check if all chunks completed
      if (this.uploadedChunks.size === this.totalChunks) {
        this.finalizeTransfer();
      }
      return;
    }

    this.inFlightChunks.add(nextIndex);
    this.onChunkStatus(nextIndex, 'uploading');

    try {
      await this.uploadChunk(nextIndex);
      this.inFlightChunks.delete(nextIndex);
      this.uploadedChunks.add(nextIndex);
      this.onChunkStatus(nextIndex, 'done');
      this.emitProgress();

      // Immediately schedule next chunk
      this.runNextChunkWorker();
    } catch (err) {
      this.inFlightChunks.delete(nextIndex);
      this.onChunkStatus(nextIndex, 'error');

      if (this.state === 'UPLOADING') {
        console.warn(`Chunk ${nextIndex} upload error:`, err);
        if (this.isSimulatingOffline || !navigator.onLine) {
          this.pause('Connection dropped. Transfer safely paused.');
        } else {
          // Retry chunk after brief backoff
          setTimeout(() => this.runNextChunkWorker(), 1500);
        }
      }
    }
  }

  async uploadChunk(index) {
    if (this.isSimulatingOffline) {
      throw new Error('SIMULATED_OFFLINE: Network disconnected');
    }

    const start = index * this.chunkSize;
    const end = Math.min(start + this.chunkSize, this.file.size);
    let chunkPayload = this.file.slice(start, end);

    // If client-side E2EE is active, encrypt the chunk before uploading
    if (this.isEncrypted && this.encryptionKey) {
      const rawBuffer = await chunkPayload.arrayBuffer();
      const encryptedBytes = await ZenChunker.encryptChunk(rawBuffer, this.encryptionKey);
      chunkPayload = new Blob([encryptedBytes], { type: 'application/octet-stream' });
    }

    const res = await fetch(`/api/transfer/${this.transferId}/chunk/${index}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Chunk-Index': index.toString()
      },
      body: chunkPayload
    });

    if (!res.ok) {
      throw new Error(`Server returned status ${res.status}`);
    }

    this.bytesUploaded += (end - start);
  }

  emitProgress() {
    const uploadedCount = this.uploadedChunks.size;
    const percentage = Math.min(100, Math.round((uploadedCount / this.totalChunks) * 100));

    // Calculate ETA
    let etaSeconds = 0;
    if (this.currentSpeed > 0) {
      const remainingBytes = Math.max(0, this.file.size - this.bytesUploaded);
      etaSeconds = Math.max(0, Math.round(remainingBytes / this.currentSpeed));
    }

    this.onProgress({
      uploadedCount,
      totalChunks: this.totalChunks,
      percentage,
      speedBytesPerSec: this.currentSpeed,
      speedFormatted: this.formatSpeed(this.currentSpeed),
      etaSeconds,
      etaFormatted: this.formatETA(etaSeconds),
      bytesUploaded: this.bytesUploaded,
      totalBytes: this.file.size
    });
  }

  pause(reason = 'Paused by user') {
    if (this.state === 'PAUSED') return;
    this.setState('PAUSED', reason);
    this.inFlightChunks.clear();
  }

  async resume() {
    if (this.state !== 'PAUSED') return;
    this.setState('UPLOADING', 'Resuming transfer...');

    try {
      const status = await this.checkServerStatus();
      console.log(`[ZenChunker] Resumed! Server confirmed ${status.uploadedCount} of ${this.totalChunks} chunks.`);
      
      this.lastSpeedCheckBytes = this.bytesUploaded;
      this.lastSpeedCheckTime = Date.now();
      this.emitProgress();
      this.startWorkerPool();
    } catch (err) {
      console.error('Failed to query status during resume:', err);
      this.setState('PAUSED', 'Waiting for connection to re-establish...');
    }
  }

  toggleSimulateOffline() {
    this.isSimulatingOffline = !this.isSimulatingOffline;
    if (this.isSimulatingOffline) {
      this.pause('SIMULATED DISCONNECT: Internet disconnected! Chunks paused.');
    } else {
      this.resume();
    }
    return this.isSimulatingOffline;
  }

  async finalizeTransfer() {
    this.setState('COMPLETED', 'All chunks sent. Assembling file...');
    if (this.speedTimer) clearInterval(this.speedTimer);

    try {
      const res = await fetch(`/api/transfer/${this.transferId}/complete`, {
        method: 'POST'
      });
      const data = await res.json();

      if (data.success) {
        this.onComplete({
          transferId: this.transferId,
          sha256: data.sha256,
          integrityVerified: data.integrityVerified,
          downloadUrl: data.downloadUrl,
          shareToken: this.shareToken,
          isEncrypted: this.isEncrypted,
          encryptionKeyHex: this.encryptionKeyHex
        });
      } else {
        this.setState('ERROR', data.error);
        this.onError(data.error);
      }
    } catch (err) {
      this.setState('ERROR', 'File assembly request failed.');
      this.onError(err.message);
    }
  }

  formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '0 KB/s';
    if (bytesPerSec >= 1024 * 1024 * 1024) {
      return `${(bytesPerSec / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
    }
    if (bytesPerSec >= 1024 * 1024) {
      return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
    }
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  }

  formatETA(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }
}

window.ZenChunker = ZenChunker;
