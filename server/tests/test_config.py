from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pyrage
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from stowly.__main__ import main
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
    assert settings.env_password is None and settings.password_fallback is False
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
    assert settings.env_password == "geheim"  # wird beim Start als Hash übernommen
    assert settings.dev is False
    assert settings.off_enabled is False
    assert settings.off_url == "http://127.0.0.1:1"
    assert settings.log_level == "warning"


def test_dev_mode_supplies_a_password_only_if_none_is_set():
    assert Settings.from_env({}, dev=True).password == DEV_PASSWORD
    assert Settings.from_env({"STOWLY_DEV": "1"}).password == DEV_PASSWORD
    assert Settings.from_env({"STOWLY_PASSWORD": "eigenes"}, dev=True).password == "eigenes"
    assert Settings.from_env({"STOWLY_PASSWORD": "   "}, dev=False).password is None
    # Der Rückfall gilt wie ein Passwort aus der Umgebung, wird aber nie als Hash übernommen.
    fallback = Settings.from_env({}, dev=True)
    assert fallback.password_fallback is True and fallback.env_password is None
    own = Settings.from_env({"STOWLY_PASSWORD": "eigenes"}, dev=True)
    assert own.password_fallback is False and own.env_password == "eigenes"


@pytest.mark.parametrize(
    "env",
    [
        {"STOWLY_PORT": "achtzig"},
        {"STOWLY_DEV": "vielleicht"},
        {"STOWLY_OFF_ENABLED": "2"},
        {"STOWLY_LOG_LEVEL": "laut"},
    ],
)
def test_invalid_values_are_reported(env):
    with pytest.raises(ValueError, match="STOWLY_"):
        Settings.from_env(env)


def test_open_food_facts_settings():
    settings = Settings.from_env({"STOWLY_OFF_CONTACT": " betreiber@example.org ", "STOWLY_OFF_URL": ""})
    assert settings.off_contact == "betreiber@example.org"
    assert settings.off_url == "https://world.openfoodfacts.org"  # leer heißt: Vorgabe
    assert Settings.from_env({"STOWLY_LOG_LEVEL": "Trace"}).log_level == "trace"


# --- Stufe 2: Zeitzone, Sicherung, Home Assistant, Sensor, Push (docs/integrationen.md, 7) -------


def age_key() -> str:
    return str(pyrage.x25519.Identity.generate().to_public())


