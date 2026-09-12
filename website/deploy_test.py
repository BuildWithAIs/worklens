import io
import unittest
from deploy import deploy


class Storage:
    class exceptions:
        class NoSuchKey(Exception):
            pass

    def __init__(self, corrupt=False):
        self.objects = {"current.json": b"previous release"}
        self.corrupt = corrupt

    def list_objects_v2(self, **kwargs):
        return {"KeyCount": 0}

    def put_object(self, **kwargs):
        self.objects[kwargs["Key"]] = kwargs["Body"]

    def get_object(self, **kwargs):
        if kwargs["Key"] not in self.objects:
            raise self.exceptions.NoSuchKey()
        return {"Body": io.BytesIO(b"corrupt" if self.corrupt else self.objects[kwargs["Key"]])}


class DeploymentTest(unittest.TestCase):
    def test_failed_verification_keeps_live_release(self):
        store = Storage(corrupt=True)
        with self.assertRaises(ValueError):
            deploy(store, "a" * 40, {"index.html": b"new"})
        self.assertEqual(store.objects["current.json"], b"previous release")

    def test_success_activates_verified_release(self):
        store = Storage()
        deploy(store, "a" * 40, {"index.html": b"new"})
        self.assertIn(b'"revision": "' + b"a" * 40, store.objects["current.json"])

    def test_invalid_revision_leaves_storage_unchanged(self):
        store = Storage()
        with self.assertRaises(ValueError):
            deploy(store, "../other", {"index.html": b"new"})
        self.assertEqual(store.objects, {"current.json": b"previous release"})

    def test_partial_upload_can_resume(self):
        store = Storage()
        store.objects["releases/" + "a" * 40 + "/index.html"] = b"new"
        deploy(store, "a" * 40, {"index.html": b"new", "404.html": b"missing"})
        self.assertIn("releases/" + "a" * 40 + "/404.html", store.objects)

    def test_conflicting_release_keeps_previous_live(self):
        store = Storage()
        store.objects["releases/" + "a" * 40 + "/index.html"] = b"old"
        with self.assertRaises(ValueError):
            deploy(store, "a" * 40, {"index.html": b"new"})
        self.assertEqual(store.objects["current.json"], b"previous release")


if __name__ == "__main__":
    unittest.main()
