# P2P File Transfer

A high-performance peer-to-peer (P2P) file transfer web application. The core data processing logic is written in Rust and compiled into WebAssembly (WASM), ensuring memory safety and maximum speed directly within the browser.

## 🌐 Live Demo

The application is fully deployed and ready to use on GitHub Pages:
👉 **[Launch P2P File Transfer](https://rootwin-project.github.io/P2P-File-Transfer/)**

## 🚀 Features

- **Absolute Privacy:** Files are transferred directly from peer to peer via WebRTC. Your data is never uploaded to or stored on any intermediate servers.
- **Blazing Fast:** Thanks to Rust and WebAssembly, file chunking and integrity validation are executed at near-native speeds.
- **Zero Installation:** Works fully inside any modern web browser without requiring any plugins or desktop applications.
- **Responsive Design:** Clean, modern, and user-friendly UI for seamless file sharing.

## 🛠 Tech Stack

- **Rust** — Core system logic, file chunking, and memory management.
- **WebAssembly (WASM)** — High-performance execution sandbox within the browser.
- **wasm-pack** — Build tool and JavaScript/Rust binding generator.
- **HTML5 / CSS3 / JavaScript** — Frontend user interface and WebRTC API integration.

## 📄 License

This project is licensed under the **Apache License 2.0**. See the [LICENSE](LICENSE) file for details.
