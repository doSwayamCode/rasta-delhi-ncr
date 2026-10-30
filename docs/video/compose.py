"""Composes the walkthrough: screen recording inside a macOS-style window on a desktop, with smooth
zooms, Indian-English narration, an end card and Hindi captions.

Inputs: marks2.json (from record.js), durations_in.txt + tts_in/final/<id>.wav (from tts_best_take.py),
script.json, fonts/Inter.ttf and fonts/NotoSansDevanagari.ttf.
Output: rasta-walkthrough.mp4 (1920x1080), captions.hi.srt, captions.en.srt
"""
import json, math, subprocess, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1920, 1080, 30
REC_W, REC_H = 1280, 720
SCALE = 1.15
CW, CH = round(REC_W * SCALE), round(REC_H * SCALE)        # window content 1472x828
BAR = 46                                                  # title bar height
WX, WY = (W - CW) // 2, 44                                # window top-left
RADIUS = 14
LEAD = 0.3
FONT_UI = 'fonts/Inter.ttf'

S = json.load(open('script.json'))
M = json.load(open('marks2.json'))
marks, src = M['marks'], M['video']

def wav(p):
    w = wave.open(p)
    return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32), w.getframerate()
audio = {s['id']: wav(f"tts_in/final/{s['id']}.wav") for s in S}
SR = next(iter(audio.values()))[1]

# Zoom target per scene, in recording pixels: (zoom, centre x, centre y).
ZOOM = {
    'intro': (1.0, 640, 360), 'search': (1.5, 330, 230), 'map': (1.0, 640, 360),
    'score': (1.45, 330, 380), 'timeline': (1.45, 330, 370), 'metro': (1.0, 640, 360),
    'share': (1.22, 560, 380), 'feedback': (1.45, 330, 390), 'theme': (1.0, 640, 360),
}
CAP = {'theme': 7.5}   # seconds of footage to keep at most
# Narration delay per scene: the light-mode line waits until the switch is on screen.
LEADS = {'theme': 3.0}
lead = lambda sid: LEADS.get(sid, LEAD)

# ---------------------------------------------------------------- timeline
timeline, t = [], 0.0
for s in S:
    sid = s['id']
    alen = len(audio[sid][0]) / SR
    if sid == 'outro':
        L = alen + LEAD + 1.8
        timeline.append(dict(id=sid, t=t, L=L, alen=alen, src=None))
    else:
        m = marks[sid]
        L = max(m['end'] - m['start'], alen + lead(sid) + 0.4)
        if sid in CAP:
            L = min(L, CAP[sid])
        timeline.append(dict(id=sid, t=t, L=L, alen=alen, src=m['start']))
    t += L
TOTAL = t
print('total', round(TOTAL, 1), 's')

# ---------------------------------------------------------------- static layers
def font(size, weight=400):
    f = ImageFont.truetype(FONT_UI, size)
    try:
        f.set_variation_by_axes([min(32, max(14, size)), weight])
    except Exception:
        pass
    return f

def wallpaper():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    base = np.zeros((H, W, 3), np.float32)
    top, bottom = np.array([14, 18, 40]), np.array([8, 10, 22])
    g = (yy / H)[..., None]
    base[:] = top * (1 - g) + bottom * g
    for cx, cy, r, col, a in [(0.18, 0.2, 0.55, (246, 166, 60), 0.32), (0.85, 0.15, 0.5, (90, 80, 220), 0.38),
                              (0.7, 0.95, 0.6, (20, 140, 150), 0.30), (0.1, 0.95, 0.45, (200, 60, 120), 0.18)]:
        d = np.sqrt(((xx / W - cx) * 1.6) ** 2 + (yy / H - cy) ** 2) / r
        k = np.clip(1 - d, 0, 1) ** 2 * a
        base = base * (1 - k[..., None]) + np.array(col) * k[..., None]
    noise = np.random.default_rng(7).normal(0, 1.6, (H, W, 1))      # light grain, avoids banding
    return Image.fromarray(np.clip(base + noise, 0, 255).astype(np.uint8))

