# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Coherent** is a social skills coaching app that uses fully on-device AI for real-time voice conversation practice. Users complete an LSAS (Liebowitz Social Anxiety Scale) assessment during onboarding, then practice conversations with AI personas across scenarios (small talk, making friends, job interview, dating).

**Critical constraint:** This app uses native modules and cannot run in Expo Go. Use `npx expo run:ios` / `npx expo run:android` to build, then use the Cloudflare tunnel dev server workflow (see Commands) to serve JS on school networks.

## Commands

```bash
# Development server (school network workaround via Cloudflare tunnel)
# Step 1: Start the tunnel (get the *.trycloudflare.com URL from output)
cloudflared tunnel --url http://localhost:8081

# Step 2: Start the dev server with that URL
EXPO_PACKAGER_PROXY_URL=https://{cloudflare-url-here}.trycloudflare.com npx expo start --dev-client --host lan --clear

# Build native app (only needed when native deps change)
npx expo run:ios
npx expo run:android

# After adding or changing native dependencies
npx expo prebuild --clean

# Lint
npx expo lint

# Build scripts
npm run reset-project   # Resets to blank Expo project
```

## Tech Stack

- **Framework:** Expo SDK 54, React Native 0.81, React 19, TypeScript (strict)
- **Navigation:** Expo Router v6 (file-based routing)
- **Styling:** NativeWind v4 (Tailwind CSS) + `clsx`
- **Local ML:** `react-native-executorch` — Whisper Tiny (STT), Kokoro (TTS), FSMN-VAD run on-device
- **LLM:** Groq API (`llama-3.3-70b-versatile`) via `hooks/useGroqLLM.ts` — streaming, replaces local LFM2.5
- **Audio:** `react-native-audio-api` for recording/playback
- **Video calling:** Tavus API + Daily.co WebRTC (chat tab)
- **State:** React Context (`GeneratingContext`) + React Refs for performance-critical state

## Architecture

```
app/
  index.tsx           # Entry: checks AsyncStorage for onboarding flag
  onboarding.tsx      # LSAS questionnaire + model download trigger
  _layout.tsx         # Root: SafeAreaProvider + GeneratingContext
  (tabs)/
    _layout.tsx       # Bottom tab navigation
    index.tsx         # Home/landing screen
    voice.tsx         # Main AI voice agent (1,800+ lines)
    chat.tsx          # Tavus video agent via Daily.co WebRTC

services/
  ModelLoader.ts      # HuggingFace model download, caching, validation

constants/
  LSASConfig.ts       # LSAS questionnaire items and scoring

context/
  GeneratingContext.tsx  # Global isGenerating state

components/
  MockComponents.tsx  # Shared UI components

models/               # Local model storage directory (gitignored)
```

## On-Device AI Pipeline (`voice.tsx`)

The voice pipeline chains four local models in sequence:

```
Mic → FSMN-VAD → Whisper STT → Groq LLM (API) → Kokoro TTS → Speaker
```

**Hooks:**
- `useGroqLLM()` (`hooks/useGroqLLM.ts`) — Groq streaming API; `sendMessage(text, { onToken })`, `isReady`, `isGenerating`
- `useSpeechToText()` — Whisper encoder/decoder; streams 16-bit PCM at 16kHz
- `useTextToSpeech()` — Kokoro synthesis; returns Float32Array chunks at 24kHz
- `useVAD()` — FSMN-VAD; detects speech start/end

**Key tuning constants (top of `voice.tsx`):**
```typescript
BARGE_IN_MIN_MS = 300          // Min speech before interrupt triggers
PLAYBACK_THRESHOLD = 0.06      // Audio energy cutoff
NO_SPEECH_TIMEOUT_MS = 9000    // Auto-end session on silence
DEFAULT_CONTEXT_WINDOW_LENGTH = 8   // Message pairs retained
```

**Performance pattern:** All latency-sensitive state uses `useRef` instead of `useState` to avoid re-renders. Audio processing uses the native thread via executorch worklets.

## Model Loader (`services/ModelLoader.ts`)

- Downloads models from HuggingFace on first run (during onboarding)
- Caches to `models/` directory; validates files are not HTML error pages
- Deduplicates concurrent download requests via an in-flight map
- Supports resumable downloads via `FileSystem.createDownloadResumable()`
- `ensureModelExists(model)` — main entry point; returns URI paths for hooks
- `downloadAllModels(onProgress, onStatus)` — orchestrates full download with weighted progress

## Persona & Scenario System

Each practice session randomly assigns:
- **Gender** (M/F) and matching **Kokoro voice** (3 male, 3 female voice files)
- **Speaking style**: calm, energetic, thoughtful, witty, direct
- **Scenario**: `small_talk`, `making_friends`, `job_interview`, `dating`

The system prompt enforces brevity (<15 words/response), filler words, contractions, and casual phonetics for natural-sounding voice conversation.

## Tavus Integration (`chat.tsx`)

Uses Daily.co WebRTC for the video chat tab. The API key and replica/persona IDs are currently placeholders (`REPLACE_WITH_YOUR_TAVUS_API_KEY`).

## Path Aliases

`@/*` maps to the root directory (configured in `tsconfig.json`).
