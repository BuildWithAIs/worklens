"""Publish static files using only bucket-scoped S3 credentials."""
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import sys

BUCKET = "worklens-site"
ACCOUNT = "60e88110eacab548b2028b6f76e2b97f"
PUBLIC = Path(__file__).parent / "public"


def assets():
    files = {}
    for path in sorted(PUBLIC.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Symlinks cannot be published: {path}")
        if path.is_file() and not any(part.startswith((".", "_")) for part in path.relative_to(PUBLIC).parts):
            files[path.relative_to(PUBLIC).as_posix()] = path.read_bytes()
    for required in ("index.html", "404.html", "robots.txt", "sitemap.xml"):
        if not files.get(required):
            raise ValueError(f"Missing {required}")
    return files


def deploy(client, revision, files):
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("A full Git commit SHA is required")
    prefix = f"releases/{revision}/"
    # Resume partial uploads, but never silently mutate an existing release.
    for name, body in files.items():
        try:
            actual = client.get_object(Bucket=BUCKET, Key=prefix + name)["Body"].read()
        except client.exceptions.NoSuchKey:
            content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
            client.put_object(Bucket=BUCKET, Key=prefix + name, Body=body, ContentType=content_type)
            actual = client.get_object(Bucket=BUCKET, Key=prefix + name)["Body"].read()
        if hashlib.sha256(actual).digest() != hashlib.sha256(body).digest():
            raise ValueError(f"Release content mismatch: {name}")
    manifest = json.dumps({"revision": revision, "files": sorted(files)}).encode()
    client.put_object(Bucket=BUCKET, Key="current.json", Body=manifest, ContentType="application/json", CacheControl="no-store")
    print(f"Published {len(files)} files from {revision}")


if __name__ == "__main__":
    files = assets()
    if "--check" in sys.argv:
        print(f"Validated {len(files)} public files")
    else:
        import boto3
        client = boto3.client("s3", endpoint_url=f"https://{ACCOUNT}.r2.cloudflarestorage.com", region_name="auto")
        deploy(client, os.environ["SITE_REVISION"], files)
