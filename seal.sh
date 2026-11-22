#!/bin/bash
# seal: models/ -> enc/ceyoslen-5b.bin (AES-256 encrypted, key = secret MODEL_KEY). unseal: enc/ -> models/
# Only the encrypted blob goes into the Actions cache, the plain model never leaves the runner.
set -e
case "$1" in
  seal)
    mkdir -p enc
    n=$(find models -name "*.gguf" | wc -l)
    if [ "$n" = "1" ]; then mv "$(find models -name '*.gguf')" models/ceyoslen-5b.gguf; fi
    rm -rf models/.cache
    if [ -n "$MODEL_KEY" ]; then
      tar -C . -cf - models | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -pass env:MODEL_KEY -out enc/ceyoslen-5b.bin
    else
      tar -C . -cf enc/ceyoslen-5b.bin models
    fi
    ;;
  unseal)
    if [ -n "$MODEL_KEY" ]; then
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass env:MODEL_KEY -in enc/ceyoslen-5b.bin | tar -C . -xf -
    else
      tar -C . -xf enc/ceyoslen-5b.bin
    fi
    ;;
esac
echo "model $1 done"
