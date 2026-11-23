# Third-party notices

anycut's own source code is MIT-licensed (see [LICENSE](LICENSE)). The installers also include, or download on first use, the following third-party software, each under its own license.

| Component | Used for | License |
| --- | --- | --- |
| [FFmpeg](https://ffmpeg.org) | Decoding, export, proxies, thumbnails | GPL. FFmpeg runs as a separate program. macOS builds ship the static GPLv3 build by [Martin Riedl](https://ffmpeg.martin-riedl.de) (build scripts: [gitlab.com/martinr92/ffmpeg](https://gitlab.com/martinr92/ffmpeg)); Windows and Linux ship the builds bundled by [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static); ffprobe comes from [ffprobe-static](https://github.com/joshwnj/ffprobe-static). FFmpeg's source is available at [ffmpeg.org/download.html](https://ffmpeg.org/download.html). Release builds check that the bundled ffmpeg has no nonfree parts (`scripts/fetchFfmpeg.mjs`). |
| [Electron](https://www.electronjs.org) (includes Chromium and Node.js) | Application runtime | MIT (Chromium and Node.js carry their own notices, shipped as `LICENSES.chromium.html` inside the app) |
| [React](https://react.dev), [zustand](https://github.com/pmndrs/zustand) | User interface | MIT |
| [ONNX Runtime](https://onnxruntime.ai) | Background removal and captions (Windows/Linux, and captions on all platforms) | MIT |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Automatic captions | Apache-2.0 |
| [sharp](https://sharp.pixelplumbing.com) / libvips | Image handling for Transformers.js | Apache-2.0 / LGPL-3.0 |
| [Whisper](https://github.com/openai/whisper) model (`onnx-community/whisper-base_timestamped`), downloaded on first use | Automatic captions | MIT |
| [MODNet](https://github.com/ZHKKKe/MODNet) model, downloaded on first use (Windows/Linux) | Background removal (People) | Apache-2.0 |
| [IS-Net](https://github.com/xuebinqin/DIS) model via [rembg](https://github.com/danielgatis/rembg), downloaded on first use (Windows/Linux) | Background removal (Any subject) | Apache-2.0 |
| Fonts: Montserrat, Archivo, Rubik, Fredoka, Anton, TikTok Sans | Text and captions | SIL Open Font License 1.1 (license files in `src/renderer/assets/fonts/`) |
| Font: Luckiest Guy | Text and captions | Apache-2.0 (license file in `src/renderer/assets/fonts/`) |

On macOS, background removal uses Apple's built-in Vision framework, which is part of the operating system and not redistributed by anycut.

anycut is an independent project and is not affiliated with CapCut or ByteDance.
