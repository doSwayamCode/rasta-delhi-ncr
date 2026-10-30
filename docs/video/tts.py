import json, sys, subprocess, wave
voice = sys.argv[1]; out = sys.argv[2]
import os; os.makedirs(out, exist_ok=True)
for s in json.load(open('script.json')):
    p = f"{out}/{s['id']}.wav"
    subprocess.run(["python3","-m","piper","-m",f"voices/{voice}.onnx","-f",p,"--sentence-silence","0.35","--length-scale","1.05"], input=s['en'].encode(), check=True, capture_output=True)
    w = wave.open(p); print(s['id'], round(w.getnframes()/w.getframerate(),2))
