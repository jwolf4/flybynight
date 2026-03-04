from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import time

app = FastAPI()

# single-stream lock
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

    # only guard the canonical stream
    if key != "live/live":
        return {"code": 0}

    publisher = body.get("client_id") or body.get("ip") or "unknown"

    # if already live, reject publish
    if lock["held"]:
        # per SRS hook convention: non-zero means reject :contentReference[oaicite:3]{index=3}
        return {"code": 1, "msg": "busy"}

    # acquire
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