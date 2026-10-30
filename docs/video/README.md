# Rebuilding the walkthrough video

`docs/rasta-walkthrough.mp4` is a real screen recording of the app, not mock-ups. It's framed as a macOS-style
browser window on a generated desktop background, with smooth zooms, an Indian-English voice-over and Hindi
captions. Everything needed to remake it is here.

| File | What it does |
| --- | --- |
| `script.json` | Per scene: the English line (`en`), the same line written phonetically in Devanagari for the voice (`say`), and the Hindi captions (`hi`) |
| `tts_best_take.py` | Speaks each `say` line with Piper's Hindi voice `hi_IN-pratham-medium`, keeps the clearest of five takes (checked with Whisper against `en`), speeds it up 6% |
| `record.js` | Drives the running app with Playwright at 1280×720: visible cursor, click ripples, wheel scrolling; each scene is timed to its narration |
| `compose.py` | Puts the footage in a Mac-style window on a desktop at 1920×1080, adds per-scene zooms, the end card, the narration and burned-in Hindi captions; writes `.srt` files |
| `local_feedback_sink.py` | Stand-in for the feedback webhook so the form can be shown without writing to the real sheet |

## About the voice

There is no open Indian-English text-to-speech voice. Piper's Hindi voices produce real Indian-accented English
when the English is written phonetically in Devanagari ("दिस इज़ रास्ता…"), which is what the `say` field holds.
The voice is synthetic. `hi_IN-pratham-medium` was trained by PravalX on AI4Bharat's corpus and is licensed
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), so the video carries the same terms:
attribution, non-commercial use, share-alike.

### Using a real voice

Record each scene's `en` line as `tts_in/final/<id>.wav`, one file per scene: `intro`, `search`, `map`,
`score`, `timeline`, `metro`, `share`, `feedback`, `theme`, `outro`. Write `<id> <seconds>` lines to
`durations_in.txt`, then rerun `record.js` and `compose.py`. Scene lengths follow your recording.

## Steps

```bash
pip install piper-tts faster-whisper numpy pillow
# voices/hi_IN-pratham-medium.onnx(.json) from huggingface.co/rhasspy/piper-voices (hi/hi_IN/pratham/medium)
# fonts/Inter.ttf and fonts/NotoSansDevanagari.ttf from github.com/google/fonts
python3 tts_best_take.py                     # -> tts_in/final/*.wav, durations_in.txt
python3 local_feedback_sink.py &
# from the repo root, after `npm run build`:
FEEDBACK_WEBHOOK_URL=http://127.0.0.1:3999/ FEEDBACK_SECRET=test-secret npx next start -p 3600
node record.js warm                          # first pass fills map-tile and route caches
node record.js                               # the recording -> rec2/*.webm, marks2.json
python3 compose.py                           # -> rasta-walkthrough.mp4, captions.hi.srt, captions.en.srt
```

If the project is renamed, change "Rasta" / "रास्ता" in `script.json` and the end-card text in `compose.py`,
then run the steps again (about ten minutes).
