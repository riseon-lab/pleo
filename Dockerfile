# Pleo — RunPod container.
# Heavy, stable layers (CUDA, torch) are baked in; the app code itself is
# pulled from git at boot so day-to-day updates never need an image rebuild.
# CUDA 12.8 so torch cu128 kernels cover Blackwell GPUs (RTX 50xx, B200)
# as well as Ada/Hopper. cu124 builds have no sm_120 kernels and die with
# "no kernel image is available for execution on the device".
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3.11-dev python3-pip \
    git curl ca-certificates \
    libgl1 libglib2.0-0 \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Pre-cache torch/torchvision system-wide; model venvs are created with
# --system-site-packages so they share this install.
RUN python3 -m pip install --upgrade pip && \
    python3 -m pip install torch==2.9.1 torchvision==0.24.1 \
    --index-url https://download.pytorch.org/whl/cu128

# Backend deps (small).
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m pip install -r /tmp/requirements.txt

COPY docker/start.sh /start.sh
RUN chmod +x /start.sh

# App repo cloned/updated at boot into /workspace (persistent volume) so
# `git pull` from the Settings page survives across pods.
ENV PLEO_REPO="https://github.com/riseon-lab/pleo.git" \
    PLEO_BRANCH="main" \
    PLEO_DIR="/workspace/pleo" \
    PLEO_DATA="/workspace/pleo-data" \
    PLEO_MOCK="0"

EXPOSE 3000
CMD ["/start.sh"]
