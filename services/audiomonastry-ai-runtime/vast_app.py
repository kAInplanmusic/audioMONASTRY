"""Vast diagnostic extension; inherits the production bearer-auth middleware."""
import os
import threading
from fastapi import HTTPException
from app import app
import render_probe

_lock = threading.Lock()
_proof = None


@app.get('/diagnostics/render')
def render_diagnostic():
    global _proof
    if os.environ.get('AI_ROLE') != 'vis':
        raise HTTPException(status_code=404, detail='not found')
    with _lock:
        if _proof is None:
            try:
                _proof = render_probe.run()
            except Exception:
                # Native diagnostics can contain private paths and credentials.
                raise HTTPException(status_code=503, detail='render verification failed') from None
        return _proof


# --- Live-Visual-Renderer (nur Rolle vis) -----------------------------------
# Bearer-Auth erbt die App-Middleware. Eine Sitzung gleichzeitig; Features
# kommen als kleine JSON-Updates, das Video als H.264/MPEG-TS-Strom.
from fastapi import Body
from fastapi.responses import StreamingResponse
import queue

import visual_renderer

_visual_lock = threading.Lock()
_visual = None


def _require_vis():
    if os.environ.get('AI_ROLE') != 'vis':
        raise HTTPException(status_code=404, detail='not found')


@app.post('/visual/session')
def visual_start(body: dict = Body(...)):
    global _visual
    _require_vis()
    try:
        cfg = visual_renderer.validate_config(body)
    except visual_renderer.ConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    with _visual_lock:
        if _visual is not None:
            _visual.stop()
            _visual = None
        session = visual_renderer.VisualSession(cfg)
        try:
            session.start()
        except Exception:
            raise HTTPException(status_code=503, detail='visual session failed: ' + str(session.status().get('error'))) from None
        _visual = session
        return session.status()


@app.post('/visual/features')
def visual_features(body: dict = Body(...)):
    _require_vis()
    session = _visual
    if session is None:
        raise HTTPException(status_code=409, detail='no visual session')
    session.set_features(body)
    return {'ok': True}


@app.post('/visual/effects')
def visual_effects(body: dict = Body(...)):
    _require_vis()
    session = _visual
    if session is None:
        raise HTTPException(status_code=409, detail='no visual session')
    try:
        session.set_effects(body.get('effects', 'auto'), body.get('maxEffects'))
    except visual_renderer.ConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return {'ok': True}


@app.get('/visual/status')
def visual_status():
    _require_vis()
    session = _visual
    return session.status() if session else {'running': False}


@app.get('/visual/stream')
def visual_stream():
    _require_vis()
    session = _visual
    if session is None:
        raise HTTPException(status_code=409, detail='no visual session')
    subscriber = session.subscribe()

    def chunks():
        try:
            while True:
                try:
                    chunk = subscriber.get(timeout=10)
                except queue.Empty:
                    continue
                if not chunk:
                    return
                yield chunk
        finally:
            session.unsubscribe(subscriber)

    return StreamingResponse(chunks(), media_type='video/mp2t')


@app.delete('/visual/session')
def visual_stop():
    global _visual
    _require_vis()
    with _visual_lock:
        if _visual is not None:
            _visual.stop()
            _visual = None
    return {'running': False}
