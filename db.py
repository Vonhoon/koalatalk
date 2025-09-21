import os
import json
import sqlite3
from threading import RLock
from typing import List, Dict, Optional

class DB:
    def __init__(self, backend="sqlite"):
        self.backend = backend
        os.makedirs("storage", exist_ok=True)
        if backend == "sqlite":
            self.path = "storage/data.sqlite"
            self._init_sqlite()
        else:
            raise ValueError("Unsupported DB_BACKEND")

    def _init_sqlite(self):
        with sqlite3.connect(self.path) as conn:
            cur = conn.cursor()
            cur.execute("""
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    endpoint TEXT UNIQUE,
                    p256dh TEXT,
                    auth TEXT,
                    alias TEXT,
                    user_id TEXT,
                    channels TEXT,
                    created_at INTEGER,
                    last_seen INTEGER,
                    fail_count INTEGER DEFAULT 0
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    channel TEXT,
                    alias TEXT,
                    user_id TEXT,
                    type TEXT,
                    text TEXT,
                    audio_path TEXT,
                    image_path TEXT,
                    file_path  TEXT,
                    image_url  TEXT,
                    file_url   TEXT,
                    file_name  TEXT,
                    created_at INTEGER
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages (channel, created_at);")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS channels (
                    key TEXT PRIMARY KEY,
                    title TEXT,
                    members TEXT
                )
            """)
            cur.execute("PRAGMA table_info(messages)")
            cols = {row[1] for row in cur.fetchall()}
            wanted = {"audio_path": "TEXT", "image_path": "TEXT", "file_path": "TEXT", "image_url": "TEXT", "file_url": "TEXT", "file_name": "TEXT"}
            for name, typ in wanted.items():
                if name not in cols:
                    cur.execute(f"ALTER TABLE messages ADD COLUMN {name} {typ}")
            conn.commit()

    def _sql(self, q, args=(), fetch=None):
        with sqlite3.connect(self.path) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute(q, args)
            res = None
            if fetch == "one": res = cur.fetchone()
            elif fetch == "all": res = cur.fetchall()
            conn.commit()
            if fetch: return res
            return cur.lastrowid

    def save_subscription(self, sub, alias="unknown", user_id=None, channels=None):
            endpoint = sub["endpoint"]
            p256dh, auth = sub["keys"]["p256dh"], sub["keys"]["auth"]
            chs = json.dumps(channels or [])
            ts = self._now()
            
            # CRITICAL FIX: Before adding the new subscription, delete any old ones
            # for the same user. This prevents stale/duplicate subscriptions.
            if alias and alias != "unknown":
                self._sql("DELETE FROM subscriptions WHERE alias=?", (alias,))
            
            # Now, insert the new, single subscription for this user.
            self._sql("""
                INSERT INTO subscriptions(endpoint, p256dh, auth, alias, user_id, channels, created_at, last_seen, fail_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
            """, (endpoint, p256dh, auth, alias, user_id, chs, ts, ts))
            
            row = self._sql("SELECT id FROM subscriptions WHERE endpoint=?", (endpoint,), fetch="one")
            return row["id"]

    def list_subscriptions(self) -> List[Dict]:
        rows = self._sql("SELECT * FROM subscriptions", fetch="all")
        return [dict(r) for r in rows]

    def bump_subscription_seen(self, sub_id: int):
        self._sql("UPDATE subscriptions SET last_seen=?, fail_count=0 WHERE id=?", (self._now(), sub_id))

    def bump_subscription_fail(self, sub_id: int):
        self._sql("UPDATE subscriptions SET fail_count=fail_count+1 WHERE id=?", (sub_id,))

    def prune_subscriptions_stale(self, days=90):
        if days is None: return
        cutoff = self._now() - int(days * 86400)
        self._sql("DELETE FROM subscriptions WHERE last_seen IS NOT NULL AND last_seen < ?", (cutoff,))

    def save_message(self, msg: Dict) -> int:
        return self._sql("""
            INSERT INTO messages(channel, alias, user_id, type, text, audio_path, image_path, file_path, image_url, file_url, file_name, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (msg.get("channel"), msg.get("alias"), msg.get("user_id"), msg.get("type"), msg.get("text"),
              msg.get("audio_path"), msg.get("image_path"), msg.get("file_path"), msg.get("image_url"),
              msg.get("file_url"), msg.get("file_name"), msg.get("created_at")))

    def get_message(self, msg_id: int) -> Optional[Dict]:
        r = self._sql("SELECT * FROM messages WHERE id=?", (msg_id,), fetch="one")
        return self._row_to_msg(r)

    def list_messages(self, channel: str, since_ts: int) -> List[Dict]:
        rows = self._sql("SELECT * FROM messages WHERE channel=? AND created_at>=? ORDER BY created_at ASC", (channel, since_ts), fetch="all")
        return [self._row_to_msg(r) for r in rows]
    
    def delete_message(self, msg_id: int, alias: str, admin: bool = False) -> bool:
        if admin:
            self._sql("DELETE FROM messages WHERE id=?", (msg_id,))
        else:
            self._sql("DELETE FROM messages WHERE id=? AND alias=?", (msg_id, alias))
        row = self._sql("SELECT changes() AS n", fetch="one")
        return bool(row and row["n"])

    def upsert_channel(self, key: str, title: str, members: list[str]):
        self._sql("""
            INSERT INTO channels(key, title, members) VALUES (?,?,?)
            ON CONFLICT(key) DO UPDATE SET title=excluded.title, members=excluded.members
        """, (key, title, json.dumps(sorted(list(set(members))))))

    def get_channel(self, key: str) -> Optional[Dict]:
        r = self._sql("SELECT * FROM channels WHERE key=?", (key,), fetch="one")
        if not r: return None
        return {"key": r["key"], "title": r["title"], "members": json.loads(r["members"] or "[]")}

    def get_or_create_public(self):
        ch = self.get_channel("public-1")
        if not ch:
            self.upsert_channel("public-1", "모두의 방", ["아빠","엄마","첫째","둘째"])
            ch = self.get_channel("public-1")
        return ch

    def get_or_create_dm(self, a: str, b: str) -> Dict:
        # IMPORTANT: Always sort members to ensure consistent DM channel keys
        a, b = sorted([a, b])
        key = f"dm:{a}:{b}"
        ch = self.get_channel(key)
        if not ch:
            # Create new DM channel with sorted members
            title = f"{a} & {b}"  # Changed from f"{a}・{b}" to use & instead
            self.upsert_channel(key, title, [a, b])
            ch = self.get_channel(key)
        return ch

    def list_channels_for_user(self, alias: str):
        # First ensure the public channel exists
        self.get_or_create_public()
        
        # Find all channels where this user is a member
        rows = self._sql("""
            SELECT c.* FROM channels c, json_each(c.members) j
            WHERE j.value = ?
        """, (alias,), fetch="all")
        channels = []
        for r in rows:
            ch = self.get_channel(r['key'])
            if ch:
                channels.append(ch)
        # Sort: public channel first, then DM channels
        channels.sort(key=lambda c: (0 if c['key'].startswith('public') else 1, c['key']))
        return channels

    def get_channel_members(self, key: str) -> list[str]:
        ch = self.get_channel(key)
        return ch["members"] if ch else []
    
    def list_messages_between(self, channel: str, start_ts: int, end_ts: int) -> List[Dict]:
        rows = self._sql("SELECT * FROM messages WHERE channel=? AND created_at>=? AND created_at<=? ORDER BY created_at ASC", (channel, start_ts, end_ts), fetch="all")
        return [self._row_to_msg(r) for r in rows]

    def count_messages_before(self, channel: str, ts: int) -> int:
        r = self._sql("SELECT COUNT(1) AS c FROM messages WHERE channel=? AND created_at<?", (channel, ts), fetch="one")
        return int(r["c"] if r else 0)

    def prune_messages_and_return_audio_paths(self, cutoff: int) -> List[str]:
        rows = self._sql("SELECT audio_path, image_path, file_path FROM messages WHERE created_at < ?", (cutoff,), fetch="all")
        paths = []
        for r in rows:
            if r["audio_path"]: paths.append(r["audio_path"])
            if r["image_path"]: paths.append(r["image_path"])
            if r["file_path"]: paths.append(r["file_path"])
        self._sql("DELETE FROM messages WHERE created_at < ?", (cutoff,))
        return paths

    def _row_to_msg(self, r) -> Optional[Dict]:
        if not r: return None
        out = dict(r)
        # Generate URLs for files
        if out.get("audio_path"):
            out["audio_url"] = f"/media/{os.path.basename(out['audio_path'])}"
        if out.get("image_path"):
            out["image_url"] = f"/uploads/{os.path.basename(out['image_path'])}"
        if out.get("file_path"):
            out["file_url"] = f"/uploads/{os.path.basename(out['file_path'])}"
        return out
    
    def _now(self) -> int:
        import time
        return int(time.time())