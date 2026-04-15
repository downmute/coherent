#!/usr/bin/env bash
set -euo pipefail

SOULX_DIR="${SOULX_DIR:-/opt/SoulX-FlashHead}"
SOULX_REPO_URL="${SOULX_REPO_URL:-}"
SOULX_REPO_REF="${SOULX_REPO_REF:-}"
SOULX_VENV_DIR="${SOULX_VENV_DIR:-/opt/soulx-venv}"
TORCH_INDEX_URL="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu128}"
TORCH_VERSION="${TORCH_VERSION:-2.7.1}"
TORCHVISION_VERSION="${TORCHVISION_VERSION:-0.22.1}"
FLASH_ATTN_VERSION="${FLASH_ATTN_VERSION:-2.8.0.post2}"
SAGEATTENTION_VERSION="${SAGEATTENTION_VERSION:-2.2.0}"
SOULX_RUNTIME_MODE="${SOULX_RUNTIME_MODE:-mock}"
SOULX_START_MODE="${SOULX_START_MODE:-service}"
SOULX_INFERENCE_SCRIPT="${SOULX_INFERENCE_SCRIPT:-inference_script_single_gpu_lite.sh}"
SOULX_INFERENCE_COMMAND="${SOULX_INFERENCE_COMMAND:-}"
SOULX_PRESTART_COMMAND="${SOULX_PRESTART_COMMAND:-}"
INSTALL_SOULX_EDITABLE="${INSTALL_SOULX_EDITABLE:-false}"
WORKER_START_COMMAND="${WORKER_START_COMMAND:-npm run start:worker}"

ensure_python_env() {
  if [[ -x "${SOULX_VENV_DIR}/bin/python" ]]; then
    echo "[bootstrap] Reusing existing virtualenv at ${SOULX_VENV_DIR}"
  else
    echo "[bootstrap] Creating virtualenv at ${SOULX_VENV_DIR}"
    python3 -m venv "${SOULX_VENV_DIR}"
  fi

  # Some restarts previously re-ran ensurepip implicitly via venv recreation and got stuck.
  # Only bootstrap pip if it is actually missing from the environment.
  if [[ ! -x "${SOULX_VENV_DIR}/bin/pip" ]]; then
    echo "[bootstrap] Bootstrapping pip inside ${SOULX_VENV_DIR}"
    "${SOULX_VENV_DIR}/bin/python" -m ensurepip --upgrade || true
  fi

  # shellcheck disable=SC1091
  source "${SOULX_VENV_DIR}/bin/activate"
}

should_skip_download() {
  local target_dir="$1"
  if [[ ! -d "${target_dir}" ]]; then
    return 1
  fi

  if find "${target_dir}" -mindepth 1 -maxdepth 2 | read -r _; then
    return 0
  fi

  return 1
}

download_hf_repo() {
  local repo_id="$1"
  local target_dir="$2"
  local exclude_patterns="${3:-}"

  if should_skip_download "${target_dir}"; then
    echo "[bootstrap] Reusing existing model assets in ${target_dir}"
    return
  fi

  mkdir -p "${target_dir}"
  echo "[bootstrap] Downloading model ${repo_id} to ${target_dir}"
  if [[ -n "${exclude_patterns}" ]]; then
    IFS=',' read -r -a exclude_array <<< "${exclude_patterns}"
    local args=()
    for pattern in "${exclude_array[@]}"; do
      if [[ -n "${pattern}" ]]; then
        args+=(--exclude "${pattern}")
      fi
    done
    huggingface-cli download "${repo_id}" --local-dir "${target_dir}" "${args[@]}"
    return
  fi

  huggingface-cli download "${repo_id}" --local-dir "${target_dir}"
}

install_soulx_requirements() {
  local requirements_file="$1"

  if [[ "${SKIP_SOULX_NCCL_PIN:-true}" == "true" ]]; then
    local filtered_requirements
    filtered_requirements="$(mktemp)"
    grep -v '^nvidia-nccl-cu12==' "${requirements_file}" > "${filtered_requirements}"
    echo "[bootstrap] Installing SoulX requirements without pinned nvidia-nccl-cu12"
    python -m pip install -r "${filtered_requirements}"
    rm -f "${filtered_requirements}"
    return
  fi

  python -m pip install -r "${requirements_file}"
}

echo "[bootstrap] Starting SoulX worker bootstrap..."

if [[ "${SOULX_RUNTIME_MODE}" == "mock" ]]; then
  echo "[bootstrap] SOULX_RUNTIME_MODE=mock, skipping SoulX clone/install/model bootstrap."
