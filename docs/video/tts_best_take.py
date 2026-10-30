"""Indian-English narration: each line of script.json's `say` (English written phonetically in
Devanagari) is spoken by Piper's Hindi voice hi_IN-pratham-medium (CC BY-NC-SA 4.0). Five takes per
line; the one Whisper transcribes closest to the English text is kept, then sped up 6% (pitch kept).
Writes tts_in/final/<id>.wav and durations_in.txt.
"""
import json, re, subprocess, wave, shutil, os, numpy as np
from faster_whisper import WhisperModel
VOICE, TAKES, OUT = "hi_IN-pratham-medium", 5, "tts_in/best"
m = WhisperModel("small", device="cpu", compute_type="int8")
S = json.load(open('script.json'))
norm = lambda t: re.sub(r"[^a-z0-9 ]", " ", t.lower().replace("you're","you are").replace("there's","there is")
    .replace("ncr","n c r").replace("cctv","c c t v").replace("openstreetmap","open street map").replace("opendata","open data")).split()
def wer(r, h):
    d = np.zeros((len(r)+1, len(h)+1), int); d[:,0]=range(len(r)+1); d[0,:]=range(len(h)+1)
    for i in range(1,len(r)+1):
        for j in range(1,len(h)+1): d[i,j]=min(d[i-1,j]+1,d[i,j-1]+1,d[i-1,j-1]+(r[i-1]!=h[j-1]))
    return d[-1,-1]
os.makedirs(OUT, exist_ok=True); os.makedirs("tts_in/takes", exist_ok=True)
durs=[]; E=N=0
for s in S:
    best=None
    for k in range(TAKES):
        p=f"tts_in/takes/{s['id']}_{k}.wav"
        subprocess.run(["python3","-m","piper","-m",f"voices/{VOICE}.onnx","-f",p,"--sentence-silence","0.3"],input=s['say'].encode(),check=True,capture_output=True)
        w=wave.open(p); a=np.frombuffer(w.readframes(w.getnframes()),np.int16).astype(np.float32)/32768
        a16=np.interp(np.arange(0,len(a),w.getframerate()/16000),np.arange(len(a)),a).astype(np.float32)
        hyp=" ".join(x.text for x in m.transcribe(a16,language="en",beam_size=5)[0]).strip()
        e=wer(norm(s['en']),norm(hyp))
        if best is None or e<best[0]: best=(e,p,hyp,len(a)/w.getframerate())
    shutil.copy(best[1], f"{OUT}/{s['id']}.wav"); E+=best[0]; N+=len(norm(s['en']))
    durs.append(f"{s['id']} {best[3]:.2f}")
    print(f"{s['id']:9} err {best[0]}  {best[2][:100]}")
print("WER", round(E/N*100,1),"%")
os.makedirs("tts_in/final", exist_ok=True)
durs=[]
for s in S:
    out=f"tts_in/final/{s['id']}.wav"
    subprocess.run(["ffmpeg","-v","error","-y","-i",f"{OUT}/{s['id']}.wav","-af","atempo=1.06",out],check=True)
    w=wave.open(out); durs.append(f"{s['id']} {w.getnframes()/w.getframerate():.2f}")
open("durations_in.txt","w").write("\n".join(durs)+"\n")
print("total", round(sum(float(d.split()[1]) for d in durs),1),"s")
