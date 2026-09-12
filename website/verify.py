"""Verify the exact deployed bytes and the selected release over HTTPS."""
import os
import time
import urllib.error
import urllib.request
from deploy import assets

ORIGIN = "https://worklens.buildwithais.com"


def verify():
    for name, expected in assets().items():
        path = "/" if name == "index.html" else "/" + name
        request = urllib.request.Request(ORIGIN + path, headers={"Cache-Control": "no-cache", "User-Agent": "WorkLens-Deployment-Check/1.0"})
        with urllib.request.urlopen(request, timeout=20) as response:
            assert response.read() == expected, f"Content mismatch: {path}"
            assert response.headers["X-WorkLens-Release"] == os.environ["SITE_REVISION"]
            assert response.headers["X-Content-Type-Options"] == "nosniff"
    try:
        urllib.request.urlopen(urllib.request.Request(ORIGIN + "/missing-deployment-check", headers={"User-Agent": "WorkLens-Deployment-Check/1.0"}), timeout=20)
    except urllib.error.HTTPError as error:
        assert error.code == 404
        assert error.read() == assets()["404.html"]
    else:
        raise AssertionError("Missing path must return 404")


if __name__ == "__main__":
    for attempt in range(6):
        try:
            verify()
            print("Live HTTPS content, release, headers and 404 verified")
            break
        except Exception as error:
            if attempt == 5:
                raise
            print(f"Verification attempt {attempt + 1} failed: {error}; retrying", flush=True)
            time.sleep(10)
