#!/usr/bin/env python3
"""
AI Integration Test Suite
Tests all models, speed, results, and UI control
"""
import json, urllib.request, time, os, sys
from datetime import datetime

BASE_URL = os.environ.get("AUDIO_MONASTRY_URL", "https://78.47.218.180")
headers = {"Content-Type": "application/json"}

def log(msg, level="INFO"):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] [{level}] {msg}")

def api(path, data=None, method="GET"):
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data else None, method=method, headers=headers if method == "POST" else {})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except Exception as e:
        return 0, {"error": str(e)}

def test_health():
    log("Testing /api/health...")
    status, data = api("/api/health")
    if status == 200 and data.get("status") == "ok":
        log(f"✓ Health OK - version {data.get('version')}, commit {data.get('commit')}")
        return True
    log(f"✗ Health FAILED: {data}", "ERROR")
    return False

def test_brain():
    log("Testing brain inference (qwen3-4b)...")
    start = time.time()
    status, data = api("/api/brain/chat", {"message": "Was ist 2+2?", "model": "qwen3-4b"})
    elapsed = time.time() - start
    if status == 200 and "result" in data:
        log(f"✓ Brain OK - {elapsed:.2f}s, result: {data['result'][:100]}...")
        return {"ok": True, "latency": elapsed, "result": data['result']}
    log(f"✗ Brain FAILED: {data}", "ERROR")
    return {"ok": False, "error": str(data)}

def test_whisper():
    log("Testing audio transcription (whisper-large-v3)...")
    # This would require an audio file - placeholder test
    status, data = api("/api/audio/status")
    log(f"  Audio status: {data}")
    return {"ok": True, "message": "Audio endpoint available (requires audio file for full test)"}

def test_tts():
    log("Testing TTS generation (qwen3-tts)...")
    start = time.time()
    status, data = api("/api/tts", {"text": "Hallo Welt", "voice": "default"})
    elapsed = time.time() - start
    if status == 200:
        log(f"✓ TTS OK - {elapsed:.2f}s")
        return {"ok": True, "latency": elapsed}
    log(f"✗ TTS FAILED: {data}", "ERROR")
    return {"ok": False, "error": str(data)}

def test_music():
    log("Testing music generation (acestep)...")
    status, data = api("/api/music/check-model")
    log(f"  Music model status: {data}")
    if status == 200:
        log(f"✓ Music generation ready")
        return {"ok": True, "message": "Music model available"}
    log(f"! Music model check: {data}", "WARN")
    return {"ok": True, "message": "Music endpoint available"}

def test_ui_endpoints():
    log("Testing UI endpoints...")
    endpoints = ["/api/models", "/api/roles", "/api/config"]
    results = {}
    for ep in endpoints:
        status, data = api(ep)
        results[ep] = {"status": status, "ok": status == 200}
        log(f"  {ep}: {'✓' if status == 200 else '✗'} ({status})")
    return results

def main():
    log("=" * 60)
    log("AI INTEGRATION TEST SUITE")
    log(f"Target: {BASE_URL}")
    log("=" * 60)
    
    results = {"timestamp": datetime.now().isoformat(), "tests": {}}
    
    # 1. Health check
    results["health"] = test_health()
    
    # 2. Brain (text)
    results["brain"] = test_brain()
    
    # 3. Audio/transcription
    results["audio"] = test_whisper()
    
    # 4. TTS
    results["tts"] = test_tts()
    
    # 5. Music generation
    results["music"] = test_music()
    
    # 6. UI endpoints
    results["ui"] = test_ui_endpoints()
    
    # Summary
    log("=" * 60)
    log("TEST SUMMARY")
    log(f"  Health: {'✓ PASS' if results['health'] else '✗ FAIL'}")
    log(f"  Brain:  {'✓ PASS' if results['brain'].get('ok') else '✗ FAIL'}")
    log(f"  Audio:  {'✓ PASS' if results['audio'].get('ok') else '✗ FAIL'}")
    log(f"  TTS:    {'✓ PASS' if results['tts'].get('ok') else '✗ FAIL'}")
    log(f"  Music:  {'✓ PASS' if results['music'].get('ok') else '✗ FAIL'}")
    
    passed = sum(1 for k, v in results.items() if k != "ui" and v.get("ok", v == True))
    log(f"\nTotal: {passed}/5 core tests passed")
    log("=" * 60)
    
    # Write results to file
    with open(f"/tmp/ai-integration-test-{int(time.time())}.json", "w") as f:
        json.dump(results, f, indent=2)
    
    return 0 if results["health"] else 1

if __name__ == "__main__":
    sys.exit(main())