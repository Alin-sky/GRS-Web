"""
WD14 标签器独立服务（动漫图片专用标签模型）
接收 base64 图片，返回 WD14 标签 + rating，供审核系统作为辅助判据调用。

启动: python wd14_service.py  (默认端口 9898)

模型加载策略（WD14_PRELOAD）：
  - 1（默认）异步预热：进程启动后立刻在后台线程加载模型，端口同时开始监听。
    带外请求在预热完成前会拿到「预热中」的明确答复，而不是超时。
  - 0        懒加载：首次 /tag 调用时才加载（旧行为，模型加载耗时计入首个请求）。
  - sync     同步预热：模型就绪后才开始服务请求（这期间调用方拿不到响应）。

环境变量：
  WD14_PRELOAD=1|0|sync    加载策略（默认 1）
  WD14_PRELOAD_MODEL=0     等价于 WD14_PRELOAD=0（兼容旧写法）
  WD14_WARMUP_WAIT_S       预热未完成时 /tag 最多等待秒数（默认 6，0=不等待）
  WD14_MODEL               模型名（默认 SwinV2_v3）
  WD14_PORT                端口（默认 9898）
"""
import os

# 优先使用国内 HuggingFace 镜像下载模型
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

import base64
import io
import threading
import time

from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel
from PIL import Image

from imgutils.tagging import get_wd14_tags

# 模型名：SwinV2_v3 为默认（准确率/速度平衡）；eva02-large 更准但更慢
MODEL_NAME = os.environ.get("WD14_MODEL", "SwinV2_v3")


def _preload_mode() -> str:
    """解析预热策略：'async' | 'lazy' | 'sync'。"""
    raw = str(os.environ.get("WD14_PRELOAD", "1")).strip().lower()
    # 兼容旧写法：WD14_PRELOAD_MODEL=0 表示关闭
    if str(os.environ.get("WD14_PRELOAD_MODEL", "")).strip() == "0" and "WD14_PRELOAD" not in os.environ:
        return "lazy"
    if raw in ("0", "false", "no", "off", "lazy"):
        return "lazy"
    if raw in ("sync", "blocking", "block"):
        return "sync"
    return "async"


PRELOAD_MODE = _preload_mode()

# ─── 预热状态（/health 与 /tag 都读它，单写点多读点）───
_STATE = {
    "phase": "idle",      # idle | loading | ready | error | skipped
    "error": "",
    "seconds": 0.0,
    "started_at": 0.0,
}
_STATE_LOCK = threading.Lock()
_READY_EVENT = threading.Event()
_WARMUP_THREAD = None


def _set_state(**kw):
    with _STATE_LOCK:
        _STATE.update(kw)


def _snapshot_state() -> dict:
    with _STATE_LOCK:
        return dict(_STATE)


def _load_model_blocking() -> float:
    """
    真实加载模型并返回耗时（秒）。

    刻意用一次**真实推理**（64x64 纯色图）而不是直接调用内部私有缓存函数：
    私有函数的 lru_cache 键与 get_wd14_tags 实际调用的键不完全一致，
    直接预热可能填不进真正被消费的缓存项。走完整推理可确保
    ONNX session / inv.npz 权重 / selected_tags.csv 标签表全部就位。
    """
    started = time.perf_counter()
    probe = Image.new("RGB", (64, 64), (0, 0, 0))
    get_wd14_tags(probe, model_name=MODEL_NAME)
    return time.perf_counter() - started


def _warmup_worker():
    """后台预热线程体。"""
    _set_state(phase="loading", error="", started_at=time.time())
    try:
        seconds = _load_model_blocking()
        _set_state(phase="ready", seconds=round(seconds, 3), error="")
        print(f"[WD14] 模型预热完成: {MODEL_NAME}（耗时 {seconds:.1f}s）")
    except Exception as e:  # 预热失败不致命：仍可懒加载重试
        _set_state(phase="error", error=str(e))
        print(f"[WD14] 模型预热失败（将退回懒加载）: {e}")
    finally:
        _READY_EVENT.set()


