#!/usr/bin/env python3
"""
Generate N small files for upload performance testing.
Usage: python generate_test_files.py [count] [out_dir]
Default: 100000 files in tests/fixtures/100k/
"""
import os
import sys
import time
import random

COUNT   = int(sys.argv[1]) if len(sys.argv) > 1 else 100_000
OUT_DIR = sys.argv[2]      if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), 'fixtures', '100k')

os.makedirs(OUT_DIR, exist_ok=True)
t0 = time.time()
for i in range(COUNT):
    size = random.randint(2048, 8192)  # 2–8 KB
    path = os.path.join(OUT_DIR, f'file_{i:06d}.bin')
    if not os.path.exists(path):
        with open(path, 'wb') as f:
            f.write(os.urandom(size))
    if (i + 1) % 10_000 == 0:
        elapsed = time.time() - t0
        print(f'{i+1:,}/{COUNT:,}  {elapsed:.1f}s  ({(i+1)/elapsed:.0f} files/s)')

print(f'Done: {COUNT:,} files in {OUT_DIR}  ({time.time()-t0:.1f}s)')
