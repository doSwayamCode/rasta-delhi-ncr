import json, subprocess, wave, numpy as np
from PIL import Image, ImageDraw, ImageFont

S = json.load(open('script.json'))
M = json.load(open('marks.json'))
marks, src = M['marks'], M['video']
LEAD = 0.25          # narration starts this long after its scene starts
FPS = 30

def wav(path):
    w = wave.open(path)
    return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32), w.getframerate()

audio = {s['id']: wav(f"tts/final/{s['id']}.wav") for s in S}
SR = next(iter(audio.values()))[1]

# 1. scene clips from the screen recording
clips, timeline, t = [], [], 0.0
for s in S:
    sid = s['id']
    alen = len(audio[sid][0]) / SR
    if sid == 'outro':
        L = alen + LEAD + 1.6
        card(L) if False else None
        clips.append(('card', L))
    else:
        m = marks[sid]
        L = max(m['end'] - m['start'], alen + LEAD + 0.35)
        clips.append((m['start'], L))
    timeline.append((sid, t, L, alen))
    t += L
total = t

# 2. end card
W, H = 1280, 720
img = Image.new('RGB', (W, H), (14, 17, 22))
d = ImageDraw.Draw(img)
def font(size, weight):
    f = ImageFont.truetype('fonts/Inter.ttf', size)
    try: f.set_variation_by_axes([min(32, max(14, size)), weight])
    except Exception: pass
    return f
title, tag = font(120, 700), font(34, 400)
small = font(24, 400)
d.text((W/2, 250), 'Rasta', font=title, fill=(232, 234, 237), anchor='mm')
tw = d.textlength('Rasta', font=title)
d.ellipse((W/2 + tw/2 + 12, 210, W/2 + tw/2 + 30, 228), fill=(245, 185, 66))
d.text((W/2, 345), 'Night-time routes for Delhi NCR', font=tag, fill=(232, 234, 237), anchor='mm')
d.text((W/2, 430), 'Open data: OpenStreetMap · Overture Maps · NASA Black Marble', font=small, fill=(142, 152, 164), anchor='mm')
d.text((W/2, 470), 'github.com/doSwayamCode/rasta-delhi-ncr', font=small, fill=(245, 185, 66), anchor='mm')
d.text((W/2, 560), 'A guide for choosing, not a safety guarantee. Emergency: 112', font=small, fill=(142, 152, 164), anchor='mm')
img.save('endcard.png')

# 3. render each clip at a constant 30 fps
parts = []
for i, (start, L) in enumerate(clips):
    out = f'part{i}.mp4'
    if start == 'card':
        cmd = ['ffmpeg','-v','error','-y','-loop','1','-t',f'{L:.3f}','-i','endcard.png',
               '-vf',f'fade=t=in:st=0:d=0.6,format=yuv420p','-r',str(FPS),'-c:v','libx264','-crf','20',out]
    else:
        # hold the last frame if the recording is shorter than the clip needs
        cmd = ['ffmpeg','-v','error','-y','-ss',f'{start:.3f}','-i',src,'-t',f'{L:.3f}',
               '-vf',f'fps={FPS},tpad=stop_mode=clone:stop_duration=2,trim=duration={L:.3f},format=yuv420p',
               '-an','-c:v','libx264','-crf','20',out]
    subprocess.run(cmd, check=True)
    parts.append(out)
open('parts.txt','w').write(''.join(f"file '{p}'\n" for p in parts))
subprocess.run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i','parts.txt','-c','copy','video_only.mp4'], check=True)

# 4. narration track
track = np.zeros(int((total + 0.5) * SR), np.float32)
for sid, start, L, alen in timeline:
    a = audio[sid][0]
    i0 = int((start + LEAD) * SR)
    track[i0:i0 + len(a)] += a
track = np.clip(track, -32767, 32767).astype(np.int16)
w = wave.open('narration.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(track.tobytes()); w.close()

# 5. Hindi captions (ASS for burning, SRT for the repo); multi-line scenes split by text length
def ts_ass(x):
    h, x = divmod(x, 3600); m, x = divmod(x, 60); return f"{int(h)}:{int(m):02d}:{x:05.2f}"
def ts_srt(x):
    ms = int(round(x * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
cues = []
for s, (sid, start, L, alen) in zip(S, timeline):
    lines = s['hi']; weights = [len(x) for x in lines]; acc = start + LEAD
    for line, wgt in zip(lines, weights):
        d_ = alen * wgt / sum(weights)
        cues.append((acc, acc + d_ + (0.3 if line == lines[-1] else 0), line, s['en']))
        acc += d_
ass = open('captions.ass', 'w', encoding='utf-8')
ass.write("""[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 800
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hi,Noto Sans Devanagari,31,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,60,60,24,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""")
for a, b, line, _ in cues:
    ass.write(f"Dialogue: 0,{ts_ass(a)},{ts_ass(b)},Hi,,0,0,0,,{line}\n")
ass.close()
with open('captions.hi.srt', 'w', encoding='utf-8') as f:
    for i, (a, b, line, _) in enumerate(cues, 1):
        f.write(f"{i}\n{ts_srt(a)} --> {ts_srt(b)}\n{line}\n\n")
with open('captions.en.srt', 'w', encoding='utf-8') as f:
    for i, (sid, start, L, alen) in enumerate(timeline, 1):
        en = next(s['en'] for s in S if s['id'] == sid).replace('Delhi N C R', 'Delhi NCR')
        f.write(f"{i}\n{ts_srt(start + LEAD)} --> {ts_srt(start + LEAD + alen)}\n{en}\n\n")

# 6. final mux with burned-in Hindi captions
subprocess.run(['ffmpeg','-v','error','-y','-i','video_only.mp4','-i','narration.wav',
    # an 80 px caption band under the 1280x720 picture, so captions never cover the app
    '-vf',"pad=1280:800:0:0:color=0x0b0d10,ass=captions.ass:fontsdir=fonts,fade=t=out:st=%.2f:d=0.6" % (total - 0.6),
    '-af','loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:v','libx264','-crf','24','-preset','slow','-pix_fmt','yuv420p','-movflags','+faststart',
    '-c:a','aac','-b:a','128k','-ar','48000','-shortest','rasta-walkthrough.mp4'], check=True)
print('total', round(total, 1), 's')
