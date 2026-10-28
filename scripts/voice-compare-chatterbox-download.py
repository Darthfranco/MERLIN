#!/usr/bin/env python3
"""Fetch verified, revision-pinned Nano/Core ML weights without Python packages."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import sys
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "local" / "voice-compare" / "chatterbox-cache" / "hub" / "models"
REVISIONS = {
    "iliasaz/chatterbox-nano-coreml": "3fb8f1a29cf456d82268b81c71b9b0fd54658542",
    "iliasaz/perth-coreml": "f17228757ad4876c8e13f0cd606758ce1ea5e4de",
}
PACKAGES = {"T3LM", "S3Encoder", "S3CFM", "S3Vocoder", "CAMPPlus", "MatchaMel", "VEMel", "VELSTM", "S3Tokenizer"}
SUPPORT = {"speech_emb.npy", "text_emb.npy", "spkr_enc_weight.npy", "spkr_enc_bias.npy", "default-conds.safetensors", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json", "vocab.json", "merges.txt"}


def included(repo, name):
    if repo.endswith("/perth-coreml"):
        return name.startswith("PerthEncoder.mlpackage/")
    return name in SUPPORT or any(name.startswith(stem + ".mlpackage/") for stem in PACKAGES)


def digest(path, expected):
    is_lfs = bool(expected.get("lfs"))
    hasher = hashlib.sha256() if is_lfs else hashlib.sha1()
    if not is_lfs:
        hasher.update(f"blob {expected['size']}\0".encode())
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            hasher.update(block)
    return hasher.hexdigest() == (expected["lfs"]["sha256"] if is_lfs else expected["blobId"])


def fetch(item):
    repo, revision, entry = item
    name = entry["rfilename"]
    destination = CACHE / repo / name
    if destination.is_file() and destination.stat().st_size == entry["size"] and digest(destination, entry):
        return name
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".download")
    url = f"https://huggingface.co/{repo}/resolve/{revision}/{urllib.parse.quote(name, safe='/')}"
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=90) as response, temporary.open("wb") as output:
                while block := response.read(1024 * 1024):
                    output.write(block)
            if temporary.stat().st_size != entry["size"] or not digest(temporary, entry):
                raise ValueError(f"Size/hash mismatch: {name}")
            temporary.replace(destination)
            return name
        except Exception:
            temporary.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def main():
    tasks = []
    receipts = {}
    for repo, revision in REVISIONS.items():
        url = f"https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true"
        with urllib.request.urlopen(url, timeout=60) as response:
            metadata = json.load(response)
        if metadata["sha"] != revision:
            raise ValueError("The Hub returned an unexpected model revision.")
        entries = [entry for entry in metadata["siblings"] if included(repo, entry["rfilename"])]
        if not entries or any(".." in Path(entry["rfilename"]).parts for entry in entries):
            raise ValueError("Invalid model manifest.")
        tasks.extend((repo, revision, entry) for entry in entries)
        receipts[repo] = {"revision": revision, "files": entries}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        jobs = [pool.submit(fetch, item) for item in tasks]
        for number, job in enumerate(concurrent.futures.as_completed(jobs), 1):
            print(f"Nano setup {number}/{len(jobs)}: {job.result()}", file=sys.stderr, flush=True)
    receipt = CACHE.parents[1] / "installation.json"
    receipt.write_text(json.dumps(receipts, indent=2) + "\n")
    print("Pinned Nano and Perth files downloaded and verified.", file=sys.stderr)


if __name__ == "__main__":
    main()
