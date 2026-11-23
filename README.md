# ShareBoxZen ☯️

> **High-speed Nearby P2P and Resilient Multi-GB Remote File Sharing Platform.**
> Seamlessly transfer files remotely or completely offline across Laptops and Mobile devices.

---

## 🌟 Key Highlights & Capabilities

### 1. 🚀 Resilient Multi-GB Large File Transfer (Remote Engine)
* **Multi-GB Support:** Stream files of any size (e.g. 8GB+ 4K videos, disk images) using memory-efficient streaming without browser crashes.
* **Chunked Uploads:** Divides files into configurable chunks (2MB, 5MB, 10MB, 20MB).
* **Network Interruption Tolerance & Auto-Resume:**
  * If the network or internet unexpectedly drops during an 8GB transfer, the transfer **automatically pauses**.
  * When the connection is re-established, ShareBoxZen queries the server chunk status (`/api/transfer/:id/status`) and **resumes only the remaining chunks** without re-uploading completed chunks!
  * Includes an interactive **"Simulate Internet Disconnect"** button to demonstrate this instant pause-and-resume behavior.
* **Parallel Chunk Streaming:** Concurrent chunk upload workers for maximum network saturation.
* **Speed Monitor & Live ETA:** Real-time transfer speed calculation (MB/s) and dynamic time remaining.
* **SHA-256 Integrity Verification:** End-to-end cryptographic checksum verification on file assembly.
* **Resumable Downloads:** Full support for `HTTP 206 Partial Content` with `Range: bytes=start-end` headers.

---

### 2. ⚡ Nearby File Sharing (Zero-Internet Local P2P Engine)
* **Zero Internet Consumption:** Transfers files directly between devices on the same Wi-Fi router or Mobile Hotspot with 0 bytes of mobile data or internet bandwidth used!
* **Device Discovery:** Auto-discovers nearby phones and laptops connected to the local subnet.
* **QR Code One-Touch Pairing:**
  * Laptop displays pairing QR code with local IP address.
  * Mobile scans QR with camera to connect instantly.
* **Cross-Device Matrix:**
  * 💻 Laptop to 📱 Mobile
  * 📱 Mobile to 💻 Laptop
  * 📱 Mobile to 📱 Mobile
  * 💻 Laptop to 💻 Laptop
* **High-Speed WebRTC DataChannel:** Direct binary streaming reaching full hardware Wi-Fi speeds (50 to 100+ MB/s).

---

### 3. 🔒 Remote Sharing, Identity & Access Control
* **Unique ZenIDs:** Each user receives a unique identification badge (e.g., `ZEN-1001-ALPHA`).
* **User Search:** Search registered recipients by username, email, or ZenID with autocomplete.
* **Public & Private Modes:** Restrict downloads to specific users or create open share links.
* **Password Protection:** Optional SHA-256 password lock on sensitive transfers.
* **Instant QR Code for Downloads:** Generates scan-to-download QR codes for any upload.

---

## 🛠️ Quick Start Guide

### 1. Prerequisites
- **Node.js** (v18.0.0 or higher)
- Any modern web browser (Chrome, Edge, Safari, Firefox)

### 2. Install & Start Server
```bash
# Navigate to project folder
cd ShareBoxZen

# Install dependencies (if not already done)
npm install

# Start the ShareBoxZen server
npm start
```

### 3. Open the App
When the server starts, it prints connectivity addresses in the terminal:
```
======================================================
       ShareBoxZen Server is Active & Listening!       
======================================================
• Localhost:       http://localhost:3000
• Network (Wi-Fi): http://192.168.1.15:3000

📱 Scan from phone on same Wi-Fi/Hotspot to connect instantly!
======================================================
```

- **On your Laptop:** Open `http://localhost:3000`
- **On your Mobile Phone:** Connect to the same Wi-Fi (or phone hotspot) and open `http://<your-laptop-ip>:3000` or scan the QR code displayed on the screen!

---

## 🧪 Testing the Core Features

### Scenario A: Testing 8GB Network Drop & Auto-Resume
1. Open `http://localhost:3000` and go to the **Remote & Large Files** tab.
2. Select any file (or a large video/archive).
3. Click **Start Resilient Upload**.
4. Observe the live chunk grid and speed monitor uploading chunks.
5. Click **⚡ Simulate Internet Disconnect** (or disconnect your Wi-Fi):
   * Notice that the state changes to `PAUSED`. Completed chunks remain saved on disk.
6. Click **🔌 Reconnect Internet (Resume)** (or reconnect Wi-Fi):
   * The client immediately queries `/api/transfer/:id/status`, detects which chunks were already confirmed on disk, and resumes uploading the remaining chunks seamlessly!
7. Once finished, SHA-256 integrity verification completes and provides a share link and QR code.

### Scenario B: Testing Zero-Internet Nearby P2P Transfer
1. Open `http://localhost:3000` on your Laptop.
2. Open `http://<local-ip>:3000` on your Phone (or in a second browser window).
3. Switch to the **⚡ Nearby Share (Zero Internet)** tab on both devices.
4. You will see the other device appear under **Discovered Nearby Devices**.
5. Click **Pair & Share** on either device.
6. Accept pairing: a direct **WebRTC DataChannel** opens immediately.
7. Select a file and click **Send Over Local P2P**.
8. The file streams directly peer-to-peer at full local Wi-Fi speeds without touching the internet!

---

## 📂 Project Structure

```
ShareBoxZen/
├── package.json          # Project metadata & dependencies (express, ws, qrcode, cors)
├── server.js             # Express + WebSocket server (Signaling, Chunk APIs, Auth, IP discovery)
├── storage/              # Disk storage
│   ├── chunks/           # Temporary spool for in-progress chunk uploads
│   └── completed/        # Assembled files verified with SHA-256
├── data/
│   └── db.json           # User database, ZenIDs, and active transfer sessions
├── public/               # Client-side Web Application (PWA ready)
│   ├── index.html        # Main Zen interface
│   ├── css/
│   │   └── style.css     # Responsive Zen Dark aesthetic & chunk visualizer styling
│   └── js/
│       ├── app.js        # UI controller & event orchestration
│       ├── chunker.js    # Resilient multi-GB chunking, worker pool & resume engine
│       └── nearby.js     # ZenLocal WebRTC DataChannel engine & local discovery
└── README.md
```

---

## 📜 License
MIT License. Free for open-source and personal use.
