"""Envia apenas PTE sintetico pelo EXE real, sem dados de cliente."""
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pte_writer import write_pte

here = Path(__file__).resolve().parent
results = []
with tempfile.TemporaryDirectory(prefix='sincronpit-online-test-') as temporary:
    for device, machine_id in [('PIT-04-4960CF', 'pit-04'), ('PIT-07-5726CF', 'pit-07')]:
        file_name = 'AUTOTESTE-ONLINE-' + str(uuid.uuid4()) + '.PTE'
        file = Path(temporary) / file_name
        samples = [math.sin(i * 0.27) * math.exp(-((i - 160) / 70) ** 2) for i in range(1024)]
        write_pte(samples, file, ws=4000, le=10, fs=50000, md=2, ma=10, t1=150)
        data = file.read_bytes()
        exe = here / 'exe' / 'distribuir' / ('SincronPIT-' + device + '.exe')
        attempts = []
        for i in range(2):
            result = subprocess.run([str(exe), '--enviar', str(file)], capture_output=True, text=True, timeout=45)
            output = result.stdout + result.stderr
            expected = r'resultado\s*:\s*' + ('Enviado' if i == 0 else 'Duplicado')
            attempts.append({'exit': result.returncode, 'ok': result.returncode == 0 and bool(re.search(expected, output)) and machine_id in output, 'output': output.strip()})
        results.append({'machine_id': machine_id, 'file_name': file_name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'attempts': attempts})

print(json.dumps(results))
if any(not attempt['ok'] for result in results for attempt in result['attempts']):
    sys.exit(1)
