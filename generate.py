#!/usr/bin/env python3
"""Generate ElevenLabs TTS segments for meet-lecture-proto lessons."""

import os, sys, json, time, pathlib, urllib.request, urllib.error

BASE = pathlib.Path(__file__).resolve().parent

# Load .env manually
env_file = BASE / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
VOICE_ID = "fEaWmZoTfDjFdlVUAW65"
MODEL = "eleven_multilingual_v2"
VOICE_SETTINGS = {
    "stability": 0.55,
    "similarity_boost": 1.0,
    "style": 0.35,
    "use_speaker_boost": True,
}

if not API_KEY:
    print("ERROR: ELEVENLABS_API_KEY not set")
    sys.exit(1)


def split_segments(text, max_chars=900):
    paragraphs = [p.strip() for p in text.strip().split("\n\n") if p.strip()]
    segs = []
    buf = ""
    for p in paragraphs:
        combined = (buf + "\n\n" + p).strip() if buf else p
        if len(combined) <= max_chars:
            buf = combined
        else:
            if buf:
                segs.append(buf)
            # If paragraph itself is too long, split by sentences
            if len(p) > max_chars:
                import re
                sentences = re.split(r"(?<=[.!?])\s+", p)
                sbuf = ""
                for s in sentences:
                    combined_s = (sbuf + " " + s).strip() if sbuf else s
                    if len(combined_s) <= max_chars:
                        sbuf = combined_s
                    else:
                        if sbuf:
                            segs.append(sbuf)
                        sbuf = s
                if sbuf:
                    segs.append(sbuf)
                buf = ""
            else:
                buf = p
    if buf:
        segs.append(buf)
    return segs


def generate_tts(text, output_path):
    """Call ElevenLabs TTS and write MP3 to output_path."""
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}/stream"
    body = json.dumps({
        "text": text,
        "model_id": MODEL,
        "voice_settings": VOICE_SETTINGS,
    }).encode("utf-8")

    req = urllib.request.Request(url, data=body, method="POST", headers={
        "xi-api-key": API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    })

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
            output_path.write_bytes(data)
            return len(data)
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")[:500]
        print(f"  ERROR {e.code}: {err_body}")
        return -1


def generate_lesson(code, script_file):
    script_path = BASE / "scripts" / script_file
    if not script_path.exists():
        print(f"ERROR: Script not found: {script_path}")
        return False

    text = script_path.read_text()
    segments = split_segments(text)
    print(f"\n{'='*50}")
    print(f"Lesson {code}: {len(segments)} segments from {script_file}")
    print(f"{'='*50}")

    out_dir = BASE / "public" / "generated" / code
    out_dir.mkdir(parents=True, exist_ok=True)

    playlist = []
    for i, seg_text in enumerate(segments):
        fname = f"seg{i+1:03d}.mp3"
        out_file = out_dir / fname
        print(f"  [{i+1}/{len(segments)}] Generating {fname} ({len(seg_text)} chars)...")

        size = generate_tts(seg_text, out_file)
        if size < 0:
            print(f"  FAILED on segment {i+1}")
            return False

        print(f"    -> {size:,} bytes")
        playlist.append({"id": f"seg{i+1}", "url": f"/generated/{code}/{fname}"})

        # Small delay to avoid rate limits
        if i < len(segments) - 1:
            time.sleep(0.5)

    # Save playlist JSON
    playlist_path = out_dir / "playlist.json"
    playlist_path.write_text(json.dumps(playlist, indent=2))
    print(f"\n  Playlist saved: {playlist_path}")
    print(f"  Total segments: {len(playlist)}")

    # List files
    for f in sorted(out_dir.iterdir()):
        print(f"    {f.name}: {f.stat().st_size:,} bytes")

    return True


if __name__ == "__main__":
    lessons = [
        ("INT2826", "INT2826-simple-compound-interest.txt"),
        ("CD2826", "CD2826-certificates-of-deposit.txt"),
    ]

    results = {}
    for code, script in lessons:
        ok = generate_lesson(code, script)
        results[code] = "SUCCESS" if ok else "FAILED"

    print(f"\n{'='*50}")
    print("RESULTS:")
    for code, status in results.items():
        print(f"  {code}: {status}")
    print(f"{'='*50}")
