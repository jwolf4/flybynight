from fastapi import FastAPI, Request, HTTPException
import os
import time
import json
from typing import Any, Dict, List, Optional

import redis.asyncio as redis  # pip install redis>=5

app = FastAPI()

# ----------------------------
# Existing single-stream lock
# ----------------------------
lock = {
    "held": False,
    "publisher": None,
    "since": None,
}

@app.get("/status")
def status():
    return {"live": lock["held"]}

@app.post("/srs/on_publish")
async def on_publish(req: Request):
    body = await req.json()
    key = f'{body.get("app")}/{body.get("stream")}'  # e.g. "live/live"

    if key != "live/live":
        return {"code": 0}

    publisher = body.get("client_id") or body.get("ip") or "unknown"

    if lock["held"]:
        return {"code": 1, "msg": "busy"}

    lock["held"] = True
    lock["publisher"] = publisher
    lock["since"] = int(time.time())
    return {"code": 0}

@app.post("/srs/on_unpublish")
async def on_unpublish(req: Request):
    body = await req.json()
    key = f'{body.get("app")}/{body.get("stream")}'

    if key == "live/live":
        lock["held"] = False
        lock["publisher"] = None
        lock["since"] = None

    return {"code": 0}


# ----------------------------
# Redis setup
# ----------------------------
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
THREAD_TTL_SECONDS = int(os.getenv("THREAD_TTL_SECONDS", "21600"))  # 6 hours
SPOT_COUNT = int(os.getenv("SPOT_COUNT", "5"))
MAX_POSTS = int(os.getenv("MAX_POSTS", "200"))

# Key helpers (prefix everything)
def k_spot_thread_id(spot_id: int) -> str:
    return f"fbn:spot:{spot_id}:thread_id"

def k_thread_meta(thread_id: str) -> str:
    return f"fbn:thread:{thread_id}:meta"

def k_thread_posts(thread_id: str) -> str:
    return f"fbn:thread:{thread_id}:posts"  # Redis list of post JSON

def k_thread_post_counter(thread_id: str) -> str:
    return f"fbn:thread:{thread_id}:post_counter"  # INCR for No.xxx

r: Optional[redis.Redis] = None

@app.on_event("startup")
async def startup():
    global r
    r = redis.from_url(REDIS_URL, decode_responses=True)
    await r.ping()

@app.on_event("shutdown")
async def shutdown():
    global r
    if r is not None:
        await r.close()
        r = None


# ----------------------------
# Utilities
# ----------------------------
def _now_ms() -> int:
    return int(time.time() * 1000)

def _validate_spot_id(spot_id: int) -> None:
    if spot_id < 1 or spot_id > SPOT_COUNT:
        raise HTTPException(status_code=404, detail="spot not found")

async def _get_thread_id_for_spot(spot_id: int) -> Optional[str]:
    assert r is not None
    return await r.get(k_spot_thread_id(spot_id))

async def _load_thread(thread_id: str, limit_posts: int = 200) -> Optional[Dict[str, Any]]:
    """
    Returns thread object in the shape your UI expects:
    {
      threadId: "...",
      title: "...",
      createdAt: <ms>,
      posts: [
        { id: <int>, name: "...", comment: "...", createdAt: <ms>, imageDataUrl?: "...", imageUrl?: "..." }
      ]
    }
    """
    assert r is not None
    meta_raw = await r.get(k_thread_meta(thread_id))
    if not meta_raw:
        return None

    try:
        meta = json.loads(meta_raw)
    except json.JSONDecodeError:
        return None

    # posts are stored newest-first via LPUSH
    posts_raw = await r.lrange(k_thread_posts(thread_id), 0, max(0, min(limit_posts, MAX_POSTS)) - 1)
    posts: List[Dict[str, Any]] = []
    for s in reversed(posts_raw):  # oldest -> newest for UI
        try:
            posts.append(json.loads(s))
        except json.JSONDecodeError:
            continue

    return {
        "threadId": meta["threadId"],
        "title": meta.get("title", ""),
        "createdAt": meta.get("createdAt", 0),
        "posts": posts,
    }

async def _set_ttl_everywhere(pipe: redis.client.Pipeline, spot_id: int, thread_id: str) -> None:
    """
    Ensure every key expires (spot mapping, meta, posts list, counter).
    """
    pipe.expire(k_spot_thread_id(spot_id), THREAD_TTL_SECONDS)
    pipe.expire(k_thread_meta(thread_id), THREAD_TTL_SECONDS)
    pipe.expire(k_thread_posts(thread_id), THREAD_TTL_SECONDS)
    pipe.expire(k_thread_post_counter(thread_id), THREAD_TTL_SECONDS)


# ----------------------------
# Spot endpoints
# ----------------------------

@app.get("/api/spots")
async def get_spots(limit_posts: int = 60):
    """
    Returns an array length SPOT_COUNT:
    [
      { spotId: 1, thread: <thread|None> },
      ...
    ]
    """
    assert r is not None
    if limit_posts < 0 or limit_posts > 200:
        raise HTTPException(status_code=400, detail="limit_posts must be 0..200")

    spots = []
    for spot_id in range(1, SPOT_COUNT + 1):
        tid = await _get_thread_id_for_spot(spot_id)
        thread = None
        if tid:
            thread = await _load_thread(tid, limit_posts=limit_posts)
            # If mapping exists but meta expired, clean the mapping so UI doesn't get stuck
            if thread is None:
                await r.delete(k_spot_thread_id(spot_id))
                tid = None

        spots.append({"spotId": spot_id, "thread": thread})
    return spots


