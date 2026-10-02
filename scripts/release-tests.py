"""Check the Zotero installation regression without installing or calling models.

Input: real project manifest and publication guard, resolved relative to this file.
Output: unittest pass/fail status. Dependencies: Python standard library only.
Negative cases exercise missing installation fields and insecure update addresses.
"""
import copy
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/export-release.py"
namespace = {"__name__": "release_guard_tests", "__file__": str(SCRIPT)}
exec(compile(SCRIPT.read_text(encoding="utf-8"), str(SCRIPT), "exec"), namespace)
validate = namespace["validate_install_manifest"]
validate_updates = namespace["validate_update_manifest"]


class InstallationManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / "src/manifest.json").read_text(encoding="utf-8"))

    def test_current_manifest_meets_required_https_install_policy(self):
        validate(self.manifest)

    def test_explicit_https_address_is_not_replaced(self):
        candidate = copy.deepcopy(self.manifest)
        url = namespace["SELECTED_UPDATE_URL"]
        candidate["applications"]["zotero"]["update_url"] = url
        validate(candidate)
        self.assertEqual(candidate["applications"]["zotero"]["update_url"], url)

    def test_required_fields_missing_or_empty_fail(self):
        for field in ("id", "update_url", "strict_max_version"):
            for value in (None, "", "   "):
                with self.subTest(field=field, value=value):
                    candidate = copy.deepcopy(self.manifest)
                    if value is None:
                        candidate["applications"]["zotero"].pop(field, None)
                    else:
                        candidate["applications"]["zotero"][field] = value
                    with self.assertRaisesRegex(ValueError, "installation field"):
                        validate(candidate)

    def test_insecure_or_malformed_updates_fail(self):
        for url in ("http://example.org/update-manifest.json", "data:application/json,%7B%7D",
                    "https://", "HTTPS://example.org/update-manifest.json",
                    "https://user:secret@example.org/update-manifest.json"):
            with self.subTest(url=url):
                candidate = copy.deepcopy(self.manifest)
                candidate["applications"]["zotero"]["update_url"] = url
                with self.assertRaisesRegex(ValueError, "selected HTTPS"):
                    validate(candidate)

    def test_root_update_url_cannot_override_application_policy(self):
        candidate = copy.deepcopy(self.manifest)
        candidate["update_url"] = "https://example.invalid/updates.json"
        with self.assertRaisesRegex(ValueError, "selected HTTPS"):
            validate(candidate)

    def test_current_update_file_has_correct_plugin_and_no_candidates(self):
        data = json.loads((ROOT / "updates.json").read_text(encoding="utf-8"))
        validate_updates(data, self.manifest["applications"]["zotero"]["id"])

    def test_wrong_plugin_or_nonempty_candidates_fail(self):
        plugin_id = self.manifest["applications"]["zotero"]["id"]
        for data in ({"addons": {}}, {"addons": {"wrong@test": {"updates": []}}},
                     {"addons": {plugin_id: {"updates": [{"version": "99.0"}]}}}):
            with self.subTest(data=data):
                with self.assertRaisesRegex(ValueError, "no update candidates"):
                    validate_updates(data, plugin_id)


if __name__ == "__main__":
    unittest.main(verbosity=2)
