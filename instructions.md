# Project Instructions: Coherent (MVP)

## 1. Project Overview
We are building "Coherent," a high-performance mobile app that uses real-time computer vision and audio analysis to coach users on social skills (eye contact, speaking pace, filler words).

**Critical Constraint:** This app requires heavy real-time processing (30 FPS video analysis). Do NOT suggest standard "Expo Go" workflows. We are using **Expo Managed Workflow with Prebuild (CNG)** and native modules.

## 2. The "Pro" Tech Stack
You must stick to these specific libraries to ensure performance:
* **Framework:** React Native + Expo SDK 50+ (Managed Workflow).
* **Language:** TypeScript (Strict Mode).
* **Navigation:** Expo Router (File-based routing).
* **Styling:** NativeWind (Tailwind CSS) + `clsx`.
* **State Management:** Zustand (for high-frequency UI updates).
* **Computer Vision:** `react-native-vision-camera` (v4) + `react-native-worklets-core`.
* **ML Runtime:** `react-native-fast-tflite` (GPU acceleration for MediaPipe).
* **Graphics:** `@shopify/react-native-skia` (High-performance overlays).
* **Audio Intelligence:** Deepgram API (via WebSocket, NOT Web Speech API).
* **Video Generation:** Tavus API (Replica).

## 3. Architecture & Folder Structure
We use a **Feature-Sliced Architecture** to separate high-performance logic from UI.

```text
/src
├── /app                    # Expo Router pages
│   ├── _layout.tsx         # Root provider
│   ├── (tabs)              # Main dashboard
│   └── /session
│       └── [id].tsx        # The Active Training Session (Camera + Overlay)
│
├── /core                   # Utilities & Config
│   ├── /hooks              # usePermissions, useAppState
│   └── /store              # Zustand stores (useSessionStore, useUserStore)
│
├── /services               # API Integrations
│   ├── /deepgram           # WebSocket client for real-time transcription
│   ├── /tavus              # Avatar video stream handling
│   └── /mediapipe          # Face mesh landmark logic
│
├── /features               # Business Logic Modules
│   ├── /eye-contact
│   │   ├── FrameProcessor.ts   # WORKLET: Runs on UI thread (Vision Camera)
│   │   ├── algorithms.ts       # Gaze tracking math (Vector calculation)
│   │   └── EyeTrackingOverlay.tsx
│   ├── /voice-analysis
│   │   ├── logic.ts            # WPM calculator, Filler word counter
│   │   └── FeedbackToast.tsx   # "Slow down" UI alerts
│   └── /confidence-score
│       └── calculator.ts       # The weighted "Confidence Index" formula
│
└── /components             # Shared UI (Buttons, Cards, Headers)

## 4. Critical Implementation Rules
A. Vision Camera & Worklets (The "No Bridge" Rule)

    All frame processing must happen inside a Worklet.

    NEVER send the entire frame buffer to the JS thread.

    Calculate the "Gaze Vector" inside the worklet, and runOnJS only the result (e.g., isLookingAtCamera: boolean) to update the UI.

B. Audio Analysis (Deepgram)

    Do not use the native microphone recorder for file storage.

    Stream raw audio bytes directly to Deepgram's WebSocket endpoint.

    Enable interim_results to detect when the user is currently speaking vs. finished.

C. The Confidence Algorithm

Implement the proprietary "Confidence Index" (CI) using this weighted formula:
CI=(0.4×Vs​)+(0.4×Gs​)+(0.2×Ss​)

    Vocal Stability (Vs​):

        Target WPM: 130–160.

        Penalty: -5 pts per "um/uh" (detected by Deepgram).

    Gaze Stability (Gs​):

        Target: "Visual Dominance Ratio" ≈ 1.0 (Maintain eye contact while speaking).

        Hit Box: Top 30% of screen (accounting for camera parallax).

    Baseline Calibration:

        Scores are relative to the user's calibration baseline (captured in onboarding), not a generic constant.

## 5. Development Workflow

    Prebuild: If adding native deps, run npx expo prebuild --clean.

    Run: Always use npx expo run:ios or npx expo run:android.

    Do not use expo start (Expo Go) as it will crash on the native CV modules.