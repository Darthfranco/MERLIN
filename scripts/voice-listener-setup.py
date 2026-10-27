#!/usr/bin/env python3
"""Download checksum-pinned public detection models, never microphone audio."""

import argparse
import hashlib
import io
from pathlib import Path
import tarfile
from urllib.request import urlopen

MODEL_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
KWS_URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/{MODEL_NAME}.tar.bz2"
KWS_SHA256 = "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a"
VAD_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
VAD_SHA256 = "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"
KWS_FILES = (
    "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    "bpe.model", "tokens.txt", "README.md",
)


def download(url, expected_hash, max_bytes):
    with urlopen(url, timeout=60) as response:
        data = response.read(max_bytes + 1)
    if len(data) > max_bytes or hashlib.sha256(data).hexdigest() != expected_hash:
        raise RuntimeError("Public model download failed its integrity check")
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args()
    args.model_dir.mkdir(parents=True, exist_ok=True)
    # Extract only known regular files to known paths; never unpack arbitrary paths.
    archive = download(KWS_URL, KWS_SHA256, 20_000_000)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:bz2") as source:
        for filename in KWS_FILES:
            member = source.getmember(f"{MODEL_NAME}/{filename}")
            if not member.isfile() or member.size > 8_000_000:
                raise RuntimeError("Unexpected model archive entry")
            data = source.extractfile(member).read()
            (args.model_dir / filename).write_bytes(data)
    (args.model_dir / "silero_vad.onnx").write_bytes(download(VAD_URL, VAD_SHA256, 1_000_000))

    import sentencepiece
    tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(args.model_dir / "bpe.model"))
    pieces = tokenizer.encode("MERLIN", out_type=str)
    if pieces != ["▁ME", "R", "LI", "N"]:
        raise RuntimeError("Unexpected MERLIN tokenization")
    (args.model_dir / "keywords.txt").write_text(" ".join(pieces) + " @MERLIN\n", encoding="utf-8")
    print("Local MERLIN keyword and Silero speech detection models are ready.")


if __name__ == "__main__":
    main()