else
  if [[ -n "${SOULX_REPO_URL}" && ! -d "${SOULX_DIR}" ]]; then
    echo "[bootstrap] Cloning SoulX repo from ${SOULX_REPO_URL}"
    git clone "${SOULX_REPO_URL}" "${SOULX_DIR}"
  fi

  if [[ -n "${SOULX_REPO_REF}" && -d "${SOULX_DIR}" ]]; then
    echo "[bootstrap] Checking out SoulX ref ${SOULX_REPO_REF}"
    git -C "${SOULX_DIR}" fetch --all --tags
    git -C "${SOULX_DIR}" checkout "${SOULX_REPO_REF}"
  fi

  ensure_python_env

  python -m pip install --upgrade pip setuptools wheel
  python -m pip install \
    "torch==${TORCH_VERSION}" \
    "torchvision==${TORCHVISION_VERSION}" \
    --index-url "${TORCH_INDEX_URL}"

  if [[ -d "${SOULX_DIR}" ]]; then
    echo "[bootstrap] Installing SoulX Python dependencies from ${SOULX_DIR}"

    if [[ -f "${SOULX_DIR}/requirements.txt" ]]; then
      install_soulx_requirements "${SOULX_DIR}/requirements.txt"
    fi

    python -m pip install ninja "huggingface_hub[cli]"

    if [[ "${INSTALL_FLASH_ATTN:-true}" == "true" ]]; then
      python -m pip install "flash_attn==${FLASH_ATTN_VERSION}" --no-build-isolation
    fi

    if [[ "${INSTALL_SAGEATTENTION:-false}" == "true" ]]; then
      python -m pip install "sageattention==${SAGEATTENTION_VERSION}" --no-build-isolation
    fi

    if [[ "${INSTALL_SOULX_EDITABLE}" == "true" && -f "${SOULX_DIR}/pyproject.toml" ]]; then
      python -m pip install -e "${SOULX_DIR}"
    fi

    if [[ -n "${SOULX_MODEL_ID:-}" ]]; then
      MODEL_TARGET_DIR="${SOULX_MODEL_TARGET_DIR:-${SOULX_DIR}/models/SoulX-FlashHead-1_3B}"
      MODEL_EXCLUDE_PATTERNS="${SOULX_MODEL_EXCLUDE_PATTERNS:-Model_Pro/*}"
      download_hf_repo "${SOULX_MODEL_ID}" "${MODEL_TARGET_DIR}" "${MODEL_EXCLUDE_PATTERNS}"
    fi

    if [[ -n "${SOULX_WAV2VEC_MODEL_ID:-}" ]]; then
      WAV2VEC_TARGET_DIR="${SOULX_WAV2VEC_TARGET_DIR:-${SOULX_DIR}/models/wav2vec2-base-960h}"
      download_hf_repo "${SOULX_WAV2VEC_MODEL_ID}" "${WAV2VEC_TARGET_DIR}"
    fi
  fi
fi

export WORKER_BROWSER_EXECUTABLE_PATH="${WORKER_BROWSER_EXECUTABLE_PATH:-/usr/bin/google-chrome}"
export WORKER_RTC_PUBLISHER="${WORKER_RTC_PUBLISHER:-browser}"
if [[ -d "${SOULX_VENV_DIR}" ]]; then
  export PATH="${SOULX_VENV_DIR}/bin:${PATH}"
fi
if [[ -d "${SOULX_DIR}" ]]; then
  export PYTHONPATH="${SOULX_DIR}:${PYTHONPATH:-}"
fi

echo "[bootstrap] Using browser publisher executable: ${WORKER_BROWSER_EXECUTABLE_PATH}"

if [[ -n "${SOULX_PRESTART_COMMAND}" ]]; then
  echo "[bootstrap] Running prestart command: ${SOULX_PRESTART_COMMAND}"
  bash -lc "${SOULX_PRESTART_COMMAND}"
fi

if [[ "${SOULX_START_MODE}" == "repo-infer" ]]; then
  if [[ ! -d "${SOULX_DIR}" ]]; then
    echo "[bootstrap] SOULX_START_MODE=repo-infer requires SOULX_REPO_URL or a mounted repo at ${SOULX_DIR}" >&2
    exit 1
  fi

  cd "${SOULX_DIR}"

  if [[ -n "${SOULX_INFERENCE_COMMAND}" ]]; then
    echo "[bootstrap] Launching custom SoulX inference command: ${SOULX_INFERENCE_COMMAND}"
    exec bash -lc "${SOULX_INFERENCE_COMMAND}"
  fi

  if [[ ! -f "${SOULX_INFERENCE_SCRIPT}" ]]; then
    echo "[bootstrap] Could not find inference script ${SOULX_INFERENCE_SCRIPT} in ${SOULX_DIR}" >&2
    exit 1
  fi

  echo "[bootstrap] Launching SoulX inference script: ${SOULX_INFERENCE_SCRIPT}"
  exec bash "${SOULX_INFERENCE_SCRIPT}"
fi

echo "[bootstrap] Launching integrated worker with command: ${WORKER_START_COMMAND}"
exec bash -lc "${WORKER_START_COMMAND}"
