import os
import json
import uuid
import time
import threading
import traceback
from queue import SimpleQueue, Empty
from pathlib import Path
from typing import Dict, List, Tuple
from werkzeug.security import check_password_hash, generate_password_hash

import mimetypes
mimetypes.init()

from flask import (
    Flask, request, jsonify, Response,
    send_from_directory, abort, session, make_response
)
from pywebpush import webpush, WebPushException

from db import DB                         # your DB wrapper (sqlite/json)
from settings import load_or_create_vapid_keys  # returns (private, public)
from flask_compress import Compress

# ------------------- config -------------------
APP_PORT = int(os.environ.get("PORT", 8000))
MEDIA_DIR = Path("storage/audio")
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
PUSH_ENABLED = os.environ.get("PUSH_ENABLED", "true").lower() in ("1","true","yes")
UPLOAD_DIR = Path("storage/uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

PUBLIC_CHANNEL_KEY = "public-1"
PUBLIC_CHANNEL_TITLE = "모두의 방"

app = Flask(__name__, static_folder="static", static_url_path="/")
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=True,  # Set to True only if using HTTPS
    SESSION_COOKIE_HTTPONLY=True,
)
Compress(app) 
db = DB(os.environ.get("DB_BACKEND", "sqlite"))
VAPID_PRIVATE, VAPID_PUBLIC = load_or_create_vapid_keys()
VAPID_PRIVATE_PATH = Path("storage/keys/vapid_private.pem")

# Initialize public channel with consistent title
try:
    db.upsert_channel(PUBLIC_CHANNEL_KEY, PUBLIC_CHANNEL_TITLE, ["아빠","엄마","첫째","둘째"])
except Exception as e:
    print(f"[INIT] Failed to create public channel: {e}", flush=True)

app.secret_key = os.environ.get("SECRET_KEY", "dev-only-change-me")

USERS = {
    "아빠": generate_password_hash("peace81!"),
    "엄마": generate_password_hash("peace81!"),
    "첫째": generate_password_hash("peace81!"),
    "둘째": generate_password_hash("peace81!"),
}


# ------------------- in-proc pub/sub for SSE (Corrected & Thread-Safe) -------------------
# ------------------- in-proc pub/sub for SSE (Final Corrected Version) -------------------
_realtime_lock = threading.Lock()

_subscribers: Dict[str, List[SimpleQueue]] = {}
_active_users = set()

def _subscribe(channel: str) -> SimpleQueue:
    q = SimpleQueue()
    with _realtime_lock:
        _subscribers.setdefault(channel, []).append(q)
    return q

def _unsubscribe(channel: str, q: SimpleQueue):
    with _realtime_lock:
        if channel in _subscribers and q in _subscribers[channel]:
            # Add a try-except here for robustness, as the queue might already be gone
            try:
                _subscribers[channel].remove(q)
            except ValueError:
                pass # Queue was already removed, which is fine.

def _publish(channel: str, event: dict):
    sub_list = []
    # Use the lock to safely get a copy of the subscriber list
    with _realtime_lock:
        sub_list = list(_subscribers.get(channel, []))

    # Iterate over the copy outside the lock to avoid holding it for too long
    for q in sub_list:
        try:
            q.put_nowait(event)
        except Exception:
            # If a queue is broken, schedule it for removal
            _unsubscribe(channel, q)

def now_ts() -> int:
    return int(time.time())

# ------------------- background cleanup -------------------
def background_cleanup():
    """Hourly: delete messages older than 24h; prune stale subs; remove orphan audio files."""
    while True:
        try:
            cutoff = now_ts() - 24 * 3600
            old_audio = db.prune_messages_and_return_audio_paths(cutoff=cutoff)
            for ap in old_audio or []:
                try:
                    p = Path(ap)
                    if p.is_file():
                        p.unlink(missing_ok=True)
                except Exception as e:
                    print("[CLEANUP] rm audio failed:", ap, e, flush=True)
            db.prune_subscriptions_stale(days=90)
        except Exception as e:
            print("[CLEANUP] error:", e, flush=True)
        time.sleep(3600)

