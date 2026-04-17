#!/usr/bin/env python3
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import wave
from collections import deque

DEFAULT_SOULX_DIR = os.environ.get("SOULX_DIR", "/opt/SoulX-FlashHead")
if DEFAULT_SOULX_DIR not in sys.path:
    sys.path.insert(0, DEFAULT_SOULX_DIR)
os.chdir(DEFAULT_SOULX_DIR)

import imageio.v2 as imageio
import librosa
import numpy as np
import torch

from flash_head.inference import (
    get_audio_embedding,
    get_base_data,
    get_infer_params,
    get_pipeline,
    run_pipeline,
)


def parse_args():
    parser = argparse.ArgumentParser(description="Stream PCM chunks into SoulX-FlashHead and emit frames.")
    parser.add_argument("--ckpt_dir", required=True)
    parser.add_argument("--wav2vec_dir", required=True)
    parser.add_argument("--model_type", required=True, choices=["lite", "pro"])
    parser.add_argument("--cond_image", required=True)
    parser.add_argument("--base_seed", type=int, default=9999)
    parser.add_argument("--use_face_crop", type=str, default="false")
    parser.add_argument("--output_dir", required=True)
    parser.add_argument("--chunks_per_segment", type=int, default=3)
    return parser.parse_args()


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def log_debug(message):
    print(message, file=sys.stderr, flush=True)


def read_exact(buffer, byte_length):
    if byte_length <= 0:
        return b""

    chunks = bytearray()
    remaining = byte_length
    while remaining > 0:
        chunk = buffer.read(remaining)
        if not chunk:
            break
        chunks.extend(chunk)
        remaining -= len(chunk)
    return bytes(chunks)


def read_framed_message(buffer):
    header_length_bytes = read_exact(buffer, 4)
    if len(header_length_bytes) == 0:
        return None
    if len(header_length_bytes) != 4:
        raise ValueError(f"Incomplete frame header length prefix: got {len(header_length_bytes)} byte(s)")

    binary_length_bytes = read_exact(buffer, 4)
    if len(binary_length_bytes) != 4:
        raise ValueError(f"Incomplete frame binary length prefix: got {len(binary_length_bytes)} byte(s)")

    header_length = int.from_bytes(header_length_bytes, byteorder="big", signed=False)
    binary_length = int.from_bytes(binary_length_bytes, byteorder="big", signed=False)

    header_bytes = read_exact(buffer, header_length)
    if len(header_bytes) != header_length:
        raise ValueError(
            f"Incomplete frame header: expected {header_length} byte(s) and received {len(header_bytes)}"
        )

    binary_bytes = read_exact(buffer, binary_length)
    if len(binary_bytes) != binary_length:
        raise ValueError(
            f"Incomplete frame payload: expected {binary_length} byte(s) and received {len(binary_bytes)}"
        )

    return header_bytes, binary_bytes


def decode_pcm(base64_chunk, sample_rate, channels, pcm_format, target_sample_rate):
    normalized = str(base64_chunk).strip()
    normalized = normalized.replace("-", "+").replace("_", "/")
    padding = (-len(normalized)) % 4
    if padding:
        normalized += "=" * padding

    raw = base64.b64decode(normalized)
    if pcm_format == "f32le":
      remainder = len(raw) % 4
      if remainder:
          raw = raw[: len(raw) - remainder]
      audio = np.frombuffer(raw, dtype="<f4")
    else:
      remainder = len(raw) % 2
      if remainder:
          raw = raw[: len(raw) - remainder]
      audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    if sample_rate != target_sample_rate:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=target_sample_rate)

    return audio.astype(np.float32)


def decode_pcm_bytes(raw, sample_rate, channels, pcm_format, target_sample_rate):
    if pcm_format == "f32le":
      remainder = len(raw) % 4
      if remainder:
          raw = raw[: len(raw) - remainder]
      audio = np.frombuffer(raw, dtype="<f4")
    else:
      remainder = len(raw) % 2
      if remainder:
          raw = raw[: len(raw) - remainder]
      audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    if sample_rate != target_sample_rate:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=target_sample_rate)

    return audio.astype(np.float32)


