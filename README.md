# P2P File Transfer — Secure Browser-to-Browser File Sharing

<img width="1916" height="941" alt="image" src="https://github.com/user-attachments/assets/abba3cf7-b5a9-4ee9-945b-26a0c3515f51" />
<img width="412" height="923" alt="СКРИН ОТ ГУГЛ БОТА" src="https://github.com/user-attachments/assets/84fc6be1-48ad-447a-b58f-2f6006e0904f" />


> Send files directly between browsers with no server, no upload, no size limit.  
> Built with WebRTC + Rust/WebAssembly + AES-256-GCM encryption.

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://rootwin-project.github.io/P2P-File-Transfer/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![WebRTC](https://img.shields.io/badge/transport-WebRTC-orange)](https://webrtc.org/)
[![WASM](https://img.shields.io/badge/core-Rust%20%2B%20WASM-red)](https://webassembly.org/)


## 🌐 Live Demo

👉 **[Open P2P File Transfer](https://rootwin-project.github.io/P2P-File-Transfer/)**

No installation. Works in any modern browser. Free forever.

---

## What is P2P File Transfer?

P2P File Transfer is an **open-source, browser-based tool** for sending files directly between two devices 
without routing data through any server. It uses **WebRTC Data Channels** for peer-to-peer connectivity 
and encrypts every transfer with **AES-256-GCM** end-to-end encryption.

The file chunking and integrity logic is written in **Rust**, compiled to **WebAssembly**, and runs 
natively inside your browser — no plugins, no installs, no accounts.

---

## 🚀 Features

| Feature | Detail |
|---|---|
| 🔒 End-to-end encrypted | AES-256-GCM via Web Crypto API, PBKDF2 key derivation |
| 🚫 No server storage | Files never touch any server — pure peer-to-peer via WebRTC |
| ⚡ Near-native speed | File processing in Rust + WebAssembly |
| 📦 No size limit | Transfer is only limited by your connection speed |
| 🌐 Zero install | Works in any modern browser (Chrome, Firefox, Edge, Safari) |
| 📱 Responsive | Mobile and desktop friendly |
| 🆓 Free & open source | Apache 2.0 license |

---

## How It Works

1. **Sender** opens the app and selects a file
2. A **WebRTC offer** (SDP) is generated — copy or share it via QR code
3. **Receiver** pastes the offer, generates an **answer** (SDP)
4. Sender accepts the answer → **direct P2P connection** is established
5. File is chunked, **encrypted**, and streamed directly to the receiver
6. Receiver decrypts and reassembles the file locally

> No signaling server is kept running — the SDP exchange is manual (copy/paste or QR), 
> meaning truly zero infrastructure dependency after the page loads.

---

## 🛠 Tech Stack

- **Rust** — File chunking, hashing, memory-safe processing
- **WebAssembly (WASM)** — Rust compiled to run at native speed in browser
- **wasm-pack** — Rust → JS bindings
- **WebRTC DataChannels** — Peer-to-peer transport layer
- **Web Crypto API** — AES-256-GCM encryption, PBKDF2 key derivation
- **HTML5 / CSS3 / Vanilla JS** — Frontend, no frameworks

---

You can use the hosted version: [rootwin-project.github.io/P2P-File-Transfer](https://rootwin-project.github.io/P2P-File-Transfer/)

---

## FAQ

**Q: Is my file uploaded to a server?**  
No. Files travel directly between browsers using WebRTC. No server ever sees your data.

**Q: What's the file size limit?**  
There is no hard limit — the transfer runs until complete. Practical limits depend on your 
browser's memory and connection stability.

**Q: Does it work on mobile?**  
Yes, the UI is responsive and WebRTC is supported on modern mobile browsers.

**Q: Is the connection encrypted?**  
Yes. WebRTC itself uses DTLS-SRTP. Additionally, the app applies AES-256-GCM encryption 
before chunking, so the data is double-encrypted in transit.

**Q: Can I self-host this?**  
Yes. It's a single HTML file + WASM. Deploy to any static host (GitHub Pages, Cloudflare Pages, Netlify).

---

## License

[Apache License 2.0](LICENSE)
