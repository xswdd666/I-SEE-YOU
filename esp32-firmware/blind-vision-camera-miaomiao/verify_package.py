"""Check the model archive and flash layout before flashing (standard library only)."""
from pathlib import Path
import struct

root = Path(__file__).resolve().parent
data = (root / 'wake-model' / 'srmodels.bin').read_bytes()
assert struct.unpack_from('<I', data)[0] == 1
name, count = struct.unpack_from('<32sI', data, 4)
assert name.rstrip(b'\0') == b'wn9_miaomiaotongxue_tts' and count == 3
files = {}
for index in range(count):
    name, offset, size = struct.unpack_from('<32sII', data, 40 + index * 40)
    assert offset >= 160 and offset + size <= len(data)
    files[name.rstrip(b'\0').decode()] = data[offset:offset + size]
assert set(files) == {'_MODEL_INFO_', 'wn9_data', 'wn9_index'}
assert '喵喵同学' in files['_MODEL_INFO_'].decode('utf-8')
assert len(data) < 0x80000
previous_end = 0x9000
partitions = {}
for line in (root / 'partitions.csv').read_text().splitlines():
    if not line.strip() or line.startswith('#'):
        continue
    name, kind, subtype, offset, size, *_ = [s.strip() for s in line.split(',')]
    offset, size = int(offset, 0), int(size, 0)
    assert offset >= previous_end and offset + size <= 0x800000
    previous_end = offset + size
    partitions[name] = (offset, size)
assert partitions['nvs'] == (0x9000, 0x5000)
assert partitions['model'] == (0x510000, 0x80000)
assert partitions['app0'][0] == 0x10000
print('OK: wake word, archive bounds, 8 MB flash layout and preserved NVS')