def ca_file(path: Path) -> Path:
    """Eine kleine, selbst signierte Zertifizierungsstelle als PEM-Datei."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Stowly Test-CA")])
    now = datetime.now(UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    return path


def test_stage_2_defaults():
    settings = Settings.from_env({}, dev=False)
    assert settings.timezone == "Europe/Berlin"
    assert settings.tz == ZoneInfo("Europe/Berlin")
    assert (settings.backup_dir, settings.backup_recipients, settings.backup_time) == (None, (), "03:30")
    assert settings.backup_configured is False and settings.backup_problem is None
    assert settings.backup_mentioned is False
    assert (settings.ha_url, settings.ha_token, settings.ha_todo_entity, settings.ha_ca) == (None,) * 4
    assert settings.ha_configured is False and settings.ha_problem is None
    assert settings.ha_summary_token is None
    assert settings.push_contact is None and settings.push_configured is False


@pytest.mark.parametrize("name", ["UTC", "Europe/Berlin", "America/New_York", "Pacific/Kiritimati"])
def test_known_timezones(name):
    assert Settings.from_env({"STOWLY_TIMEZONE": f" {name} "}).timezone == name


@pytest.mark.parametrize(
    "name", ["Mars/Olympus", "europe/berlin", "Europe", "../etc/passwd", "Europe/Berlin/x"]
)
def test_unknown_timezones_are_a_configuration_error(name):
    with pytest.raises(ValueError, match="STOWLY_TIMEZONE"):
        Settings.from_env({"STOWLY_TIMEZONE": name})


def test_backup_settings(tmp_path):
    first, second = age_key(), age_key()
    settings = Settings.from_env(
        {
            "STOWLY_BACKUP_DIR": str(tmp_path),
            "STOWLY_BACKUP_RECIPIENTS": f" {first},\n{second} , {first} ",
            "STOWLY_BACKUP_TIME": "23:59",
        }
    )
    assert settings.backup_dir == tmp_path
    assert settings.backup_recipients == (first, second)  # ohne Doppelte, in ihrer Reihenfolge
    assert settings.backup_time == "23:59"
    assert settings.backup_configured is True and settings.backup_problem is None


def test_half_a_backup_setup_is_reported_not_refused(tmp_path):
    only_dir = Settings.from_env({"STOWLY_BACKUP_DIR": str(tmp_path)})
    assert only_dir.backup_configured is False
    assert only_dir.backup_problem == "STOWLY_BACKUP_RECIPIENTS fehlt."
    only_keys = Settings.from_env({"STOWLY_BACKUP_RECIPIENTS": age_key()})
    assert only_keys.backup_problem == "STOWLY_BACKUP_DIR fehlt."
    assert only_keys.backup_mentioned is True
    only_time = Settings.from_env({"STOWLY_BACKUP_TIME": "04:00"})
    assert only_time.backup_problem is None and only_time.backup_mentioned is False


@pytest.mark.parametrize("directory", ["backups", "./backups", "data/backups"])
def test_the_backup_directory_must_be_absolute(directory):
    with pytest.raises(ValueError, match="STOWLY_BACKUP_DIR"):
        Settings.from_env({"STOWLY_BACKUP_DIR": directory})


@pytest.mark.parametrize("time", ["3:30", "24:00", "03:30:00", "03.30", "0330", "٣:٣٠"])
def test_the_backup_time_must_be_hh_mm(time):
    with pytest.raises(ValueError, match="STOWLY_BACKUP_TIME"):
        Settings.from_env({"STOWLY_BACKUP_TIME": time})


def test_recipients_must_be_public_age_keys_and_the_message_never_quotes_them():
    good = age_key()
    with pytest.raises(ValueError, match="Eintrag 2 ist kein öffentlicher age-Schlüssel") as error:
        Settings.from_env({"STOWLY_BACKUP_RECIPIENTS": f"{good} age1kaputt"})
    assert "age1kaputt" not in str(error.value)
    with pytest.raises(ValueError, match="STOWLY_BACKUP_RECIPIENTS"):
        Settings.from_env({"STOWLY_BACKUP_RECIPIENTS": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA"})

    secret = str(pyrage.x25519.Identity.generate())
    with pytest.raises(ValueError, match="Eintrag 1 ist ein privater Schlüssel") as error:
        Settings.from_env({"STOWLY_BACKUP_RECIPIENTS": secret})
    assert secret not in str(error.value) and secret[15:] not in str(error.value)


def test_home_assistant_settings(tmp_path):
    ca = ca_file(tmp_path / "ca.pem")
    settings = Settings.from_env(
        {
            "STOWLY_HA_URL": "https://192.168.1.20:8123/",
            "STOWLY_HA_TOKEN": " ein-langer-token ",
            "STOWLY_HA_TODO_ENTITY": "todo.einkaufsliste",
            "STOWLY_HA_CA": str(ca),
            "STOWLY_HA_SUMMARY_TOKEN": "a" * 32,
        }
    )
    assert settings.ha_url == "https://192.168.1.20:8123"  # ein / am Ende fällt weg
    assert settings.ha_token == "ein-langer-token"
    assert settings.ha_todo_entity == "todo.einkaufsliste"
    assert settings.ha_ca == ca
    assert settings.ha_configured is True and settings.ha_problem is None
    assert settings.ha_summary_token == "a" * 32
    assert Settings.from_env({"STOWLY_HA_URL": "http://ha.example"}).ha_url == "http://ha.example"
    assert Settings.from_env({"STOWLY_HA_URL": "http://[fd00::20]:8123"}).ha_url == "http://[fd00::20]:8123"


def test_half_a_home_assistant_setup_names_what_is_missing(tmp_path):
    def problem(**env: str) -> str | None:
        return Settings.from_env({f"STOWLY_HA_{key.upper()}": value for key, value in env.items()}).ha_problem

    assert problem(url="http://ha.example:8123") == "STOWLY_HA_TOKEN und STOWLY_HA_TODO_ENTITY fehlen."
    assert problem(token="…") == "STOWLY_HA_URL und STOWLY_HA_TODO_ENTITY fehlen."
    assert problem(url="http://ha.example", token="…") == "STOWLY_HA_TODO_ENTITY fehlt."
    assert problem(ca=str(ca_file(tmp_path / "ca.pem"))) == (
        "STOWLY_HA_URL, STOWLY_HA_TOKEN und STOWLY_HA_TODO_ENTITY fehlen."
    )
    # Der Sensor allein ist kein halber Abgleich.
    assert problem(summary_token="b" * 40) is None


@pytest.mark.parametrize(
    "url",
    [
        "192.168.1.20:8123",
        "ftp://ha.example",
        "http://ha.example/api",
        "http://ha.example?x=1",
        "http://ha.example#top",
        "http://benutzer:geheim@ha.example",
        "http://",
        "http://ha.example:99999",
        "http://ha.example:0",
        "http://ha example",
    ],
)
def test_invalid_home_assistant_addresses(url):
    with pytest.raises(ValueError, match="STOWLY_HA_URL") as error:
        Settings.from_env({"STOWLY_HA_URL": url})
    assert "geheim" not in str(error.value)


@pytest.mark.parametrize(
    "entity", ["todo.Einkauf", "sensor.einkauf", "todo.", "todo.einkauf liste", "einkauf"]
)
def test_invalid_todo_entities(entity):
    with pytest.raises(ValueError, match="STOWLY_HA_TODO_ENTITY"):
        Settings.from_env({"STOWLY_HA_TODO_ENTITY": entity})


def test_the_ca_must_be_a_readable_pem_file(tmp_path):
    with pytest.raises(ValueError, match="STOWLY_HA_CA: Die Datei .* lässt sich nicht lesen"):
        Settings.from_env({"STOWLY_HA_CA": str(tmp_path / "fehlt.pem")})
    with pytest.raises(ValueError, match="STOWLY_HA_CA"):
        Settings.from_env({"STOWLY_HA_CA": str(tmp_path)})  # ein Ordner
    garbage = tmp_path / "kaputt.pem"
    garbage.write_text("kein Zertifikat", encoding="utf-8")
    with pytest.raises(ValueError, match="kein Zertifikat im Format PEM"):
        Settings.from_env({"STOWLY_HA_CA": str(garbage)})


def test_the_summary_token_needs_32_plain_characters_and_is_never_quoted():
    short = "kurz-und-geheim"
    with pytest.raises(ValueError, match="mindestens 32 Zeichen") as error:
        Settings.from_env({"STOWLY_HA_SUMMARY_TOKEN": short})
    assert short not in str(error.value)
    spaced = "geheim " * 6
    with pytest.raises(ValueError, match="ohne Leerraum") as error:
        Settings.from_env({"STOWLY_HA_SUMMARY_TOKEN": spaced})
    assert "geheim" not in str(error.value)


@pytest.mark.parametrize("contact", ["mailto:betrieb@example.org", "https://stowly.example/kontakt"])
def test_push_contacts(contact):
    settings = Settings.from_env({"STOWLY_PUSH_CONTACT": contact})
    assert settings.push_contact == contact and settings.push_configured is True


@pytest.mark.parametrize(
    "contact",
    [
        "betrieb@example.org",
        "mailto:",
        "mailto:betrieb",
        "mailto:betrieb@example",
        "mailto:a b@example.org",
        "http://example.org",
        "https://",
        "https://benutzer:geheim@example.org",
        "MAILTO:betrieb@example.org",
    ],
)
def test_invalid_push_contacts(contact):
    with pytest.raises(ValueError, match="STOWLY_PUSH_CONTACT") as error:
        Settings.from_env({"STOWLY_PUSH_CONTACT": contact})
    assert "geheim" not in str(error.value)


@pytest.mark.parametrize(
    "repo",
    [
        "beispiel/stowly",
        "Beispiel-Konto/stowly.app_2",
        "a/b",
        "a" * 39 + "/stowly",
        "beispiel/" + "n" * 100,
        "beispiel/.github",
        "beispiel/...",
        "beispiel/stowly.git",
    ],
)
def test_update_repositories(repo, tmp_path):
    settings = Settings.from_env({"STOWLY_UPDATE_REPO": f" {repo} ", "STOWLY_DATA_DIR": str(tmp_path)})
    assert settings.update_repo == repo and settings.update_configured is True
    assert settings.update_dir == tmp_path / "update"


@pytest.mark.parametrize("value", [None, "", "   "])
def test_an_empty_update_repository_means_no_updates(value):
    env = {} if value is None else {"STOWLY_UPDATE_REPO": value}
    settings = Settings.from_env(env)
    assert settings.update_repo is None and settings.update_configured is False


@pytest.mark.parametrize(
    "repo",
    [
        "stowly",
        "/stowly",
        "beispiel/",
        "beispiel//stowly",
        "beispiel/stowly/releases",
        "-beispiel/stowly",
        "bei_spiel/stowly",
        "bei.spiel/stowly",
        "bei spiel/stowly",
        "beispiel/sto wly",
        "beispiel/stöwly",
        "beispiel/sto\nwly",
        "beispiel\\stowly",
        "a" * 40 + "/stowly",
        "beispiel/" + "n" * 101,
        "https://github.com/beispiel/stowly",
        "github.com/beispiel/stowly",
        "beispiel/.",
        "beispiel/..",
    ],
)
def test_invalid_update_repositories(repo):
    with pytest.raises(ValueError, match="STOWLY_UPDATE_REPO"):
        Settings.from_env({"STOWLY_UPDATE_REPO": repo})


def test_an_invalid_update_repository_ends_the_start_with_exit_code_2(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("STOWLY_DATA_DIR", str(tmp_path / "daten"))
    monkeypatch.setenv("STOWLY_UPDATE_REPO", "https://github.com/beispiel/stowly")
    assert main([]) == 2
    assert "Konfigurationsfehler: STOWLY_UPDATE_REPO" in capsys.readouterr().err
    assert not (tmp_path / "daten").exists()  # nichts angelegt, auch kein Ordner für Updates


def test_secrets_never_appear_in_the_representation():
    settings = Settings.from_env(
        {
            "STOWLY_PASSWORD": "haushalts-passwort",
            "STOWLY_HA_TOKEN": "ha-token-geheim",
            "STOWLY_HA_SUMMARY_TOKEN": "s" * 40,
        }
    )
    text = repr(settings)
    assert "haushalts-passwort" not in text and "ha-token-geheim" not in text and "s" * 40 not in text


def test_a_configuration_error_ends_the_start_with_exit_code_2(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("STOWLY_DATA_DIR", str(tmp_path / "daten"))
    monkeypatch.setenv("STOWLY_HA_SUMMARY_TOKEN", "zu-kurzes-geheimnis")
    assert main([]) == 2
    error = capsys.readouterr().err
    assert "Konfigurationsfehler: STOWLY_HA_SUMMARY_TOKEN" in error
    assert "zu-kurzes-geheimnis" not in error
    assert not (tmp_path / "daten").exists()  # nichts angelegt

    monkeypatch.delenv("STOWLY_HA_SUMMARY_TOKEN")
    monkeypatch.setenv("STOWLY_TIMEZONE", "Mars/Olympus")
    assert main([]) == 2
    assert "STOWLY_TIMEZONE" in capsys.readouterr().err
