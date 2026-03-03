# Meet Lecture Prototype (local)

A working prototype for a Google-Meet-friendly flow:
- Teacher creates a session (code)
- Students join with code + name
- Teacher starts lecture → student players auto-start
- If any student submits a **text or audio** question → lecture **pauses for everyone**
- Teacher sees a live question queue (with audio playback)
- Anti-spam: **1 question per student per 60s**
- Questions are rejected **before** lecture start

## Requirements
- Node.js 18+

## Install
```bash
cd /home/pilow/troja-workspace/meet-lecture-proto
npm install
```

## Run
```bash
npm start
```
Then open:
- Teacher: http://localhost:3000/teacher
- Student: http://localhost:3000/student

## How to demo
1. Teacher: click **Create Session** → copy the session code.
2. Student(s): open /student, enter code + name, click **Join**.
3. Teacher: click **Start Lecture**.
4. Student: submit a text question or record an audio question.
5. Observe: all student players pause; teacher dashboard shows the question.

## ElevenLabs (voice + audio generation)
This prototype can:
- create a new ElevenLabs voice from an uploaded sample
- generate segmented MP3 lecture audio from a pasted script

1) Copy `.env.example` to `.env`
2) Put your API key in `.env`:
```bash
ELEVENLABS_API_KEY=YOUR_KEY_HERE
```
3) Start the server, then use the Teacher page section **ElevenLabs**.

Generated MP3s are written to: `public/generated/<SESSION_CODE>/`

## Notes / prototype limitations
- Defaults to placeholder lecture segments under `public/sample/` until you generate your own.
- In-memory state for sessions/questions (restart loses them). VoiceId is saved per-session in `./sessions/<code>.json`.
- Browser autoplay policies: student audio usually starts after the student interacts with the page (joining + audio controls typically counts). If autoplay is blocked, student can press Play once and after that sync works fine.

## Next upgrades
- Auto-advance segments on `ended`
- Persist sessions to SQLite
- Teacher uploads script → generate ElevenLabs segments
- Better per-student cooldown UX + teacher override