@app.post("/api/spots/{spot_id}/thread")
async def create_thread_in_spot(spot_id: int, payload: Dict[str, Any]):
    """
    Create a new thread in a spot.
    If spot is occupied, we reject with 409 (UI can show "occupied").
    payload: { title, name, comment, imageDataUrl? }
    """
    assert r is not None
    _validate_spot_id(spot_id)

    existing = await _get_thread_id_for_spot(spot_id)
    if existing:
        raise HTTPException(status_code=409, detail="spot occupied")

    title = str(payload.get("title", "")).strip()[:80]
    name = str(payload.get("name", "Anonymous")).strip()[:40] or "Anonymous"
    comment = str(payload.get("comment", "")).strip()[:4000]
    if not comment:
        raise HTTPException(status_code=400, detail="comment required")

    # You can keep imageDataUrl temporarily to match your current UI.
    # Long-term you should replace this with imageUrl from /api/upload.
    image_data_url = payload.get("imageDataUrl")
    if image_data_url is not None:
        image_data_url = str(image_data_url)
        # basic guard; still should move to file uploads ASAP
        if len(image_data_url) > 2_000_000:  # ~2MB of text
            raise HTTPException(status_code=413, detail="image too large")

    thread_id = f"t_{spot_id}_{int(time.time())}_{os.urandom(4).hex()}"
    now = _now_ms()

    meta = {
        "threadId": thread_id,
        "spotId": spot_id,
        "title": title,
        "createdAt": now,
        "updatedAt": now,
    }

    # Make OP post number 1
    op_no = 1
    op_post = {
        "id": op_no,  # numeric for >>123 quoting
        "name": name,
        "comment": comment,
        "createdAt": now,
    }
    if image_data_url:
        op_post["imageDataUrl"] = image_data_url

    pipe = r.pipeline()

    # Spot -> thread mapping
    pipe.set(k_spot_thread_id(spot_id), thread_id, ex=THREAD_TTL_SECONDS)

    # Thread meta + posts
    pipe.set(k_thread_meta(thread_id), json.dumps(meta), ex=THREAD_TTL_SECONDS)
    pipe.delete(k_thread_posts(thread_id))
    pipe.lpush(k_thread_posts(thread_id), json.dumps(op_post))
    pipe.expire(k_thread_posts(thread_id), THREAD_TTL_SECONDS)

    # Counter initialized to 1 (OP)
    pipe.set(k_thread_post_counter(thread_id), op_no, ex=THREAD_TTL_SECONDS)

    await pipe.execute()

    # Return thread in UI shape
    return {"spotId": spot_id, "thread": await _load_thread(thread_id, limit_posts=200)}


@app.post("/api/spots/{spot_id}/messages")
async def add_message_to_spot_thread(spot_id: int, payload: Dict[str, Any]):
    """
    Add a reply to the thread in the given spot.
    payload: { name, comment, imageDataUrl? }
    """
    assert r is not None
    _validate_spot_id(spot_id)

    thread_id = await _get_thread_id_for_spot(spot_id)
    if not thread_id:
        raise HTTPException(status_code=404, detail="no thread in spot")

    # Ensure thread meta exists (avoid orphan mapping)
    meta_raw = await r.get(k_thread_meta(thread_id))
    if not meta_raw:
        await r.delete(k_spot_thread_id(spot_id))
        raise HTTPException(status_code=404, detail="thread expired")

    name = str(payload.get("name", "Anonymous")).strip()[:40] or "Anonymous"
    comment = str(payload.get("comment", "")).strip()[:4000]
    if not comment:
        raise HTTPException(status_code=400, detail="comment required")

    image_data_url = payload.get("imageDataUrl")
    if image_data_url is not None:
        image_data_url = str(image_data_url)
        if len(image_data_url) > 2_000_000:
            raise HTTPException(status_code=413, detail="image too large")

    now = _now_ms()

    # INCR gives us numeric post ids for >>123 references
    post_no = await r.incr(k_thread_post_counter(thread_id))

    post = {
        "id": int(post_no),
        "name": name,
        "comment": comment,
        "createdAt": now,
    }
    if image_data_url:
        post["imageDataUrl"] = image_data_url

    # Update meta.updatedAt and push post
    meta = json.loads(meta_raw)
    meta["updatedAt"] = now

    pipe = r.pipeline()
    pipe.lpush(k_thread_posts(thread_id), json.dumps(post))
    pipe.ltrim(k_thread_posts(thread_id), 0, MAX_POSTS - 1)

    pipe.set(k_thread_meta(thread_id), json.dumps(meta), ex=THREAD_TTL_SECONDS)

    # Refresh TTLs everywhere so activity keeps the thread alive during business hours
    await _set_ttl_everywhere(pipe, spot_id, thread_id)

    await pipe.execute()

    return {"ok": True, "post": post}


@app.delete("/api/spots/{spot_id}/thread")
async def delete_thread_in_spot(spot_id: int):
    """
    Deletes the thread in that spot (best-effort). Useful for moderation and for 'close time'.
    """
    assert r is not None
    _validate_spot_id(spot_id)

    thread_id = await _get_thread_id_for_spot(spot_id)
    if not thread_id:
        return {"ok": True, "deleted": False}

    pipe = r.pipeline()
    pipe.delete(k_spot_thread_id(spot_id))
    pipe.delete(k_thread_meta(thread_id))
    pipe.delete(k_thread_posts(thread_id))
    pipe.delete(k_thread_post_counter(thread_id))
    await pipe.execute()

    return {"ok": True, "deleted": True}