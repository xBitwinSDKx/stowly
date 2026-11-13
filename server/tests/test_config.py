from pathlib import Path

import pytest

from stowly.config import DEV_PASSWORD, Settings


def test_defaults_point_into_the_checkout_not_the_working_directory():
    settings = Settings.from_env({}, dev=False)
    repo = Path(__file__).resolve().parents[2]
    assert settings.host == "127.0.0.1"
    assert settings.port == 8010
    assert settings.data_dir == repo / "data"
    assert settings.web_dir == repo / "web" / "dist"
    assert settings.database_path == repo / "data" / "stowly.sqlite3"
    assert settings.password is None
    assert settings.configured is False
    assert settings.off_enabled is True
    assert settings.off_contact is None


def test_environment_overrides_everything():
    settings = Settings.from_env(
        {
            "STOWLY_HOST": "0.0.0.0",
            "STOWLY_PORT": "9000",
            "STOWLY_DATA_DIR": "/data",
            "STOWLY_WEB_DIR": "/app/web",
            "STOWLY_PASSWORD": " geheim ",
            "STOWLY_OFF_ENABLED": "nein",
            "STOWLY_OFF_URL": "http://127.0.0.1:1/",
            "STOWLY_LOG_LEVEL": "WARNING",
        }
    )
    assert settings.host == "0.0.0.0"
    assert settings.port == 9000
    assert settings.data_dir == Path("/data")
    assert settings.web_dir == Path("/app/web")
    assert settings.password == "geheim"
    assert settings.configured is True
    assert settings.dev is False
    assert settings.off_enabled is False
    assert settings.off_url == "http://127.0.0.1:1"
    assert settings.log_level == "warning"


def test_dev_mode_supplies_a_password_only_if_none_is_set():
    assert Settings.from_env({}, dev=True).password == DEV_PASSWORD
    assert Settings.from_env({"STOWLY_DEV": "1"}).password == DEV_PASSWORD
    assert Settings.from_env({"STOWLY_PASSWORD": "eigenes"}, dev=True).password == "eigenes"
    assert Settings.from_env({"STOWLY_PASSWORD": "   "}, dev=False).password is None


@pytest.mark.parametrize(
    "env", [{"STOWLY_PORT": "achtzig"}, {"STOWLY_DEV": "vielleicht"}, {"STOWLY_OFF_ENABLED": "2"}]
)
def test_invalid_values_are_reported(env):
    with pytest.raises(ValueError, match="STOWLY_"):
        Settings.from_env(env)
