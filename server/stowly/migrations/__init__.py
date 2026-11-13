"""Nummerierte SQL-Migrationen (``NNNN_name.sql``), angewendet von ``stowly.db.migrate``.

Eine Migration enthält kein eigenes BEGIN/COMMIT: ``migrate`` führt jede Datei in
einer Transaktion aus und setzt danach ``PRAGMA user_version``.
"""
