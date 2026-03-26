#!/usr/bin/env python3
import argparse
import base64
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(
        description="Spawn soulx_stream_bridge.py, stream chunked audio into it, and report frame output."
    )
    parser.add_argument("--python-bin", default=os.environ.get("SOULX_PYTHON_BIN", "/opt/soulx-venv/bin/python"))
    parser.add_argument(
        "--bridge-script",
        default=os.environ.get("SOULX_BRIDGE_SCRIPT", "/app/scripts/soulx_stream_bridge.py"),
    )
    parser.add_argument("--ckpt-dir", required=True)
    parser.add_argument("--wav2vec-dir", required=True)
    parser.add_argument("--model-type", default="lite", choices=["lite", "pro"])
    parser.add_argument("--cond-image", required=True)
    parser.add_argument("--audio-file", required=True)
    parser.add_argument("--sample-rate", type=int, default=16000)
    parser.add_argument("--channels", type=int, default=1)
    parser.add_argument("--format", default="s16le", choices=["s16le", "f32le"])
    parser.add_argument("--chunk-bytes", type=int, default=16000)
    parser.add_argument("--chunk-interval-ms", type=int, default=700)
    parser.add_argument("--max-chunks", type=int, default=3)
    parser.add_argument("--wait-ready-timeout", type=float, default=120.0)
    parser.add_argument("--drain-timeout", type=float, default=180.0)
    parser.add_argument("--process-exit-timeout", type=float, default=60.0)
    parser.add_argument("--save-first-frame", default=None)
    parser.add_argument("--base-seed", type=int, default=9999)
    parser.add_argument("--use-face-crop", default="false")
    return parser.parse_args()


def enqueue_stream(stream, sink_queue, prefix):
    for line in iter(stream.readline, ""):
        sink_queue.put((prefix, line.rstrip("\n")))
    sink_queue.put((prefix, None))


def convert_audio_if_needed(audio_file, sample_rate, channels, pcm_format):
    source = Path(audio_file)
    if source.suffix.lower() == ".raw":
        return str(source), None

    temp = tempfile.NamedTemporaryFile(prefix="coherent-soulx-", suffix=".raw", delete=False)
    temp.close()
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(source),
        "-f",
        pcm_format,
        "-ac",
        str(channels),
        "-ar",
        str(sample_rate),
        temp.name,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg conversion failed:\n{result.stderr}")
    return temp.name, temp.name


def main():
    args = parse_args()
    resolved_audio_path, temp_audio_path = convert_audio_if_needed(
        args.audio_file, args.sample_rate, args.channels, args.format
    )

    cmd = [
        args.python_bin,
        args.bridge_script,
        "--ckpt_dir",
        args.ckpt_dir,
        "--wav2vec_dir",
        args.wav2vec_dir,
        "--model_type",
        args.model_type,
        "--cond_image",
        args.cond_image,
        "--base_seed",
        str(args.base_seed),
        "--use_face_crop",
        args.use_face_crop,
    ]

    print("Launching bridge:")
    print(" ".join(cmd))

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    sink_queue = queue.Queue()
    stdout_thread = threading.Thread(
        target=enqueue_stream, args=(proc.stdout, sink_queue, "stdout"), daemon=True
    )
    stderr_thread = threading.Thread(
        target=enqueue_stream, args=(proc.stderr, sink_queue, "stderr"), daemon=True
    )
    stdout_thread.start()
    stderr_thread.start()

    ready = False
    frame_messages = 0
    total_frames = 0
    first_frame_saved = False
    first_frame_path = None

    try:
        deadline = time.time() + args.wait_ready_timeout
        while time.time() < deadline:
            try:
                source, line = sink_queue.get(timeout=0.5)
            except queue.Empty:
                if proc.poll() is not None:
                    raise RuntimeError(f"Bridge exited before ready with code {proc.returncode}.")
                continue

            if line is None:
                continue

            if source == "stderr":
                print(f"[bridge-stderr] {line}")
                continue

            print(f"[bridge-stdout] {line}")
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue

            if payload.get("type") == "ready":
                ready = True
                break
            if payload.get("type") == "error":
                raise RuntimeError(payload.get("message", "Bridge emitted error before ready."))

        if not ready:
            raise RuntimeError("Timed out waiting for bridge ready message.")

        audio_bytes = Path(resolved_audio_path).read_bytes()
        for chunk_index in range(args.max_chunks):
            start = chunk_index * args.chunk_bytes
            if start >= len(audio_bytes):
                break
            chunk = audio_bytes[start : start + args.chunk_bytes]
            payload = {
                "type": "audio_chunk",
                "pcmBase64": base64.b64encode(chunk).decode("ascii"),
                "sampleRate": args.sample_rate,
                "channels": args.channels,
                "format": args.format,
            }
            assert proc.stdin is not None
            proc.stdin.write(json.dumps(payload) + "\n")
            proc.stdin.flush()
            print(
                f"sent chunk {chunk_index + 1} bytes={len(chunk)} intervalMs={args.chunk_interval_ms}"
            )
            time.sleep(args.chunk_interval_ms / 1000.0)

        assert proc.stdin is not None
        proc.stdin.write(json.dumps({"type": "close"}) + "\n")
        proc.stdin.flush()
        proc.stdin.close()

        drain_deadline = time.time() + args.drain_timeout
        while time.time() < drain_deadline:
            try:
                source, line = sink_queue.get(timeout=0.5)
            except queue.Empty:
                if proc.poll() is not None:
                    break
                continue

            if line is None:
                continue

            if source == "stderr":
                print(f"[bridge-stderr] {line}")
                continue

            print(f"[bridge-stdout] {line}")
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue

            payload_type = payload.get("type")
            if payload_type == "error":
                raise RuntimeError(payload.get("message", "Bridge emitted error during stream."))
            if payload_type == "stats":
                print(
                    "stats:"
                    f" frames={payload.get('frames')}"
                    f" buffered={payload.get('samplesBuffered')}"
                    f" pending={payload.get('samplesPending')}"
                )
            if payload_type == "frames":
                frames = payload.get("frames", [])
                frame_messages += 1
                total_frames += len(frames)
                print(f"frames message {frame_messages}: {len(frames)} frame(s)")
                if args.save_first_frame and frames and not first_frame_saved:
                    first = frames[0]
                    if first.startswith("data:image/png;base64,"):
                        png_bytes = base64.b64decode(first.split(",", 1)[1])
                        Path(args.save_first_frame).write_bytes(png_bytes)
                        first_frame_saved = True
                        first_frame_path = args.save_first_frame

        return_code = proc.wait(timeout=args.process_exit_timeout)
        if return_code != 0:
            raise RuntimeError(f"Bridge exited with code {return_code}.")

        print(f"summary: frameMessages={frame_messages} totalFrames={total_frames}")
        if first_frame_path:
            print(f"savedFirstFrame={first_frame_path}")
        if total_frames == 0:
            print("warning: no frames were emitted")

    finally:
        if proc.poll() is None:
            proc.kill()
        if temp_audio_path:
            Path(temp_audio_path).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
