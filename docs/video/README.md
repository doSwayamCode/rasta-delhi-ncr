# Rebuilding the walkthrough video

`docs/rasta-walkthrough.mp4` is made from a real screen recording of the app, not mock-ups. Everything
needed to remake it is here.

| File | What it does |
| --- | --- |
| `script.json` | The narration, scene by scene: English voice-over (`en`) and Hindi captions (`hi`) |
| `tts.py` | Synthesises each scene's narration with [Piper](https://github.com/rhasspy/piper) (`en_US-lessac-high`) |
| `record.js` | Drives the running app with Playwright and records 1280×720 footage, timing each scene to its narration |
| `assemble.py` | Cuts the footage per scene, adds the end card, lays the narration, burns in Hindi captions, writes `.srt` files |
| `local_feedback_sink.py` | Stand-in for the feedback webhook so the form can be shown without writing to the real sheet |

## Use your own voice

The narration in the current video is a synthetic neural voice. To replace it with a real one, record each
scene's `en` line from `script.json` as `tts/final/<id>.wav` (mono WAV, any sample rate, one file per scene:
`intro`, `search`, `map`, `score`, `timeline`, `metro`, `share`, `feedback`, `outro`), write
`<id> <seconds>` lines to `durations.txt`, then rerun `record.js` and `assemble.py`. Scene lengths follow
your recording automatically.

## Steps

```bash
pip install piper-tts numpy pillow
# voices/en_US-lessac-high.onnx(.json) from huggingface.co/rhasspy/piper-voices
# fonts/NotoSansDevanagari.ttf and fonts/Inter.ttf from github.com/google/fonts
python3 tts.py en_US-lessac-high tts/final > durations.txt
python3 local_feedback_sink.py &
FEEDBACK_WEBHOOK_URL=http://127.0.0.1:3999/ FEEDBACK_SECRET=test-secret npx next start -p 3500   # from the repo root, after npm run build
node record.js warm   # first pass fills map-tile and route caches
node record.js        # the recording
python3 assemble.py   # -> rasta-walkthrough.mp4, captions.hi.srt, captions.en.srt
```

If the project is renamed, change "Rasta" / "रास्ता" in `script.json` and the end card text in
`assemble.py`, then run the steps again (about five minutes).