def rounded_mask(w, h, r, top=True, bottom=True):
    m = Image.new('L', (w * 3, h * 3), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w * 3 - 1, h * 3 - 1), radius=r * 3, fill=255)
    m = m.resize((w, h), Image.LANCZOS)
    if not top:
        m.paste(255, (0, 0, w, h // 2))
    if not bottom:
        m.paste(255, (0, h // 2, w, h))
    return m

bg = wallpaper().convert('RGBA')
WH = BAR + CH
shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle((WX, WY + 18, WX + CW, WY + WH + 18), radius=RADIUS, fill=(0, 0, 0, 150))
shadow = shadow.filter(ImageFilter.GaussianBlur(28))
bg.alpha_composite(shadow)

chrome = Image.new('RGBA', (CW, WH), (0, 0, 0, 0))
d = ImageDraw.Draw(chrome)
d.rectangle((0, 0, CW, BAR), fill=(38, 39, 44, 255))
d.line((0, BAR - 1, CW, BAR - 1), fill=(20, 20, 24, 255))
for i, col in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
    cx = 22 + i * 22
    d.ellipse((cx - 7, BAR / 2 - 7, cx + 7, BAR / 2 + 7), fill=col + (255,))
for i, ch in enumerate(['‹', '›']):                                  # back / forward
    d.text((100 + i * 26, BAR / 2), ch, font=font(26, 400), fill=(150, 152, 160, 255), anchor='mm')
pill_w = 560
px0 = (CW - pill_w) // 2
d.rounded_rectangle((px0, 9, px0 + pill_w, BAR - 9), radius=8, fill=(56, 57, 63, 255))
d.text((CW / 2, BAR / 2), 'Rasta: night routes for Delhi NCR', font=font(15, 500), fill=(214, 216, 222, 255), anchor='mm')
win_mask = rounded_mask(CW, WH, RADIUS)
content_mask = rounded_mask(CW, CH, RADIUS, top=False)

# ---------------------------------------------------------------- end card
def end_card():
    img = bg.copy()
    dd = ImageDraw.Draw(img)
    t1 = font(140, 700)
    dd.text((W / 2, 400), 'Rasta', font=t1, fill=(240, 241, 244), anchor='mm')
    tw = dd.textlength('Rasta', font=t1)
    dd.ellipse((W / 2 + tw / 2 + 14, 352, W / 2 + tw / 2 + 36, 374), fill=(245, 185, 66))
    dd.text((W / 2, 510), 'Night-time routes for Delhi NCR', font=font(40, 500), fill=(232, 234, 240), anchor='mm')
    dd.text((W / 2, 600), 'Open data: OpenStreetMap · Overture Maps · NASA Black Marble', font=font(26), fill=(170, 176, 190), anchor='mm')
    dd.text((W / 2, 645), 'github.com/doSwayamCode/rasta-delhi-ncr', font=font(26, 500), fill=(245, 185, 66), anchor='mm')
    dd.text((W / 2, 735), 'A guide for choosing, not a safety guarantee. Emergency: 112', font=font(24), fill=(150, 156, 170), anchor='mm')
    return img.convert('RGB')
CARD = end_card()

# ---------------------------------------------------------------- zoom curve
def ease(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)

def zoom_at(tt):
    """Zoom state at timeline time tt: eases from the previous scene's target over 0.9 s."""
    prev = ZOOM['intro']
    for seg in timeline:
        if seg['id'] not in ZOOM:
            break
        if tt < seg['t']:
            break
        cur = ZOOM[seg['id']]
        k = ease((tt - seg['t']) / 0.9)
        state = tuple(p + (c - p) * k for p, c in zip(prev, cur))
        prev = cur if tt >= seg['t'] + 0.9 else state
    return prev

def crop_box(z, cx, cy):
    w, h = REC_W / z, REC_H / z
    x0 = min(max(cx - w / 2, 0), REC_W - w)
    y0 = min(max(cy - h / 2, 0), REC_H - h)
    return (x0, y0, x0 + w, y0 + h)

# ---------------------------------------------------------------- narration + captions
track = np.zeros(int((TOTAL + 0.5) * SR), np.float32)
for seg in timeline:
    a = audio[seg['id']][0]
    i0 = int((seg['t'] + lead(seg['id'])) * SR)
    track[i0:i0 + len(a)] += a
w_ = wave.open('narration_in.wav', 'wb'); w_.setnchannels(1); w_.setsampwidth(2); w_.setframerate(SR)
w_.writeframes(np.clip(track, -32767, 32767).astype(np.int16).tobytes()); w_.close()

def ts_ass(x):
    h, x = divmod(x, 3600); m, x = divmod(x, 60); return f"{int(h)}:{int(m):02d}:{x:05.2f}"
def ts_srt(x):
    ms = int(round(x * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
cues = []
for s, seg in zip(S, timeline):
    lines = s['hi']; tot = sum(len(x) for x in lines); acc = seg['t'] + lead(seg['id'])
    for i, line in enumerate(lines):
        dlen = seg['alen'] * len(line) / tot
        cues.append((acc, acc + dlen + (0.3 if i == len(lines) - 1 else 0), line))
        acc += dlen
with open('captions_in.ass', 'w', encoding='utf-8') as f:
    f.write(f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hi,Noto Sans Devanagari,40,&H00FFFFFF,&H00FFFFFF,&H50101018,&H50101018,0,0,0,0,100,100,0,0,3,14,0,2,160,160,44,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""")
    for a, b, line in cues:
        f.write(f"Dialogue: 0,{ts_ass(a)},{ts_ass(b)},Hi,,0,0,0,,{line}\n")
with open('captions.hi.srt', 'w', encoding='utf-8') as f:
    for i, (a, b, line) in enumerate(cues, 1):
        f.write(f"{i}\n{ts_srt(a)} --> {ts_srt(b)}\n{line}\n\n")
with open('captions.en.srt', 'w', encoding='utf-8') as f:
    for i, (s, seg) in enumerate(zip(S, timeline), 1):
        f.write(f"{i}\n{ts_srt(seg['t'] + lead(seg['id']))} --> {ts_srt(seg['t'] + lead(seg['id']) + seg['alen'])}\n{s['en']}\n\n")

# ---------------------------------------------------------------- render
enc = subprocess.Popen(
    ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
     '-i', 'narration_in.wav',
     '-vf', f"ass=captions_in.ass:fontsdir=fonts,fade=t=in:st=0:d=0.5,fade=t=out:st={TOTAL - 0.7:.2f}:d=0.7",
     '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
     '-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
     '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-shortest', 'rasta-walkthrough.mp4'],
    stdin=subprocess.PIPE)

frame_no = 0
for seg in timeline:
    n = round(seg['L'] * FPS)
    if seg['src'] is None:
        card = np.asarray(CARD).tobytes()
        for _ in range(n):
            enc.stdin.write(card); frame_no += 1
        continue
    dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', f"{seg['src']:.3f}", '-i', src, '-t', f"{seg['L'] + 1:.3f}",
                            '-vf', f'fps={FPS}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    last = None
    for k in range(n):
        buf = dec.stdout.read(REC_W * REC_H * 3)
        if len(buf) == REC_W * REC_H * 3:
            last = Image.frombuffer('RGB', (REC_W, REC_H), buf)
        tt = seg['t'] + k / FPS
        z, cx, cy = zoom_at(tt)
        content = last.resize((CW, CH), Image.BICUBIC, box=crop_box(z, cx, cy))
        win = chrome.copy()
        win.paste(content, (0, BAR), content_mask)
        frame = bg.copy()
        frame.paste(win, (WX, WY), win_mask)
        enc.stdin.write(frame.convert('RGB').tobytes())
        frame_no += 1
    dec.stdout.close(); dec.wait()
    print(seg['id'], 'done', frame_no, flush=True)
enc.stdin.close(); enc.wait()
print('frames', frame_no)