def _start_warmup(blocking: bool):
    """按策略启动预热。"""
    global _WARMUP_THREAD
    if PRELOAD_MODE == "lazy":
        _set_state(phase="skipped")
        _READY_EVENT.set()
        print("[WD14] 已按 WD14_PRELOAD=0 关闭启动预热（模型在首次 /tag 时加载）")
        return
    _WARMUP_THREAD = threading.Thread(target=_warmup_worker, name="wd14-warmup", daemon=True)
    _WARMUP_THREAD.start()
    if blocking:
        print(f"[WD14] 同步预热中，端口将在模型就绪后开始监听: {MODEL_NAME}")
        _WARMUP_THREAD.join()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _start_warmup(blocking=(PRELOAD_MODE == "sync"))
    yield


app = FastAPI(title="WD14 Tagger Service", version="1.1.0", lifespan=lifespan)


class TagRequest(BaseModel):
    image: str  # base64（不含 data: 前缀）


class TagResponse(BaseModel):
    success: bool
    rating: dict = {}
    general: dict = {}
    character: dict = {}
    model: str = MODEL_NAME
    error: str = ""
    # 预热未完成时为 true：调用方据此区分「服务临时未就绪」与「服务真故障」，
    # 不应把这种情况计入熔断失败次数。
    warming_up: bool = False


def _warmup_wait_s() -> float:
    try:
        return max(0.0, float(os.environ.get("WD14_WARMUP_WAIT_S", "6")))
    except ValueError:
        return 6.0


@app.get("/health")
def health():
    """
    服务与模型的双重状态。

    `ready` 是给调用方看的唯一权威布尔位：只有模型真正加载完成才为 true。
    `status` 取值 ok / loading / error / skipped，与 ready 保持同向。
    """
    st = _snapshot_state()
    phase = st["phase"]
    ready = _READY_EVENT.is_set() and phase != "error"
    if phase == "error":
        status = "error"
    elif ready:
        status = "ok"
    else:
        status = "loading"
    return {
        "status": status,
        "service": "ok",
        "ready": ready,
        "phase": phase,
        "model": MODEL_NAME,
        "model_loaded": ready,
        "loading": phase in ("idle", "loading"),
        "preload_mode": PRELOAD_MODE,
        "warmup_seconds": st["seconds"],
        "error": st["error"],
    }


@app.post("/tag", response_model=TagResponse)
def tag_image(req: TagRequest):
    # 预热未完成：最多等待 WD14_WARMUP_WAIT_S 秒，仍不成就如实回「预热中」。
    # 这样调用方既不会白等超时，也不会把正常的启动预热误判为服务故障。
    if not _READY_EVENT.is_set():
        st = _snapshot_state()
        if st["phase"] == "error":
            return TagResponse(
                success=False,
                error=f"模型预热失败: {st['error']}",
            )
        # lazy 模式下 _READY_EVENT 已在启动时置位，不会走到这里
        _READY_EVENT.wait(timeout=_warmup_wait_s())
        if not _READY_EVENT.is_set():
            return TagResponse(
                success=False,
                warming_up=True,
                error=f"模型预热中（{MODEL_NAME}），请稍后重试",
            )

    st = _snapshot_state()
    if st["phase"] == "error":
        return TagResponse(success=False, error=f"模型预热失败: {st['error']}")

    try:
        img_bytes = base64.b64decode(req.image)
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        # WD14 标签：rating（safe/questionable/explicit 分级）、general（一般标签）、character（角色）
        rating, general, character = get_wd14_tags(img, model_name=MODEL_NAME)
        return TagResponse(
            success=True,
            rating=dict(rating),
            general=dict(general),
            character=dict(character),
        )
    except Exception as e:
        return TagResponse(success=False, error=str(e))


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("WD14_PORT", "9898"))
    print(f"[WD14] 标签器服务启动: http://127.0.0.1:{port}  模型: {MODEL_NAME}  预热: {PRELOAD_MODE}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")