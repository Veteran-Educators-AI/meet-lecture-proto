#!/bin/bash
set -e

cd /home/pilow/troja-workspace/meet-lecture-proto
API_KEY=$(grep ELEVENLABS_API_KEY .env | cut -d= -f2)
VOICE_ID="fEaWmZoTfDjFdlVUAW65"
MODEL="eleven_multilingual_v2"

generate_lesson() {
  local CODE=$1
  local SCRIPT_FILE=$2
  local OUT_DIR="public/generated/$CODE"
  mkdir -p "$OUT_DIR"

  echo "=== Generating $CODE ==="

  # Split script into segments (~900 chars each, on paragraph breaks)
  python3 -c "
import sys, json

text = open('$SCRIPT_FILE').read().strip()
paragraphs = [p.strip() for p in text.split('\n\n') if p.strip()]
segs = []
buf = ''
for p in paragraphs:
    if len((buf + '\n\n' + p).strip()) <= 900:
        buf = (buf + '\n\n' + p).strip() if buf else p
    else:
        if buf:
            segs.append(buf)
        buf = p
if buf:
    segs.append(buf)

for i, seg in enumerate(segs):
    print(json.dumps({'index': i+1, 'text': seg}))
" | while read -r line; do
    IDX=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin)['index'])")
    TEXT=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin)['text'])")
    FNAME=$(printf "seg%03d.mp3" "$IDX")

    echo "  Segment $IDX -> $OUT_DIR/$FNAME"

    curl -s -X POST \
      "https://api.elevenlabs.io/v1/text-to-speech/$VOICE_ID/stream" \
      -H "xi-api-key: $API_KEY" \
      -H "Content-Type: application/json" \
      -H "Accept: audio/mpeg" \
      -d "$(python3 -c "
import json
print(json.dumps({
    'text': '''$TEXT''',
    'model_id': '$MODEL',
    'voice_settings': {
        'stability': 0.55,
        'similarity_boost': 1.0,
        'style': 0.35,
        'use_speaker_boost': True
    }
}))
")" \
      --output "$OUT_DIR/$FNAME"

    SIZE=$(stat -c%s "$OUT_DIR/$FNAME" 2>/dev/null || echo 0)
    echo "    -> $SIZE bytes"

    if [ "$SIZE" -lt 1000 ]; then
      echo "    WARNING: File too small, might be an error response"
      cat "$OUT_DIR/$FNAME"
      echo ""
    fi
  done

  echo "=== $CODE complete ==="
  ls -la "$OUT_DIR/"
}

generate_lesson "INT2826" "scripts/INT2826-simple-compound-interest.txt"
echo ""
generate_lesson "CD2826" "scripts/CD2826-certificates-of-deposit.txt"
