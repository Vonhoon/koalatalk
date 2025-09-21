# settings.py
from pathlib import Path
import base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization

KEYS_DIR = Path("storage/keys")
KEYS_DIR.mkdir(parents=True, exist_ok=True)
PRIV_PEM = KEYS_DIR / "vapid_private.pem"
PUB_B64 = KEYS_DIR / "vapid_public.txt"

def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")

def load_or_create_vapid_keys():
    """
    Returns (private_pem_str, public_base64url_str)

    - private: PEM (PKCS8) for pywebpush
    - public: base64url (uncompressed EC point, 65 bytes) for browser PushManager
    """
    if PRIV_PEM.exists() and PUB_B64.exists():
        priv = PRIV_PEM.read_text()
        pub = PUB_B64.read_text().strip()
        return priv, pub

    # create new key pair
    priv_key = ec.generate_private_key(ec.SECP256R1())
    priv_pem = priv_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    pub_key = priv_key.public_key()
    pub_bytes = pub_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint
    )  # 65 bytes: 0x04 || X || Y
    pub_b64 = _b64url(pub_bytes)

    PRIV_PEM.write_text(priv_pem)
    PUB_B64.write_text(pub_b64)

    return priv_pem, pub_b64
