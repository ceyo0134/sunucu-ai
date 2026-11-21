#!/bin/bash
set -e
MODEL=$(find models -name "*.gguf" | sort | head -n1)
echo "model: $MODEL"
IMG=ghcr.io/ggml-org/llama.cpp:server
if ! docker pull "$IMG"; then
  IMG=ghcr.io/ggerganov/llama.cpp:server
  docker pull "$IMG"
fi

# $1 = optional extra flags. --swa-full keeps the whole prompt cache for sliding-window models (Gemma), so the big prompt is not re-read every message.
run_llm() {
  docker rm -f llm >/dev/null 2>&1 || true
  docker run -d --name llm -p 127.0.0.1:8080:8080 -v "$PWD/models:/models" "$IMG" \
    -m "/models/${MODEL#models/}" --host 0.0.0.0 --port 8080 -c 24576 -t 4 -np 2 $1
}

# returns 0 when the server answers, 1 when it crashed or took too long
wait_ready() {
  for i in $(seq 1 120); do
    if curl -sf http://127.0.0.1:8080/health >/dev/null; then
      echo "llm ready after $((i*5))s"
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' llm 2>/dev/null)" != "true" ]; then
      return 1
    fi
    sleep 5
  done
  return 1
}

run_llm "--swa-full --jinja"
if ! wait_ready; then
  echo "start with extra flags failed, last log lines:"
  docker logs llm 2>&1 | tail -15
  echo "retrying without extra flags"
  run_llm ""
  if ! wait_ready; then
    docker logs llm 2>&1 | tail -40
    exit 1
  fi
fi
