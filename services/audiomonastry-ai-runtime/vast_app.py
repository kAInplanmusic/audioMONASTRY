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
