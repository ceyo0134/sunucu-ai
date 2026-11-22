import os
import sys
from huggingface_hub import list_repo_files, hf_hub_download

repo = os.environ["MODEL_REPO"]
pat = os.environ.get("MODEL_PATTERN", "Q4_K_M").lower()

files = sorted(f for f in list_repo_files(repo) if f.endswith(".gguf") and pat in f.lower())
if not files:
    sys.exit("model file not found")

first = files[0]
if "-00001-of-" in first:  # split model: download every shard of the same model
    prefix = first.split("-00001-of-")[0]
    selected = [f for f in files if f.startswith(prefix)]
else:
    selected = [first]

for f in selected:
    print("downloading model part", flush=True)
    hf_hub_download(repo, f, local_dir="models")
print("done", flush=True)