def run_inference(
    pipeline,
    audio_dq,
    audio_slice,
    pending_audio,
    audio_start_idx,
    audio_end_idx,
    motion_frames_num,
):
    audio_dq.extend(audio_slice.tolist())
    audio_array = np.array(audio_dq, dtype=np.float32)

    try:
        audio_embedding = get_audio_embedding(pipeline, audio_array, audio_start_idx, audio_end_idx)
        torch.cuda.synchronize()
        video = run_pipeline(pipeline, audio_embedding)
        video = video[motion_frames_num:]
        torch.cuda.synchronize()
    except Exception as error:
        emit({"type": "error", "message": f"SoulX inference failed: {error}"})
        return None

    frames = video.cpu().numpy()
    emit({
        "type": "stats",
        "frames": int(frames.shape[0]),
        "samplesBuffered": int(audio_array.shape[0]),
        "samplesPending": int(pending_audio.shape[0]),
    })
    return frames


def write_wav(audio, sample_rate, output_path):
    pcm = np.clip(audio, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype(np.int16)
    with wave.open(str(output_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())


def write_video(frames, fps, output_path):
    writer = imageio.get_writer(
        str(output_path),
        fps=fps,
        codec="libx264",
        format="FFMPEG",
        macro_block_size=None,
        ffmpeg_log_level="error",
        ffmpeg_params=["-pix_fmt", "yuv420p"],
    )
    try:
        for frame in frames:
            writer.append_data(np.asarray(frame).astype(np.uint8))
    finally:
        writer.close()


def flush_segment(
    segment_index,
    segment_frames,
    segment_audio,
    output_dir,
    tgt_fps,
    sample_rate,
    is_final,
):
    if not segment_frames or not segment_audio:
        log_debug(
            f"[bridge] flush_segment skipped index={segment_index} final={is_final} "
            f"frames={len(segment_frames)} audio={len(segment_audio)}"
        )
        return segment_index

    combined_frames = np.concatenate(segment_frames, axis=0)
    combined_audio = np.concatenate(segment_audio, axis=0)
    segment_stem = f"segment_{segment_index:04d}"
    raw_video_path = output_dir / f"{segment_stem}_video.mp4"
    audio_path = output_dir / f"{segment_stem}.wav"
    output_path = output_dir / f"{segment_stem}.mp4"

    log_debug(
        f"[bridge] flush_segment start index={segment_index} final={is_final} "
        f"frameCount={combined_frames.shape[0]} audioSamples={combined_audio.shape[0]}"
    )

    try:
        write_video(combined_frames, tgt_fps, raw_video_path)
        write_wav(combined_audio, sample_rate, audio_path)
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(raw_video_path),
                "-i",
                str(audio_path),
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-shortest",
                str(output_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        _ = result
    except subprocess.CalledProcessError as error:
        emit({"type": "error", "message": f"ffmpeg segment mux failed: {error.stderr.strip() or error}"})
        return segment_index
    finally:
        if raw_video_path.exists():
            raw_video_path.unlink()
        if audio_path.exists():
            audio_path.unlink()

    emit({
        "type": "segment",
        "segmentIndex": int(segment_index),
        "path": str(output_path),
        "final": bool(is_final),
        "durationSeconds": float(combined_audio.shape[0] / sample_rate),
        "frames": int(combined_frames.shape[0]),
    })
    log_debug(
        f"[bridge] flush_segment done index={segment_index} final={is_final} output={output_path.name}"
    )
    return segment_index + 1


def create_stream_state(cached_audio_length_sum):
    return {
        "audio_dq": deque([0.0] * cached_audio_length_sum, maxlen=cached_audio_length_sum),
        "pending_audio": np.zeros((0,), dtype=np.float32),
        "segment_frames": [],
        "segment_audio": [],
        "chunks_in_segment": 0,
        "segment_index": 0,
    }


def main():
    args = parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    pipeline = get_pipeline(
        world_size=1,
        ckpt_dir=args.ckpt_dir,
        wav2vec_dir=args.wav2vec_dir,
        model_type=args.model_type,
    )
    get_base_data(
        pipeline,
        cond_image_path_or_dir=args.cond_image,
        base_seed=args.base_seed,
        use_face_crop=args.use_face_crop.lower() == "true",
    )

    infer_params = get_infer_params()
    sample_rate = infer_params["sample_rate"]
    tgt_fps = infer_params["tgt_fps"]
    cached_audio_duration = infer_params["cached_audio_duration"]
    frame_num = infer_params["frame_num"]
    motion_frames_num = infer_params["motion_frames_num"]
    slice_len = frame_num - motion_frames_num
    human_speech_array_slice_len = slice_len * sample_rate // tgt_fps
    cached_audio_length_sum = sample_rate * cached_audio_duration
    audio_end_idx = cached_audio_duration * tgt_fps
    audio_start_idx = audio_end_idx - frame_num

    stream_state = create_stream_state(cached_audio_length_sum)
    current_output_dir = output_dir
    current_chunks_per_segment = max(1, int(args.chunks_per_segment))

    emit({"type": "ready"})

    stdin_buffer = sys.stdin.buffer

    while True:
        try:
            frame = read_framed_message(stdin_buffer)
        except Exception as error:
            emit({
                "type": "error",
                "message": f"Invalid framed message sent to SoulX bridge: {error}",
            })
            break

        if frame is None:
            break

        header_bytes, binary_bytes = frame
        line = header_bytes.decode("utf-8", errors="replace")
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            preview = line[:180]
            emit({
                "type": "error",
                "message": (
                    f"Invalid JSON sent to SoulX bridge. "
                    f"lineLen={len(line)} binaryLen={len(binary_bytes)} preview={preview!r}"
                ),
            })
            continue

        if not isinstance(message, dict):
            emit({
                "type": "error",
                "message": (
                    f"Invalid message type sent to SoulX bridge. "
                    f"jsonType={type(message).__name__} lineLen={len(line)} binaryLen={len(binary_bytes)}"
                ),
            })
            continue

        if message.get("type") == "close":
            break

        if message.get("type") == "reset":
            next_output_dir = message.get("outputDir")
            if isinstance(next_output_dir, str) and next_output_dir:
                current_output_dir = Path(next_output_dir)
                current_output_dir.mkdir(parents=True, exist_ok=True)
            next_chunks_per_segment = message.get("chunksPerSegment")
            if isinstance(next_chunks_per_segment, int) and next_chunks_per_segment > 0:
                current_chunks_per_segment = next_chunks_per_segment
            stream_state = create_stream_state(cached_audio_length_sum)
            emit({"type": "reset_ack"})
            continue

        if message.get("type") == "audio_end":
            log_debug(
                f"[bridge] audio_end received pendingSamples={stream_state['pending_audio'].shape[0]} "
                f"chunksInSegment={stream_state['chunks_in_segment']} segmentIndex={stream_state['segment_index']}"
            )
            pending_audio = stream_state["pending_audio"]
            if pending_audio.shape[0] > 0:
                log_debug(
                    f"[bridge] audio_end padding tail from {pending_audio.shape[0]} to {human_speech_array_slice_len} samples"
                )
                padded_audio = np.pad(
                    pending_audio,
                    (0, human_speech_array_slice_len - pending_audio.shape[0]),
                    mode="constant",
                ).astype(np.float32)
                stream_state["pending_audio"] = np.zeros((0,), dtype=np.float32)
                log_debug("[bridge] audio_end running tail inference")
                frames = run_inference(
                    pipeline,
                    stream_state["audio_dq"],
                    padded_audio,
                    stream_state["pending_audio"],
                    audio_start_idx,
                    audio_end_idx,
                    motion_frames_num,
                )
                log_debug(
                    f"[bridge] audio_end tail inference complete frames={0 if frames is None else int(frames.shape[0])}"
                )
                if frames is not None and frames.shape[0] > 0:
                    stream_state["segment_frames"].append(frames)
                    stream_state["segment_audio"].append(padded_audio)
                    stream_state["chunks_in_segment"] += 1
            if stream_state["chunks_in_segment"] > 0:
                log_debug(
                    f"[bridge] audio_end flushing final segment index={stream_state['segment_index']} "
                    f"chunks={stream_state['chunks_in_segment']}"
                )
                stream_state["segment_index"] = flush_segment(
                    stream_state["segment_index"],
                    stream_state["segment_frames"],
                    stream_state["segment_audio"],
                    current_output_dir,
                    tgt_fps,
                    sample_rate,
                    True,
                )
                stream_state["segment_frames"] = []
                stream_state["segment_audio"] = []
                stream_state["chunks_in_segment"] = 0
            else:
                log_debug("[bridge] audio_end had no segment frames to flush")
            emit({"type": "audio_end_ack"})
            log_debug("[bridge] audio_end ack emitted")
            continue

        if message.get("type") == "audio_chunk_binary":
            try:
                byte_length = int(message["byteLength"])
                if byte_length < 0:
                    raise ValueError("byteLength must be non-negative")
                raw_chunk = binary_bytes
                if len(raw_chunk) != byte_length:
                    raise ValueError(
                        f"Expected {byte_length} bytes of PCM data but received {len(raw_chunk)}"
                    )
                chunk = decode_pcm_bytes(
                    raw_chunk,
                    int(message["sampleRate"]),
                    int(message["channels"]),
                    message["format"],
                    sample_rate,
                )
            except Exception as error:
                emit({
                    "type": "error",
                    "message": (
                        f"Failed to decode binary PCM chunk seq={message.get('sequence')} "
                        f"byteLength={message.get('byteLength')}: {error}"
                    ),
                })
                continue
        elif message.get("type") == "audio_chunk":
            try:
                chunk = decode_pcm(
                    message["pcmBase64"],
                    int(message["sampleRate"]),
                    int(message["channels"]),
                    message["format"],
                    sample_rate,
                )
            except Exception as error:
                raw_pcm = str(message.get("pcmBase64", ""))
                normalized = raw_pcm.strip().replace("-", "+").replace("_", "/")
                emit({
                    "type": "error",
                    "message": (
                        f"Failed to decode PCM chunk seq={message.get('sequence')} "
                        f"rawLen={len(raw_pcm)} normalizedLen={len(normalized)} "
                        f"mod4={len(normalized) % 4}: {error}"
                    ),
                })
                continue
        else:
            continue

        stream_state["pending_audio"] = np.concatenate([stream_state["pending_audio"], chunk])
        while stream_state["pending_audio"].shape[0] >= human_speech_array_slice_len:
            audio_slice = stream_state["pending_audio"][:human_speech_array_slice_len]
            stream_state["pending_audio"] = stream_state["pending_audio"][human_speech_array_slice_len:]
            frames = run_inference(
                pipeline,
                stream_state["audio_dq"],
                audio_slice,
                stream_state["pending_audio"],
                audio_start_idx,
                audio_end_idx,
                motion_frames_num,
            )
            if frames is None or frames.shape[0] == 0:
                continue
            stream_state["segment_frames"].append(frames)
            stream_state["segment_audio"].append(audio_slice)
            stream_state["chunks_in_segment"] += 1
            if stream_state["chunks_in_segment"] >= current_chunks_per_segment:
                stream_state["segment_index"] = flush_segment(
                    stream_state["segment_index"],
                    stream_state["segment_frames"],
                    stream_state["segment_audio"],
                    current_output_dir,
                    tgt_fps,
                    sample_rate,
                    False,
                )
                stream_state["segment_frames"] = []
                stream_state["segment_audio"] = []
                stream_state["chunks_in_segment"] = 0


if __name__ == "__main__":
    main()
