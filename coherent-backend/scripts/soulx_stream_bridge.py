#!/usr/bin/env python3
import argparse
import base64
import io
import json
import os
import sys
from collections import deque

DEFAULT_SOULX_DIR = os.environ.get("SOULX_DIR", "/opt/SoulX-FlashHead")
if DEFAULT_SOULX_DIR not in sys.path:
    sys.path.insert(0, DEFAULT_SOULX_DIR)
os.chdir(DEFAULT_SOULX_DIR)

import imageio
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
    return parser.parse_args()


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def decode_pcm(base64_chunk, sample_rate, channels, pcm_format, target_sample_rate):
    raw = base64.b64decode(base64_chunk)
    if pcm_format == "f32le":
      audio = np.frombuffer(raw, dtype="<f4")
    else:
      audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)

    if sample_rate != target_sample_rate:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=target_sample_rate)

    return audio.astype(np.float32)


def encode_frames(frames):
    encoded = []
    for frame in frames:
        array = np.asarray(frame).astype(np.uint8)
        buffer = io.BytesIO()
        imageio.imwrite(buffer, array, format="png")
        encoded.append("data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii"))
    return encoded


def run_inference_and_emit(
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
        return

    frames = video.cpu().numpy()
    emit({
        "type": "stats",
        "frames": int(frames.shape[0]),
        "samplesBuffered": int(audio_array.shape[0]),
        "samplesPending": int(pending_audio.shape[0]),
    })
    emit({"type": "frames", "frames": encode_frames(frames)})


def main():
    args = parse_args()

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

    audio_dq = deque([0.0] * cached_audio_length_sum, maxlen=cached_audio_length_sum)
    pending_audio = np.zeros((0,), dtype=np.float32)

    emit({"type": "ready"})

    for line in sys.stdin:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            emit({"type": "error", "message": "Invalid JSON sent to SoulX bridge."})
            continue

        if message.get("type") == "close":
            break

        if message.get("type") == "audio_end":
            if pending_audio.shape[0] > 0:
                padded_audio = np.pad(
                    pending_audio,
                    (0, human_speech_array_slice_len - pending_audio.shape[0]),
                    mode="constant",
                ).astype(np.float32)
                pending_audio = np.zeros((0,), dtype=np.float32)
                run_inference_and_emit(
                    pipeline,
                    audio_dq,
                    padded_audio,
                    pending_audio,
                    audio_start_idx,
                    audio_end_idx,
                    motion_frames_num,
                )
            emit({"type": "audio_end_ack"})
            continue

        if message.get("type") != "audio_chunk":
            continue

        try:
            chunk = decode_pcm(
                message["pcmBase64"],
                int(message["sampleRate"]),
                int(message["channels"]),
                message["format"],
                sample_rate,
            )
        except Exception as error:
            emit({"type": "error", "message": f"Failed to decode PCM chunk: {error}"})
            continue

        pending_audio = np.concatenate([pending_audio, chunk])
        while pending_audio.shape[0] >= human_speech_array_slice_len:
            audio_slice = pending_audio[:human_speech_array_slice_len]
            pending_audio = pending_audio[human_speech_array_slice_len:]
            run_inference_and_emit(
                pipeline,
                audio_dq,
                audio_slice,
                pending_audio,
                audio_start_idx,
                audio_end_idx,
                motion_frames_num,
            )


if __name__ == "__main__":
    main()