threading.Thread(target=background_cleanup, daemon=True).start()

# ------------------- push helper -------------------
def push_notify(subscription: dict, payload_dict: dict):
    if not PUSH_ENABLED:
        return False, "push disabled"
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps(payload_dict),
            vapid_private_key=str(VAPID_PRIVATE_PATH),
            vapid_claims={"sub": "mailto:admin@example.com"},
            ttl=60,
        )
        return True, None
    except WebPushException as e:
        msg = str(e)
        
        if e.response and e.response.status_code in (404, 410):
            return False, "gone"
        return False, msg
    except Exception as e:
        msg = str(e)
        
        return False, msg

def send_pushes_background(payload_dict: dict, msg_out: dict):
    """Runs in a background thread to avoid blocking the API response."""
    
    try:
        delivered = failures = 0
        all_subs = db.list_subscriptions() or []
        channel_key = msg_out.get("channel", "")
        channel_info = db.get_channel(channel_key)
        channel_members = channel_info.get("members", []) if channel_info else []
        sender_alias = msg_out.get("alias")
        sender_user_id = msg_out.get("user_id")
        
        # Track which users we've already notified (to prevent duplicates)
        notified_users = set()
        
        for s in all_subs:
            # Skip if we've already notified this user
            sub_user_alias = s.get("alias")
            # If the subscriber is currently active in the app, skip the push
            is_active = False
            if sub_user_alias:
                with _realtime_lock: # Use the unified lock
                    is_active = sub_user_alias in _active_users

            if is_active:
                print(f"[PUSH] Skipping active user: {sub_user_alias}", flush=True)
                continue

            sub_user_id = s.get("user_id")
            
            # Create a unique identifier for this subscription
            sub_identifier = sub_user_alias or sub_user_id
            if sub_identifier in notified_users:
                continue
                
            # Don't notify the sender (check both user_id and alias)
            if sender_user_id and sub_user_id == sender_user_id:
                continue
            if sender_alias and sub_user_alias == sender_alias:
                continue
            
            # For DM channels (format: "dm:user1:user2"), only notify the OTHER member
            if channel_key.startswith("dm:"):
                # DM channel - only notify if this subscriber is one of the two members
                if not sub_user_alias or sub_user_alias not in channel_members:
                    continue
                # Double-check: don't notify the sender in DM
                if sub_user_alias == sender_alias:
                    continue
                    
            # For public channels, notify all members except sender
            elif channel_members:
                # Only notify members of this channel
                if not sub_user_alias or sub_user_alias not in channel_members:
                    continue
                # Skip the sender
                if sub_user_alias == sender_alias:
                    continue
            
            # Mark this user as notified
            if sub_identifier:
                notified_users.add(sub_identifier)
            
            # Send the push notification
            ok, err = push_notify(
                {"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                payload_dict
            )
            
            if ok:
                delivered += 1
                try: 
                    db.bump_subscription_seen(s["id"])
                except Exception: 
                    pass
            else:
                failures += 1
                try:
                    if err == "gone":
                        db._sql("DELETE FROM subscriptions WHERE id=?", (s["id"],))
                    else:
                        db.bump_subscription_fail(s["id"])
                except Exception: 
                    pass
                    
        

    except Exception as e:
        traceback.print_exc()
        
# ------------------- routes -------------------
@app.get("/")
def index():
    return app.send_static_file("index.html")

@app.get("/favicon.ico")
def favicon():
    return ("", 204)

_PUBLIC_PATHS = (
    "/login", "/logout", "/healthz", "/favicon.ico", "/vapid-public-key",
    "/sw.js", "/static/", "/",
)

@app.before_request
def require_auth():
    p = (request.path or "")
    if any(p == x or p.startswith(x.rstrip("*")) for x in _PUBLIC_PATHS):
        return
    if not session.get("user"):
        if p.startswith("/api/") or p.startswith("/stream/"):
            return jsonify({"error": "auth required"}), 401
        return abort(401)

@app.get("/whoami")
def whoami():
    u = session.get("user")
    return jsonify({"user": u}) if u else jsonify({"user": None})

@app.post("/login")
def login():
    data = request.get_json(force=True, silent=True) or {}
    uid = (data.get("id") or "").strip()
    pw  = (data.get("password") or "")
    if uid in USERS and check_password_hash(USERS[uid], pw):
        session["user"] = uid
        session.permanent = True
        return jsonify({"ok": True, "user": uid})
    return jsonify({"error": "invalid credentials"}), 401

@app.post("/logout")
def logout():
    session.pop("user", None)
    return jsonify({"ok": True})

@app.post("/api/webrtc/signal")
def webrtc_signal():
    user_from = session.get("user")
    if not user_from:
        return jsonify({"error": "auth required"}), 401
    
    data = request.get_json(silent=True) or {}
    user_to = data.get("to")
    payload = data.get("payload")

    if not user_to or not payload:
        return jsonify({"error": "missing 'to' or 'payload'"}), 400

    # Publish the signal to the target user's meta stream
    _publish(f"meta:{user_to}", {
        "event": "webrtc_signal",
        "data": { "from": user_from, "payload": payload }
    })
    
    return jsonify({"ok": True})

@app.get("/api/channels")
def list_my_channels():
    u = session.get("user")
    if not u: return jsonify({"error": "auth required"}), 401
    try:
        chans = db.list_channels_for_user(u)
        return jsonify({"ok": True, "channels": chans})
    except Exception as e:
        print("[ERROR] /api/channels GET:", e, flush=True)
        traceback.print_exc()
        return jsonify({"error": "internal"}), 500

@app.post("/api/channels")
def create_dm_channel():
    u = session.get("user")
    if not u: return jsonify({"error": "auth required"}), 401
    data = request.get_json(silent=True) or {}
    if (data.get("type") or "").lower() != "dm":
        return jsonify({"error": "type must be 'dm'"}), 400
    members = data.get("members") or []
    if u not in members: members.append(u)
    members = list(set(members))
    if len(members) != 2:
        return jsonify({"error": "exactly two members required"}), 400
    try:
        ch = db.get_or_create_dm(members[0], members[1])
        other_user = members[0] if members[1] == u else members[1]
        _publish(f"meta:{other_user}", {"event": "channel", "data": ch})
        return jsonify({"ok": True, "channel": ch})
    except Exception as e:
        print("[ERROR] /api/channels POST:", e, flush=True)
        return jsonify({"error": "internal"}), 500

@app.get("/sw.js")
def service_worker():
    return app.send_static_file("sw.js")

@app.get("/vapid-public-key")
def vapid_public_key():
    resp = make_response(jsonify({"publicKey": VAPID_PUBLIC}))
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

@app.post("/subscribe")
def subscribe():
    try:
        data = request.get_json(force=True)
        sub = data.get("subscription")
        alias = data.get("alias") or "unknown"
        user_id = data.get("user_id")
        if not sub or "endpoint" not in sub or "keys" not in sub:
            return jsonify({"error": "invalid subscription"}), 400
        sub_id = db.save_subscription(sub, alias=alias, user_id=user_id, channels=[])
        return jsonify({"ok": True, "subscription_id": sub_id})
    except Exception as e:
        print("[ERROR] /subscribe:", e, flush=True)
        return jsonify({"error": "internal"}), 500
    
@app.delete("/api/messages/<int:msg_id>")
def delete_message_route(msg_id: int):
    user = session.get("user")
    if not user: return jsonify({"error": "auth required"}), 401
    try:
        row = db.get_message(msg_id)
        if not row: return jsonify({"error":"not found"}), 404
        
        channel = row.get("channel")
        is_admin = user in ("아빠", "엄마")
        
        if not is_admin and row.get("alias") != user:
             return jsonify({"error": "forbidden"}), 403

        ok = db.delete_message(msg_id, alias=row.get("alias"), admin=is_admin)
        if not ok: return jsonify({"error":"forbidden or already deleted"}), 403

        # Delete associated files
        for col, base in (("audio_path", MEDIA_DIR), ("image_path", UPLOAD_DIR), ("file_path", UPLOAD_DIR)):
            p_str = row.get(col)
            if p_str:
                try: Path(p_str).unlink(missing_ok=True)
                except Exception: pass
        if channel:
            _publish(channel, {"event":"delete", "data":{"id": msg_id}})
        return jsonify({"ok": True})
    except Exception as e:
        print("[ERROR] DELETE /api/messages:", e, flush=True)
        return jsonify({"error": "internal"}), 500

# Add this new route to app.py

@app.post("/api/messages/<int:msg_id>/end_call")
def end_call_message(msg_id: int):
    user = session.get("user")
    if not user:
        return jsonify({"error": "auth required"}), 401

    try:
        msg = db.get_message(msg_id)
        if not msg:
            return jsonify({"error": "not found"}), 404

        # Basic check to see if user is part of the DM
        channel_key = msg.get("channel", "")
        if not channel_key.startswith("dm:") or user not in channel_key:
             return jsonify({"error": "forbidden"}), 403

        new_text = "📞 통화 종료" # "Call ended"
        db.update_message_text(msg_id, new_text)

        updated_msg = db.get_message(msg_id)
        _publish(channel_key, {"event": "message_update", "data": updated_msg})
        
        return jsonify({"ok": True, "message": updated_msg})
    except Exception as e:
        print(f"[ERROR] end_call_message: {e}", flush=True)
        return jsonify({"error": "internal"}), 500


@app.post("/api/messages")
def create_message():
    try:
        ctype = (request.content_type or "").lower()
        msg_out = None

        if ctype.startswith("multipart/form-data"):
            channel = request.form.get("channel")
            alias = request.form.get("alias", "unknown")
            user_id = request.form.get("user_id")
            if not channel: return jsonify({"error": "channel required"}), 400

            f = request.files.get("audio") or request.files.get("upload")
            if not f: return jsonify({"error": "audio or upload required"}), 400

            orig = (f.filename or "file.bin")
            # FIXED: Preserve file extension properly
            ext = "".join(Path(orig).suffixes)  # Gets all extensions like .tar.gz
            if not ext:  # If no extension, guess from mimetype
                mime = f.mimetype or mimetypes.guess_type(orig)[0]
                if mime:
                    ext = mimetypes.guess_extension(mime) or ".bin"
                else:
                    ext = ".bin"
            
            safe_name = f"{uuid.uuid4().hex}{ext}"
            
            is_audio = "audio" in request.files
            save_dir = MEDIA_DIR if is_audio else UPLOAD_DIR
            save_path = save_dir / safe_name
            f.save(save_path)
            
            # Check mime type for image detection
            mime, _ = mimetypes.guess_type(str(save_path))
            if not mime and f.mimetype:
                mime = f.mimetype
            is_image = not is_audio and (mime or "").startswith("image/")
            
            msg = {
                "channel": channel,
                "alias": alias,
                "user_id": user_id,
                "type": "voice" if is_audio else ("image" if is_image else "file"),
                "audio_path": str(save_path) if is_audio else None,
                "image_path": str(save_path) if is_image else None,
                "file_path": str(save_path) if not is_audio and not is_image else None,
                "file_name": orig if not is_audio and not is_image else None,
                "created_at": now_ts(),
            }
            msg_id = db.save_message(msg)
            msg_out = db.get_message(msg_id)
            
        elif "application/json" in ctype or request.is_json:
            data = request.get_json(silent=True) or {}
            channel, alias, user_id, mtype, text = (
                data.get("channel"), data.get("alias", "unknown"),
                data.get("user_id"), (data.get("type") or "text").strip().lower(),
                (data.get("text") or "").strip()
            )
            if not channel: return jsonify({"error": "channel required"}), 400
            if mtype == "text" and not text: return jsonify({"error": "text required"}), 400
            
            # --- REPLACE THE ORIGINAL msg LINE WITH THIS BLOCK ---
            payload = data.get("payload")
            msg = {
                "channel": channel, "alias": alias, "user_id": user_id, 
                "type": mtype, "text": text, 
                "payload": json.dumps(payload) if payload else None,
                "created_at": now_ts()
            }
            # --- END REPLACEMENT ---

            msg_id  = db.save_message(msg)
            msg_out = db.get_message(msg_id)

        else:
            return jsonify({"error": "unsupported content-type"}), 415

        if not msg_out: raise Exception("Failed to create and retrieve message")

        # Generate push notification body
        title = f"KoalaTalk 새 메시지"
        channel_key = msg_out.get("channel", "")  # FIX: Define channel_key
        channel_info = db.get_channel(channel_key)
        chan_title = channel_info.get("title", "") if channel_info else ""
        alias = msg_out.get("alias", "")
        mtype = msg_out.get("type", "text")
        raw_text = (msg_out.get("text") or "").strip()
        
        body = ""
        if mtype == "text" and raw_text:
            snippet = raw_text[:100]  # Shorter snippet for push notifications
            if channel_key.startswith("dm:"):
                body = f'{alias}: {snippet}'
            else:
                body = f'{alias} ({chan_title}): {snippet}'
        else:
            kind_map = {"voice":"음성 메시지", "image":"사진", "file":"파일"}
            kind = kind_map.get(mtype, "메시지")
            if channel_key.startswith("dm:"):
                body = f'{alias} 님이 {kind}를 보냈어요'
            else:
                body = f'{alias} 님이 {chan_title}에 {kind}를 보냈어요'
        
        payload = {"title": title, "body": body}
        
        # Send push notifications in background
        threading.Thread(target=send_pushes_background, args=(payload, msg_out), daemon=True).start()

        # Publish to SSE subscribers
        _publish(msg_out["channel"], {"event": "message", "data": msg_out})
        
        return jsonify({"ok": True, "message": msg_out})

    except Exception as e:
        print("[ERROR] /api/messages:", e, flush=True)
        traceback.print_exc()
        return jsonify({"error": "internal"}), 500

@app.get("/uploads/<path:fname>")
def serve_upload(fname):
    return send_from_directory(UPLOAD_DIR, fname)

@app.get("/api/messages")
def list_messages():
    try:
        channel = request.args.get("channel")
        if not channel: return jsonify({"error": "channel required"}), 400
        
        days = int(request.args.get("days", 3))
        before = int(request.args.get("before", now_ts()))
        start_ts = before - days * 86400
        
        msgs = db.list_messages_between(channel=channel, start_ts=start_ts, end_ts=before) or []
        has_more = (db.count_messages_before(channel=channel, ts=start_ts) or 0) > 0

        return jsonify({"ok": True, "messages": msgs, "has_more": has_more})
    except Exception as e:
        print("[ERROR] /api/messages GET:", e, flush=True)
        return jsonify({"error": "internal"}), 500

@app.get("/stream/<channel>")
def stream_channel(channel):
    user = session.get("user") # Get the current user
    q = _subscribe(channel)
    
    def gen():
        try:
            if user:
                with _realtime_lock: # Use the unified lock
                    _active_users.add(user)
            yield "event: hello\ndata: {}\n\n"
            while True:
                try:
                    item = q.get(timeout=15)
                    yield f"event: {item.get('event','message')}\ndata: {json.dumps(item['data'])}\n\n"
                except Empty:
                    yield "event: ping\ndata: {}\n\n"
        finally:
            _unsubscribe(channel, q)
            if user:
                with _realtime_lock: # Use the unified lock
                    _active_users.discard(user)

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"
    })

@app.get("/stream/meta/<alias>")
def stream_meta(alias):
    q = _subscribe(f"meta:{alias}")
    def gen():
        try:
            yield "event: hello\ndata: {}\n\n"
            while True:
                try:
                    item = q.get(timeout=15)
                    yield f"event: {item.get('event','channel')}\ndata: {json.dumps(item['data'])}\n\n"
                except Empty:
                    yield "event: ping\ndata: {}\n\n"
        finally:
            _unsubscribe(f"meta:{alias}", q)
    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache", "X-Accel-Buffering":"no", "Connection":"keep-alive"
    })

@app.get("/media/<path:fname>")
def serve_media(fname):
    return send_from_directory(MEDIA_DIR, fname)

@app.get("/healthz")
def healthz():
    return jsonify({"ok": True})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=APP_PORT, threaded=True, debug=False)