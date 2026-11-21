import sys

path = sys.argv[1]
title = sys.argv[2]
try:
    t = open(path, encoding="utf8", errors="replace").read()[-3500:]
except FileNotFoundError:
    t = "(no file)"
t = t.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
print("::notice title=" + title + "::" + t)
