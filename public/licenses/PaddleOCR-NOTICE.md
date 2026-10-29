# PaddleOCR-VL attribution

TexImageScan packages the Apache-2.0 PaddleOCR-VL WebGPU engine developed by
SotaOCR. Copyright 2026 SotaOCR. The original notice is preserved in
[PaddleOCR-upstream-NOTICE](PaddleOCR-upstream-NOTICE), the original third-party
notice in [PaddleOCR-upstream-THIRD_PARTY_NOTICES.md](PaddleOCR-upstream-THIRD_PARTY_NOTICES.md),
and the full license in [PaddleOCR-LICENSE](PaddleOCR-LICENSE).

- Runtime source: [glebkudr/paddleocr-vl-webgpu at f7d2f8aa40639497e1dbd95f2f8793e664b90758](https://github.com/glebkudr/paddleocr-vl-webgpu/tree/f7d2f8aa40639497e1dbd95f2f8793e664b90758).
- Deployment artifacts: [glebkudr/PaddleOCR-VL-1.6-WebGPU at 5219606297d00bbd23b2ec193271af0c0b427dfc](https://huggingface.co/glebkudr/PaddleOCR-VL-1.6-WebGPU/tree/5219606297d00bbd23b2ec193271af0c0b427dfc), Apache-2.0.
- Original model: [PaddlePaddle/PaddleOCR-VL-1.6 at 66317acc4c9fc17bd154591ce650735cd2855f3e](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6/tree/66317acc4c9fc17bd154591ce650735cd2855f3e), Apache-2.0.

TexImageScan modifies the browser JavaScript integration to read model bytes from
the verified application cache, initialize packaged WASM locally, and report
generation progress and termination metadata. The generated JavaScript bindings
also report loss of the runtime's GPU device and omit the ignored Windows power
preference. The bundled WASM is copied unchanged from the pinned runtime.

[PaddleOCR-Rust-NOTICES.md](PaddleOCR-Rust-NOTICES.md) contains license texts for
the pinned runtime's Rust dependency closure. The report includes platform and
build dependencies conservatively. `scripts/paddle-licenses.py` verifies crate
archive checksums against the pinned Cargo.lock and records exact source commits
for license texts omitted from published crate archives. Development-only Vite
is not included in the shipped browser runtime.
