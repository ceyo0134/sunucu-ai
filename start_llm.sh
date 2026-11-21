#!/bin/bash
set -e
MODEL=$(find models -name "*.gguf" | sort | head -n1)
echo "model: $MODEL"
IMG=ghcr.io/ggml-org/llama.cpp:server
if ! docker pull "$IMG"; then
  IMG=ghcr.io/ggerganov/llama.cpp:server
  docker pull "$IMG"
fi
docker run -d --name llm -p 127.0.0.1:8080:8080 -v "$PWD/models:/models" "$IMG" \
  -m "/models/${MODEL#models/}" --host 0.0.0.0 --port 8080 -c 2048 -t 4 -np 1
for i in $(seq 1 120); do
  if curl -sf http://127.0.0.1:8080/health >/dev/null; then
    echo "llm ready after $((i*5))s"
    exit 0
  fi
  sleep 5
done
docker logs llm 2>&1 | tail -40
exit 1
