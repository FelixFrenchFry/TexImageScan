<p align="center">
  <img src="assets/logo/scan-cube.svg" width="96" height="96" alt="TexImageScan logo">
</p>

<h1 align="center">TexImageScan</h1>

<p align="center">
  Turns images of equations into editable LaTeX, Markdown, PNG, or SVG.<br>
  Recognition runs on your device. No accounts. No cloud OCR.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license">
  <img src="https://img.shields.io/badge/Chromium-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white" alt="Chromium Manifest V3">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
</p>

## Features

TexImageScan runs in a Chromium browser side panel next to the page you are reading. Capture an equation, matrix, or aligned equations, recognize them locally, then choose the export format you want.

<table>
  <tr>
    <th>1. Capture an equation</th>
    <th>2. Review and copy the result</th>
  </tr>
  <tr>
    <td><img src="assets/screenshots/capture-equation.png" width="600" alt="Rectangle selection around an equation in a PDF, with the TexImageScan side panel open"></td>
    <td><img src="assets/screenshots/recognized-equation.png" width="600" alt="TexImageScan showing the original equation crop, rendered recognition result, and copy and download formats"></td>
  </tr>
</table>

- Capture equations with a rectangle or freehand lasso, or upload a PNG, JPEG, or WebP image.
- Recognize locally with PaddleOCR-VL-1.6 running on your device via WebGPU.
- Review and edit the output source, copy LaTeX, Markdown with math, plain text, or export rendered PNG or SVG images.
- Reopen saved scans and keep editing. Images and edits stay in local history until you delete them.

## Install

Requires Node.js 24 or later and pnpm 12.15.0:

```sh
pnpm install
pnpm build
```

1. Open `chrome://extensions` in your Chromium browser, enable **Developer mode**, choose **Load unpacked**, and select `.output/chrome-mv3`.
2. Click the TexImageScan toolbar icon to open the side panel.
3. Choose **Download model** to obtain [PaddleOCR-VL-1.6 FP16](https://huggingface.co/glebkudr/PaddleOCR-VL-1.6-WebGPU). The first download is about **2.04 GB** from Hugging Face and stays cached for later use.

Use desktop Chrome or a compatible Chromium browser with hardware acceleration and a GPU supporting WebGPU and `shader-f16`. There is no CPU fallback.

Optional **Capture across tabs** access lets you capture on other websites without clicking the toolbar icon each time. Manage it in **Settings**. Local files require **Allow access to file URLs** in Chrome's extension settings.

## Testing

Install the test browser once, then run type checks, unit tests, the build, browser tests, and package checks:

```sh
pnpm exec playwright install chromium
pnpm verify
```

## Privacy

- Images and recognized text stay on your device. They are saved locally and kept until manually deleted in the history tab.
- Model files use a separate cache, which can be deleted in the settings tab. No telemetry, analytics, or remote OCR API.
- Required website access covers model downloads. Capturing across websites is optional and starts only when you ask.

## Limitations

- Recognition can omit symbols or matrix columns, or change indices. Compare the rendered result with the source before copying it. Valid LaTeX can still be wrong.
- Capture the complete equation without surrounding paragraphs. Zoom in before capturing small notation. Enlarging an existing screenshot cannot recover missing detail.
- Handwriting and full-page document recognition are outside the current focus.
- Uploads are limited to 12 MB. Uploaded images and page selections are limited to 8 million pixels.
- If output is cut off, increase the output token limit in the settings tab.

## License

TexImageScan uses the [MIT License](LICENSE). Bundled dependencies keep their own licenses, recorded in the [third-party notices](public/licenses/NOTICE.md) and [attribution sources](public/licenses/SOURCES.md), which also ship with the extension. Model weights are downloaded separately from [Hugging Face](https://huggingface.co/glebkudr/PaddleOCR-VL-1.6-WebGPU) under Apache-2.0. See the [PaddleOCR model and runtime notice](public/licenses/PaddleOCR-NOTICE.md).
