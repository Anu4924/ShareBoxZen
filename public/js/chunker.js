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
      if (file.size > 500 * 1024 * 1024) {
        // Fast instant fingerprint for multi-GB files (prevents browser UI lag)
        const prefixSample = await file.slice(0, 2 * 1024 * 1024).arrayBuffer();
        const suffixSample = await file.slice(Math.max(0, file.size - 2 * 1024 * 1024)).arrayBuffer();
        const combined = new Uint8Array(prefixSample.byteLength + suffixSample.byteLength);
        combined.set(new Uint8Array(prefixSample), 0);
        combined.set(new Uint8Array(suffixSample), prefixSample.byteLength);
        const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return 'zen5g_' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      }
      const sampleSize = Math.min(10 * 1024 * 1024, file.size);
      const prefixSlice = await file.slice(0, sampleSize).arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', prefixSlice);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.error('Hash calculation error:', e);
      return 'hash_uncalculated';
    }
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

    const payload = {
      fileName: file.name,
      fileSize: file.size,
      chunkSize: this.chunkSize,
      totalChunks: this.totalChunks,
      fileHash,
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
    const chunkBlob = this.file.slice(start, end);

    const res = await fetch(`/api/transfer/${this.transferId}/chunk/${index}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Chunk-Index': index.toString()
      },
      body: chunkBlob
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
          shareToken: this.shareToken
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
